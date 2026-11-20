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
      item: { ...post, url: "https://pub.example.com/p/weather", title: "Weather" },
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
    const claims = await stages.claims(input, themes);
    const requests = await stages.planResearch(themes, claims);
    expect(requests).toHaveLength(1);
    // The treaty request finishes; nothing else is pinned, so any other claim stays a gap.
    const job = await stages.research(requests[0]);
    const pinned: PinnedResearch[] = [
      { jobId: researchJobId(requests[0]), request: requests[0], outcome: "finished", job },
    ];
    const coverage = await stages.coverage(themes, claims, pinned);
    const pkg = await stages.package(coverage);
    expect(pkg.status).toBe("ready");
    const packageJson = JSON.parse(await content.read(pkg.ref));
    expect(packageJson.claims.map((c: { status: string }) => c.status).sort()).toEqual([
      "covered",
      "gap",
    ]);
    const draft = await stages.draft(pkg.ref, input.sourceUrl);
    expect(draft.ref).toBeDefined();
    const md = await content.read(draft.ref!);
    expect(md).toContain("**Supported by the evidence.**");
    expect(md).toContain("**Unresolved.**");
    expect(await stages.verify(draft.ref!, pkg.ref)).toMatchObject({
      approved: false,
      unavailable: expect.stringContaining("#150"),
    });

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
