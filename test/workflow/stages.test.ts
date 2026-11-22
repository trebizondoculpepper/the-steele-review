import { articlePaths } from "../../src/drafting/article-identity.js";
import { ARTICLE_APPROVED_SUBJECT } from "../../src/events/article-approved-event.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { collectionArtifactPath } from "../../src/collection/collection-store.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { researchJobId } from "../../src/research/job.js";
import { LexicalShortlister } from "../../src/research/librarian.js";
import type { PinnedResearch } from "../../src/workflow/article-run.js";
import { articleStages } from "../../src/workflow/stages.js";

/**
 * The real stage wiring for #243, run in order with fixture models and
 * fixture research (no Restate, no network): one claim is supported, one is a
 * genuine research gap because its job timed out at the deadline.
 */

const TEXT =
  "A treaty bans hostile weather modification. A payment of 56 million funded an attack.";
const post = { publicationId: "pub", postId: "weather" };
const TREATY = "https://treaties.un.org/enmod";

let dir: string;
let archive: GitArtifactStore;
let content: GitArtifactStore;
let operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-stages-"));
  await mkdir(join(dir, "a"));
  await mkdir(join(dir, "c"));
  archive = new GitArtifactStore({ repoPath: join(dir, "a"), repository: "archive" });
  content = new GitArtifactStore({ repoPath: join(dir, "c"), repository: "content" });
  await archive.initialise();
  await content.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
  await archive.write(
    collectionArtifactPath(post),
    JSON.stringify({
      item: {
        ...post,
        url: "https://pub.example.com/p/weather",
        title: "Weather",
        author: "Dr Synthetic",
      },
      ingestionReason: "backfill",
      text: TEXT,
      complete: true,
      supplied: {},
      provenance: {
        sourceUrl: "https://pub.example.com/p/weather",
        acquiredAt: "2026-01-01T00:00:00.000Z",
        method: "article-html",
      },
    }),
  );
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

const claim = (statement: string, passage: string, themeIds: string[]) => ({
  statement,
  passage,
  claimType: "factual",
  kind: "assertion",
  qualifiers: [],
  entities: [],
  dates: [],
  speaker: { kind: "author-voice" },
  themeIds,
});

/** One fake provider answering each stage by recognising its prompt. */
const provider = {
  modelVersion: "fake/stage-model",
  complete: async (req: { system: string; user: string }) => {
    const isWriter = /"summary"/.test(req.system);
    if (!isWriter && /theme/i.test(req.system) && /"themes"/.test(req.system)) {
      return JSON.stringify({
        themes: [{ title: "Weather warfare", description: "Weather modification as a weapon" }],
      });
    }
    if (!isWriter && /claims/i.test(req.system) && /passage/i.test(req.system)) {
      const id = /"id":"(theme-[0-9a-f]+)"/.exec(req.user)?.[1] ?? "x";
      return JSON.stringify({
        claims: [
          claim(
            "A treaty bans hostile weather modification",
            "A treaty bans hostile weather modification.",
            [id],
          ),
          claim(
            "A payment of 56 million funded an attack",
            "A payment of 56 million funded an attack.",
            [id],
          ),
        ],
      });
    }
    // Writer: respond to the claims it was given.
    const claims = [
      ...req.user.matchAll(/"claimRecordId":"(claim-[0-9a-f]+)"[^}]*?"status":"(covered|gap)"/g),
    ];
    return JSON.stringify({
      title: "A treaty already bans weather weapons",
      subtitle: "What the post claims, and what the evidence shows",
      excerpt:
        "The post says a treaty bans weather weapons; it does, but the payment claim is unsupported.",
      summary: "The post claims a treaty bans weather weapons and that a payment funded an attack.",
      themes: ["Weather warfare"],
      responses: claims.map(([, id, status]) =>
        status === "covered"
          ? {
              claimRecordId: id,
              verdict: "supported",
              text: "The ENMOD Convention prohibits this.",
              evidence: [0],
            }
          : {
              claimRecordId: id,
              verdict: "unresolved",
              text: "No record of this payment was found.",
              evidence: [],
            },
      ),
      limitations: [],
      narrative: { status: "limited", limitation: "No earlier posts were compared." },
      widerContext: { status: "limited", limitation: "No background used." },
    });
  },
};

describe("article stages composed (#243)", () => {
  it("runs from a captured post to a cited draft, with a timed-out research job kept as a gap", async () => {
    const stages = articleStages({
      archive,
      content,
      operations,
      models: { themes: provider, claims: provider, writer: provider },
      shortlister: new LexicalShortlister(),
      research: {
        sonar: {
          model: "fixture",
          research: async () => ({
            report: "Article I prohibits it.",
            citations: [TREATY],
            model: "fixture",
          }),
        },
        fetcher: {
          fetch: async (url) => ({
            url,
            title: "ENMOD",
            text: "Article I. Each State Party undertakes not to engage in military or any other hostile use of environmental modification techniques.",
          }),
        },
        judge: {
          judge: async ({ findings }) => ({
            passages: findings
              .filter((f) => /treaty/i.test(f.statement))
              .map((f) => ({
                findingId: f.id,
                passage: "not to engage in military or any other hostile use",
              })),
            sourceType: "treaty",
          }),
        },
      },
      owner: "test",
    });
    const input = {
      ...post,
      sourceVersion: sourceVersionFor(TEXT),
      sourceUrl: "https://pub.example.com/p/weather",
      researchDeadlineMs: 1_000,
    };
    const themes = await stages.themes(input);
    // Started from a captured-content event (#270): the exact archived artifact
    // is read, and an altered or unknown reference fails permanently.
    const captured = await archive.lookup(collectionArtifactPath(post));
    const viaEvent = {
      ...input,
      source: {
        namespace: `substack/${post.publicationId}`,
        itemId: post.postId,
        artifact: captured!,
      },
    };
    expect(await stages.themes(viaEvent)).toMatchObject({ path: themes.path });
    await expect(
      stages.themes({
        ...viaEvent,
        source: { ...viaEvent.source, artifact: { ...captured!, sha256: "0".repeat(64) } },
      }),
    ).rejects.toThrow(/capture-unavailable/);
    // A valid capture of another post must not be analysed under this identity.
    await expect(stages.themes({ ...viaEvent, postId: "other-post" })).rejects.toThrow(
      /capture-identity-mismatch/,
    );
    const claims = await stages.claims(input, themes);
    const savedClaims = JSON.parse(await content.read(claims));
    expect(savedClaims.claims[0].occurrence.publisher.author).toBe("Dr Synthetic");
    const requests = await stages.planResearch(themes, claims);
    expect(requests).toHaveLength(1);
    // #747: with zero commissioned research no claim is supported, and the
    // package says so, but it still reaches the real writer boundary.
    const unsupported = await stages.package(await stages.coverage(themes, claims, []));
    expect(unsupported.status).toBe("evidence-gap");
    const unsupportedPackage = JSON.parse(await content.read(unsupported.ref));
    expect(
      unsupportedPackage.claims.every((c: { status: string }) => c.status !== "covered"),
    ).toBe(true);
    const zeroSupportDraft = await stages.draft(unsupported.ref, input.sourceUrl);
    expect(zeroSupportDraft.failure).toBeUndefined();
    expect(zeroSupportDraft.ref).toBeDefined();
    expect(await content.read(zeroSupportDraft.ref!)).toMatch(
      /<!-- claim-verdict [a-f0-9]+ unresolved -->/,
    );
    // The treaty request finishes; nothing else is pinned, so any other claim stays a gap.
    const job = await stages.research(requests[0]);
    const pinned: PinnedResearch[] = [
      { jobId: researchJobId(requests[0]), request: requests[0], outcome: "finished", job },
    ];
    const coverage = await stages.coverage(themes, claims, pinned);
    // #597: the follow-up plan names targeted second-pass requests that
    // follow the first job, and planning dispatches nothing itself.
    const researchedBefore = (await content.list("research-jobs", 1000)).length;
    const followUps = await stages.planFollowUp!(themes, claims, pinned);
    expect(followUps.length).toBeGreaterThan(0);
    for (const f of followUps) {
      expect(f).toMatchObject({ pass: 2, previousJobId: researchJobId(requests[0]) });
    }
    expect(await stages.planFollowUp!(themes, claims, pinned)).toEqual(followUps);
    expect((await content.list("research-jobs", 1000)).length).toBe(researchedBefore);
    // A follow-up that failed is reassessed as an explicit gap, never support.
    const reassessed = await stages.coverage(
      themes,
      claims,
      [
        ...pinned,
        ...followUps.map((f) => ({
          jobId: researchJobId(f),
          request: f,
          outcome: "failed" as const,
        })),
      ],
      { followUp: true },
    );
    const after = JSON.parse(await content.read(reassessed));
    expect(after.jobs.map((j: { pass: number }) => j.pass).sort()).toEqual([1, 2]);
    expect(
      after.claims.filter((c: { status: string }) => c.status === "evidence-found").length,
    ).toBe(
      JSON.parse(await content.read(coverage)).claims.filter(
        (c: { status: string }) => c.status === "evidence-found",
      ).length,
    );
    const pkg = await stages.package(coverage);
    expect(pkg.status).toBe("ready");
    const packageJson = JSON.parse(await content.read(pkg.ref));
    expect(packageJson.claims.map((c: { status: string }) => c.status).sort()).toEqual([
      "covered",
      "gap",
    ]);
    // The package pins the archived capture's URL (#276); a different one is refused.
    expect(packageJson.source.originalUrl).toBe(input.sourceUrl);
    expect(await stages.draft(pkg.ref, "https://elsewhere.example.com/p/x")).toEqual({
      failure: "source-url-mismatch",
    });
    const draft = await stages.draft(pkg.ref, input.sourceUrl);
    expect(draft.ref).toBeDefined();
    const md = await content.read(draft.ref!);
    expect(md).toMatch(/<!-- claim-verdict [a-f0-9]+ supported -->/);
    expect(md).toMatch(/<!-- claim-verdict [a-f0-9]+ unresolved -->/);
    expect(await stages.verify(draft.ref!, pkg.ref, input.sourceUrl)).toMatchObject({
      approved: false,
      unavailable: expect.stringContaining("no verifier"),
    });
    // With the independent verifier stage configured (#150), the run is approved.
    const verifying = articleStages({
      archive,
      content,
      operations,
      models: {
        themes: provider,
        claims: provider,
        writer: provider,
        verifier: {
          modelVersion: "fake/verifier",
          complete: async () => JSON.stringify({ verdict: "approved", issues: [] }),
        },
      },
      shortlister: new LexicalShortlister(),
      research: {
        sonar: { model: "x", research: async () => ({ report: "r", citations: [], model: "x" }) },
        fetcher: {
          fetch: async () => {
            throw new Error("unused");
          },
        },
      },
      owner: "test",
    });
    const approved = await verifying.verify(draft.ref!, pkg.ref, input.sourceUrl);
    expect(approved).toMatchObject({ approved: true, draft: { path: draft.ref!.path } });
    // Assess a canonical v1 snapshot even after current metadata alone advances
    // to v2. Verification may not roll current paths back to the old version.
    const canonical = articlePaths(post);
    const canonicalBody = (await content.lookup(canonical.body))!;
    const canonicalMeta = (await content.lookup(canonical.metadata))!;
    const metaV1 = JSON.parse(await content.read(canonicalMeta));
    const metaV2 = await content.revise(
      canonical.metadata,
      JSON.stringify({ ...metaV1, fields: { ...metaV1.fields, title: "New unapproved metadata" } }),
      canonicalMeta.sha256,
    );
    const pinnedApproval = await verifying.verify(canonicalBody, pkg.ref, input.sourceUrl);
    expect(pinnedApproval).toMatchObject({
      approved: true,
      draft: { path: canonical.body, commit: canonicalBody.commit },
    });
    const pinnedReport = JSON.parse(await content.read(pinnedApproval.ref!));
    const pinnedManifest = JSON.parse(
      await content.read({
        ...pinnedReport.publication,
        sha256: pinnedReport.publication.hash.slice(7),
      }),
    );
    expect(pinnedManifest.metadata).toMatchObject({
      path: canonical.metadata,
      commit: canonicalBody.commit,
    });
    expect(pinnedManifest.fields.title).toBe(metaV1.fields.title);
    expect((await content.lookup(canonical.metadata))!.sha256).toBe(metaV2.sha256);
    // The approval is handed to publishing as one approved-article event (#262).
    const handoff = await verifying.approve!(approved.ref!);
    expect(await verifying.approve!(approved.ref!)).toEqual(handoff);
    expect(operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT).map((e) => e.eventId)).toEqual(
      [handoff.eventId],
    );

    // Reassessing with the job timed out: no new evidence is invented.
    const timedOut = await stages.coverage(themes, claims, [
      { jobId: researchJobId(requests[0]), request: requests[0], outcome: "timed-out" },
    ]);
    const record = JSON.parse(await content.read(timedOut));
    // The timed-out job is recorded as a failed job; claims it would have
    // covered rely only on evidence the dossier already saved, with provenance.
    expect(record.jobs.map((j: { outcome: string }) => j.outcome)).toEqual(["failed"]);
    const treaty = record.claims.find((c: { statement: string }) => /treaty/i.test(c.statement));
    expect(treaty).toMatchObject({
      status: "evidence-found",
      reused: true,
      evidenceFrom: expect.any(Object),
    });
  }, 60_000);
});
