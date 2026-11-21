import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  readPublicationPayload,
  savePublicationPayload,
  artifactReference,
} from "../../src/drafting/publication-payload.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import {
  DEFAULT_PACKAGE_DRAFT_PROMPT,
  draftFromPackage,
} from "../../src/drafting/package-draft.js";
import {
  renderPackageDraft,
  modelCitationIssues,
  modelCitationProblems,
} from "../../src/drafting/package-draft.js";
import {
  DEFAULT_PACKAGE_VERIFY_PROMPT,
  PackageVerificationReportSchema,
  approvalValidFor,
  deterministicIssues,
  verifyPackageDraft,
  verifyWithRevisions,
} from "../../src/drafting/package-verify.js";
import { saveWriterPackage, WriterPackageSchema } from "../../src/drafting/writer-package.js";
import { LexicalShortlister, assessPostCoverage } from "../../src/research/librarian.js";
import { CLAIMS, SHARED, TEXT, librarianFixtures } from "../research/librarian-fixtures.js";

let operations: OperationStore;
let dir: string;
let content: GitArtifactStore;
let fx: ReturnType<typeof librarianFixtures>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-package-verify-"));
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  fx = librarianFixtures(content);
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

const archive = {
  read: async () =>
    JSON.stringify({
      item: { publicationId: "pub", postId: "p1", url: "https://pub.example.com/p/p1", title: "T" },
      ingestionReason: "backfill",
      text: TEXT,
      complete: true,
      supplied: {},
      provenance: {
        sourceUrl: "https://pub.example.com/p/p1",
        acquiredAt: "2026-01-01T00:00:00.000Z",
        method: "article-html",
      },
    }),
} as unknown as GitArtifactStore;

const writerResponse = (
  text = "The ENMOD Convention prohibits hostile environmental modification.",
) =>
  JSON.stringify({
    title: "A treaty already bans weather weapons",
    subtitle: "What the post claims, and what the evidence shows",
    excerpt:
      "The post says a treaty bans weather weapons; it does, but the payment claim is unsupported.",
    summary: "The post says a treaty bans weather weapons and that a payment funded an attack.",
    themes: ["Weather warfare"],
    responses: [
      { claimRecordId: "claim-treaty", verdict: "supported", text, evidence: [0] },
      {
        claimRecordId: "claim-payment",
        verdict: "unresolved",
        text: "No record of this payment was found.",
        evidence: [],
      },
    ],
    limitations: [],
    narrative: { status: "limited", limitation: "No earlier posts were compared." },
    widerContext: { status: "limited", limitation: "No background used." },
  });
const model = (version: string, ...responses: string[]) => {
  let calls = 0;
  return {
    modelVersion: version,
    get calls() {
      return calls;
    },
    complete: async () => responses[Math.min(calls++, responses.length - 1)],
  };
};
const loadRevision = (user: string) => JSON.parse(user) as { revision?: unknown };

const APPROVE = JSON.stringify({
  verdict: "approved",
  issues: [{ passage: "fairly", reason: "slightly informal", severity: "minor" }],
});
const OVERSTATED = JSON.stringify({
  verdict: "redraft",
  issues: [
    {
      passage: "proves",
      reason: "the passage does not prove this; it only states the treaty's scope",
      severity: "substantive",
    },
  ],
});

async function drafted(writer = model("fake/writer", writerResponse())) {
  const a = await fx.analysis("p1", CLAIMS);
  const coverage = await assessPostCoverage({
    artifacts: content,
    ...a,
    commission: fx.researcher(() => ({
      passages: [{ claimRecordId: "claim-treaty", url: SHARED }],
    })).commission,
    shortlister: new LexicalShortlister(),
  });
  const pkg = await saveWriterPackage({ content, coverage: coverage.ref });
  const out = await draftFromPackage({
    operations,
    content,
    archive,
    package: pkg.ref,
    provider: writer,
    sourceUrl: "https://pub.example.com/p/p1",
  });
  if (out.status !== "drafted") throw new Error(out.status);
  return { pkg, ...out };
}

describe("package draft verification (#150)", { timeout: 60_000 }, () => {
  it("binds draft, redraft and verification reuse to the exact prompt wording (#430)", async () => {
    const { pkg, metadata, draft } = await drafted();
    const base = { content, archive, package: pkg.ref, sourceUrl: "https://pub.example.com/p/p1" };
    const reworded = {
      version: DEFAULT_PACKAGE_DRAFT_PROMPT.version, // same semantic version
      instructions: `${DEFAULT_PACKAGE_DRAFT_PROMPT.instructions}\nOne more sentence of guidance.`,
    };
    // First draft: unchanged wording reuses; changed wording calls the provider again.
    const same = model("fake/writer", writerResponse());
    const again = await draftFromPackage({ operations, ...base, provider: same });
    if (again.status !== "drafted") throw new Error(again.status);
    expect(same.calls).toBe(0);
    expect(again.draft.path).toBe(draft.path);
    const fresh = model("fake/writer", writerResponse());
    const redone = await draftFromPackage({
      operations,
      ...base,
      provider: fresh,
      prompt: reworded,
    });
    if (redone.status !== "drafted") throw new Error(redone.status);
    expect(fresh.calls).toBe(1);
    expect(redone.draft.path).not.toBe(draft.path);
    const meta = JSON.parse(await content.read(redone.metadata));
    expect(meta.promptVersion).toMatch(
      /^writer-package-explainer-sha256:[0-9a-f]{64}\+sha256:[0-9a-f]{16}$/,
    );

    // Redraft: the revision instructions' wording is part of its identity.
    const revision = { number: 1, feedback: [{ passage: "proves", reason: "overstated" }] };
    const r1 = model("fake/writer", writerResponse());
    const firstRedraft = await draftFromPackage({ operations, ...base, provider: r1, revision });
    const r2 = model("fake/writer", writerResponse());
    const rewordedRedraft = await draftFromPackage({
      operations,
      ...base,
      provider: r2,
      revision,
      revisionInstructions: "Revise carefully, quoting the evidence exactly.",
    });
    if (firstRedraft.status !== "drafted" || rewordedRedraft.status !== "drafted") {
      throw new Error("redraft failed");
    }
    expect(r2.calls).toBe(1);
    expect(rewordedRedraft.draft.path).not.toBe(firstRedraft.draft.path);
    const m1 = JSON.parse(await content.read(firstRedraft.metadata));
    const m2 = JSON.parse(await content.read(rewordedRedraft.metadata));
    expect(m1.revisionPromptVersion).toMatch(
      /^writer-package-revision-sha256:[0-9a-f]{64}\+sha256:[0-9a-f]{16}$/,
    );
    expect(m2.revisionPromptVersion).not.toBe(m1.revisionPromptVersion);

    // The revision writer receives the exact previous draft (#489).
    const users: string[] = [];
    const recording = {
      modelVersion: "fake/writer",
      async complete(request: { user: string }) {
        users.push(request.user);
        return writerResponse();
      },
    };
    const previous = { ref: draft, markdown: "# Previous article\n\nThe treaty bans weapons." };
    const withPrevious = await draftFromPackage({
      operations,
      ...base,
      provider: recording as never,
      revision,
      previousDraft: previous,
    });
    if (withPrevious.status !== "drafted") throw new Error(withPrevious.status);
    expect(loadRevision(users[0]!)).toMatchObject({
      revision: {
        number: 1,
        previousDraft: previous.markdown,
        previousDraftTruncated: false,
      },
    });
    // The previous draft is part of the revision's identity.
    const withoutPrevious = await draftFromPackage({
      operations,
      ...base,
      provider: model("fake/writer", writerResponse()),
      revision,
    });
    if (withoutPrevious.status !== "drafted") throw new Error(withoutPrevious.status);
    expect(withPrevious.draft.path).not.toBe(withoutPrevious.draft.path);

    // Verification: unchanged wording reuses; changed wording calls the verifier again.
    const v1 = model("fake/verifier", APPROVE);
    const first = await verifyPackageDraft({ content, archive, metadata, verifier: v1 });
    const v2 = model("fake/verifier", APPROVE);
    const reused = await verifyPackageDraft({ content, archive, metadata, verifier: v2 });
    if (first.status !== "verified" || reused.status !== "verified") throw new Error("verify");
    expect(v2.calls).toBe(0);
    expect(reused.ref.path).toBe(first.ref.path);
    const v3 = model("fake/verifier", APPROVE);
    const reverified = await verifyPackageDraft({
      content,
      archive,
      metadata,
      verifier: v3,
      prompt: {
        version: DEFAULT_PACKAGE_VERIFY_PROMPT.version,
        instructions: `${DEFAULT_PACKAGE_VERIFY_PROMPT.instructions}\nCheck dates twice.`,
      },
    });
    if (reverified.status !== "verified") throw new Error(reverified.status);
    expect(v3.calls).toBe(1);
    expect(reverified.ref.path).not.toBe(first.ref.path);
    expect(reverified.report.promptVersion).toMatch(/\+sha256:[0-9a-f]{16}$/);
  });

  it.each(["title", "subtitle", "excerpt", "body"])(
    "does not reuse approval after a %s-only change",
    async (field) => {
      const { metadata, draft } = await drafted();
      const first = await verifyPackageDraft({
        content,
        archive,
        metadata,
        verifier: model("fake/verifier", APPROVE),
      });
      if (first.status !== "verified" || first.report.schemaVersion !== 2)
        throw new Error("expected report");
      const original = await readPublicationPayload(content, first.report.publication);
      const changed = JSON.parse(await content.read(metadata));
      let body = draft;
      if (field === "body") {
        body = await content.write(
          draft.path.replace(/\.md$/, "-changed.md"),
          `${original.markdown}\nA careful qualification.\n`,
        );
        changed.draft = `${body.commit}:${body.path}`;
      } else changed.fields[field] = `Changed ${field}`;
      const revised = await content.write(
        metadata.path.replace(/\.json$/, "-changed.json"),
        JSON.stringify(changed),
      );
      const payload = await savePublicationPayload({
        content,
        metadata: revised,
        body,
        post: { publicationId: "pub", postId: "p1" },
      });
      expect(
        approvalValidFor(first.report, await content.read(body), {
          ref: artifactReference(payload.ref),
          payload: payload.payload,
        }),
      ).toBe(false);
      const checker = model("fake/verifier", APPROVE);
      const second = await verifyPackageDraft({
        content,
        archive,
        metadata: revised,
        verifier: checker,
      });
      if (second.status !== "verified") throw new Error(second.status);
      expect(checker.calls).toBe(1);
      expect(second.ref.path).not.toBe(first.ref.path);
      expect(
        approvalValidFor(first.report, original.markdown, {
          ref: first.report.publication,
          payload: original.payload,
        }),
      ).toBe(true);
      const replay = model("fake/verifier", APPROVE);
      const reused = await verifyPackageDraft({
        content,
        archive,
        metadata: revised,
        verifier: replay,
      });
      expect(reused.status).toBe("verified");
      expect(replay.calls).toBe(0);
    },
  );

  it("sends reader-visible metadata to the independent verifier and rejects unsupported metadata", async () => {
    const { metadata } = await drafted();
    const changed = JSON.parse(await content.read(metadata));
    changed.fields.title = "The treaty proves all weather control is harmless";
    const revised = await content.write(
      metadata.path.replace(/\.json$/, "-unsupported.json"),
      JSON.stringify(changed),
    );
    const out = await verifyPackageDraft({
      content,
      archive,
      metadata: revised,
      verifier: {
        modelVersion: "fake/metadata-verifier",
        complete: async (request) => {
          const input = JSON.parse(request.user);
          expect(input.publication.title).toBe(changed.fields.title);
          expect(input.publication.subtitle).toBe(changed.fields.subtitle);
          expect(input.publication.excerpt).toBe(changed.fields.excerpt);
          expect(request.system).toContain("title, subtitle and excerpt");
          expect(request.system).toContain("same distinction between fact and opinion");
          return JSON.stringify({
            verdict: "redraft",
            issues: [
              {
                passage: input.publication.title,
                reason: "The supplied treaty passage does not establish harmlessness.",
                severity: "substantive",
              },
            ],
          });
        },
      },
    });
    expect(out).toMatchObject({ status: "verified", report: { outcome: "redraft" } });
  });

  it("never extends a legacy body-only report to unseen publication fields", async () => {
    const { metadata, draft } = await drafted();
    const verified = await verifyPackageDraft({
      content,
      archive,
      metadata,
      verifier: model("fake/verifier", APPROVE),
    });
    if (verified.status !== "verified" || verified.report.schemaVersion !== 2)
      throw new Error("expected report");
    const candidate = { ...verified.report, schemaVersion: 1 } as Record<string, unknown>;
    delete candidate.publication;
    const legacy = PackageVerificationReportSchema.parse(candidate);
    const publication = {
      ref: verified.report.publication,
      ...(await readPublicationPayload(content, verified.report.publication)),
    };
    const markdown = await content.read(draft);
    expect(approvalValidFor(legacy, markdown)).toBe(true);
    expect(approvalValidFor(legacy, markdown, publication)).toBe(false);
  });

  it("approves an accurate, qualified draft, and the approval binds to the exact text", async () => {
    const { metadata, draft } = await drafted();
    const out = await verifyPackageDraft({
      content,
      archive,
      metadata,
      verifier: model("fake/verifier", APPROVE),
    });
    if (out.status !== "verified") throw new Error(out.status);
    expect(out.report).toMatchObject({ outcome: "approved", issues: [{ severity: "minor" }] });
    const md = await content.read(draft);
    if (out.report.schemaVersion !== 2) throw new Error("expected payload-aware report");
    const publication = {
      ref: out.report.publication,
      ...(await readPublicationPayload(content, out.report.publication)),
    };
    expect(approvalValidFor(out.report, md, publication)).toBe(true);
    expect(approvalValidFor(out.report, md)).toBe(false);
    if (publication.payload.mode === "structured") {
      expect(
        approvalValidFor(out.report, md, {
          ...publication,
          payload: {
            ...publication.payload,
            fields: { ...publication.payload.fields, title: "A substituted title" },
          },
        }),
      ).toBe(false);
    }
    expect(approvalValidFor(out.report, `${md}\nEdited.`, publication)).toBe(false);
    expect(out.ref.path).toMatch(/^verifications\/pub\/p1\//);
  });

  it("asks for a redraft when the evidence is overstated", async () => {
    const { metadata } = await drafted();
    const out = await verifyPackageDraft({
      content,
      archive,
      metadata,
      verifier: model("fake/verifier", OVERSTATED),
    });
    expect(out.status === "verified" && out.report.outcome).toBe("redraft");
  });

  it("catches an invented reference and a gap presented as settled, whatever the model says", async () => {
    const { pkg, draft } = await drafted();
    const p = WriterPackageSchema.parse(JSON.parse(await content.read(pkg.ref)));
    const md = await content.read(draft);
    const tampered = md
      .replace(SHARED, "https://invented.example/report")
      .replace(" unresolved -->", " contradicted -->");
    const issues = deterministicIssues(p, tampered);
    expect(issues.map((i) => i.reason)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("not in the evidence package"),
        expect.stringContaining("no evidence as settled"),
      ]),
    );
    expect(deterministicIssues(p, md)).toEqual([]);
  });

  it("redrafts with the verifier's feedback until approved", async () => {
    const writer = model(
      "fake/writer",
      writerResponse("The treaty proves the claim."),
      writerResponse(),
    );
    const { pkg, metadata } = await drafted(writer);
    const verifier = model("fake/verifier", OVERSTATED, APPROVE);
    const out = await verifyWithRevisions({
      operations,
      content,
      archive,
      package: pkg.ref,
      metadata,
      writer,
      verifier,
      sourceUrl: "https://pub.example.com/p/p1",
    });
    expect(out).toMatchObject({ outcome: "approved", revisions: 1 });
    expect(writer.calls).toBe(2);
  });

  it("saves an unresolved result after the bounded revisions, never overriding the verifier", async () => {
    const writer = model("fake/writer", writerResponse("The treaty proves the claim."));
    const { pkg, metadata } = await drafted(writer);
    const out = await verifyWithRevisions({
      operations,
      content,
      archive,
      package: pkg.ref,
      metadata,
      writer,
      verifier: model("fake/verifier", OVERSTATED),
      sourceUrl: "https://pub.example.com/p/p1",
    });
    expect(out).toMatchObject({ outcome: "unresolved", revisions: 2 });
    expect(writer.calls).toBe(3);
    if (out.outcome === "unresolved") {
      expect(JSON.parse(await content.read(out.report))).toMatchObject({
        outcome: "unresolved",
        issues: [{ severity: "substantive" }],
      });
    }
  });
});

describe("deterministic citation contract (#491)", { timeout: 60_000 }, () => {
  it("resolves background citations through their own indices when claim order changes", async () => {
    const { pkg } = await drafted();
    const raw = JSON.parse(await content.read(pkg.ref));
    const bg = (url: string, passage: string) => ({
      dossierId: "weather",
      dossier: raw.coverage,
      url,
      title: "Background",
      passage,
      checkedAt: "2026-11-20",
    });
    raw.claims = raw.claims.map((c: Record<string, unknown>, i: number) => ({
      ...c,
      status: "covered",
      coverage: "covered",
      reason: undefined,
      evidence: [{ url: `https://example.org/claim-${i}`, passage: `Claim ${i} passage.` }],
    }));
    raw.context = {
      ...(raw.context ?? {}),
      history: raw.context?.history ?? { status: "gap", reason: "none" },
      background: {
        status: "available",
        passages: [
          bg("https://example.org/bg-a", "Background A."),
          bg("https://example.org/claim-1", "Claim 1 passage."),
        ],
      },
    };
    const render = (order: number[]) => {
      const p = WriterPackageSchema.parse({ ...raw, claims: order.map((i) => raw.claims[i]) });
      return renderPackageDraft(
        p,
        {
          title: "T",
          subtitle: "S",
          excerpt: "E",
          summary: "Summary.",
          themes: ["Weather warfare"],
          responses: order.map((i) => ({
            claimRecordId: raw.claims[i].claimRecordId,
            verdict: "supported",
            text: `Response ${i}.`,
            evidence: [0],
          })),
          limitations: [],
          narrative: { status: "limited", limitation: "none" },
          widerContext: { status: "supported", text: "Wider context.", background: [1, 0] },
        } as never,
        "https://pub.example.com/p/p1",
      );
    };
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const markdown = render(order);
      const sources = markdown
        .split("## Sources")[1]!
        .split("\n")
        .filter((l) => /^\d+\./.test(l));
      const numberOf = (url: string) => sources.findIndex((l) => l.includes(url)) + 1;
      // Background index 1 is the same passage as claim 1's evidence: one shared source.
      const wider = /Wider context\. ((?:\[\d+\])+)/.exec(markdown)![1];
      expect(wider).toBe(
        `[${numberOf("https://example.org/claim-1")}][${numberOf("https://example.org/bg-a")}]`,
      );
      expect(new Set(sources).size).toBe(sources.length);
    }
  });

  it("resolves local index-zero evidence to deduplicated global references", async () => {
    const { pkg } = await drafted();
    const raw = JSON.parse(await content.read(pkg.ref));
    // Both claims get their own local index-zero evidence.
    raw.claims[0] = {
      ...raw.claims[0],
      status: "covered",
      coverage: "covered",
      reason: undefined,
      evidence: [{ url: "https://example.org/treaty", passage: "The treaty bans weapons." }],
    };
    raw.claims[1] = {
      ...raw.claims[1],
      status: "covered",
      coverage: "covered",
      reason: undefined,
      evidence: [{ url: "https://example.org/payment", passage: "The payment was recorded." }],
    };
    const parsedPkg = WriterPackageSchema.parse(raw);
    const markdown = renderPackageDraft(
      parsedPkg,
      {
        title: "T",
        subtitle: "S",
        excerpt: "E",
        summary: "Summary without references.",
        themes: ["Weather warfare"],
        responses: [
          {
            claimRecordId: raw.claims[0].claimRecordId,
            verdict: "supported",
            // The same supplied item cited twice: one source, repeated reference.
            text: "A supported statement.",
            evidence: [0, 0],
          },
          {
            claimRecordId: raw.claims[1].claimRecordId,
            verdict: "supported",
            text: "Its own index zero is a different source.",
            evidence: [0],
          },
        ],
        limitations: [],
        narrative: { status: "limited", limitation: "No earlier posts were compared." },
        widerContext: { status: "limited", limitation: "No background used." },
      } as never,
      "https://pub.example.com/p/p1",
    );
    expect(markdown).toContain("A supported statement. [1][1]");
    expect(markdown).toContain("Its own index zero is a different source. [2]");
    const sources = markdown
      .split("## Sources")[1]!
      .trim()
      .split("\n")
      .filter((l) => /^\d+\./.test(l));
    expect(sources).toHaveLength(2);
    // References are one-based, deduplicated and in first-use order.
    expect(sources[0]).toContain(raw.claims[0].evidence[0].url);
    expect(sources[1]).toContain(raw.claims[1].evidence[0].url);
  });

  it("names the exact schema field of every marker, including metadata", () => {
    const draft = {
      title: "Treaty [1]",
      subtitle: "S",
      excerpt: "E [0]",
      summary: "Summary.",
      themes: ["t"],
      responses: [
        { claimRecordId: "claim-x", verdict: "supported" as const, text: "Fine.", evidence: [0] },
        {
          claimRecordId: "claim-y",
          verdict: "supported" as const,
          text: "Bad [2].",
          evidence: [0],
        },
      ],
      limitations: ["ok", "also [3]"],
      narrative: { status: "limited" as const, limitation: "none" },
      widerContext: { status: "limited" as const, limitation: "see [4]" },
    };
    expect(modelCitationIssues(draft as never).map((i) => i.path)).toEqual([
      ["title"],
      ["excerpt"],
      ["responses", 1, "text"],
      ["widerContext", "limitation"],
      ["limitations", 1],
    ]);
    // No claim IDs or raw marker text in the feedback.
    const text = modelCitationProblems(draft as never).join(" ");
    expect(text).not.toContain("claim-y");
    expect(text).not.toContain("[2]");
  });

  it(
    "repairs a metadata-only marker by correcting just that field, preserving the body",
    { timeout: 60_000 },
    async () => {
      const users: string[] = [];
      const first = JSON.parse(writerResponse());
      first.title = "A treaty already bans weather weapons [1]";
      const responses = [
        JSON.stringify(first),
        JSON.stringify({ title: "A treaty already bans weather weapons" }),
      ];
      const writer = {
        modelVersion: "fake/writer-metadata-marker",
        calls: 0,
        async complete(request: { user: string }) {
          users.push(request.user);
          return responses[this.calls++]!;
        },
      };
      const out = await draftFromPackage({
        operations,
        content,
        archive,
        package: (await drafted()).pkg.ref,
        provider: writer as never,
        sourceUrl: "https://pub.example.com/p/p1",
      });
      if (out.status !== "drafted") throw new Error(out.status);
      // The correction request carried only the title, with the citation constraint.
      const correction = JSON.parse(users[1]!);
      expect(Object.keys(correction.invalidFields)).toEqual(["title"]);
      expect(correction.constraints.title.noNumberedCitations).toBe(true);
      const metadata = JSON.parse(await content.read(out.metadata));
      expect(metadata.fields.title).toBe("A treaty already bans weather weapons");
      // Body and other metadata are byte-for-byte the first output's.
      expect(metadata.fields.subtitle).toBe(first.subtitle);
      expect(await content.read(out.draft)).toContain(first.summary);
    },
  );

  it(
    "rejects a metadata marker that is still present when the turns run out",
    { timeout: 60_000 },
    async () => {
      const bad = JSON.parse(writerResponse());
      bad.excerpt = "Still cites [0].";
      const writer = model(
        "fake/writer-stubborn-marker",
        JSON.stringify(bad),
        JSON.stringify({ excerpt: "Still cites [0]." }),
      );
      const out = await draftFromPackage({
        operations,
        content,
        archive,
        package: (await drafted()).pkg.ref,
        provider: writer,
        sourceUrl: "https://pub.example.com/p/p1",
        mechanicalPolicy: { maxTurns: 2 },
      });
      expect(out.status).toBe("failed");
    },
  );

  it("rejects model-written numeric citation markers as bounded feedback", () => {
    const base = {
      title: "T",
      subtitle: "S",
      excerpt: "E",
      summary: "Summary.",
      themes: ["t"],
      responses: [
        { claimRecordId: "c", verdict: "supported" as const, text: "Fine.", evidence: [0] },
      ],
      limitations: [],
      narrative: { status: "limited" as const, limitation: "none" },
      widerContext: { status: "limited" as const, limitation: "none" },
    };
    expect(modelCitationProblems(base as never)).toEqual([]);
    for (const marker of ["[0]", "[1]", "[0, 1]", "[2; 3]"]) {
      const problems = modelCitationProblems({
        ...base,
        responses: [{ ...base.responses[0]!, text: `Claim ${marker}.` }],
      } as never);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("model-written citation marker");
    }
    // A Markdown link is not a citation marker.
    expect(
      modelCitationProblems({
        ...base,
        responses: [
          { ...base.responses[0]!, text: "See [the treaty](https://example.org/treaty)." },
        ],
      } as never),
    ).toEqual([]);
  });

  it(
    "redrafts a first draft whose prose contains a model-written citation",
    { timeout: 60_000 },
    async () => {
      const writer = model(
        "fake/writer-citation",
        writerResponse("The treaty bans weapons [0]."),
        writerResponse("The treaty bans weapons."),
      );
      const out = await draftFromPackage({
        operations,
        content,
        archive,
        package: (await drafted()).pkg.ref,
        provider: writer,
        sourceUrl: "https://pub.example.com/p/p1",
      });
      if (out.status !== "drafted") throw new Error(out.status);
      expect(writer.calls).toBe(2);
      const markdown = await content.read(out.draft);
      // Only the application-rendered reference remains, and it is the global one.
      expect(markdown).not.toContain("weapons [0]");
      expect(markdown).toContain("bans weapons. [1]");
      const metadata = JSON.parse(await content.read(out.metadata));
      expect(metadata.repairPromptVersion).toBeDefined();
    },
  );

  it("rejects a model-written citation in a revision too", { timeout: 60_000 }, async () => {
    const { pkg, draft } = await drafted();
    const writer = model(
      "fake/writer-citation-revision",
      writerResponse("Revised with a fake reference [1]."),
      writerResponse("Revised without a reference."),
    );
    const out = await draftFromPackage({
      operations,
      content,
      archive,
      package: pkg.ref,
      provider: writer,
      sourceUrl: "https://pub.example.com/p/p1",
      revision: { number: 1, feedback: [{ passage: "proves", reason: "overstated" }] },
      previousDraft: { ref: draft, markdown: "# Previous article\n\nBody." },
    });
    if (out.status !== "drafted") throw new Error(out.status);
    expect(writer.calls).toBe(2);
    expect(await content.read(out.draft)).not.toContain("fake reference [1]");
  });
  it("revises the exact previous article and fields, and a second revision builds on the first (#489)", async () => {
    const { pkg, metadata, draft } = await drafted();
    const initial = await content.read(draft);
    const users: string[] = [];
    let n = 0;
    const writer = {
      modelVersion: "fake/revising-writer",
      async complete(request: { user: string }) {
        users.push(request.user);
        n++;
        return writerResponse(
          `The ENMOD Convention prohibits hostile environmental modification (revision ${n}).`,
        );
      },
    };
    const out = await verifyWithRevisions({
      operations,
      content,
      archive,
      package: pkg.ref,
      metadata,
      writer: writer as never,
      // Two redraft verdicts, then approval: two revisions.
      verifier: model("fake/independent-verifier", OVERSTATED, OVERSTATED, APPROVE),
      sourceUrl: "https://pub.example.com/p/p1",
      maxRevisions: 2,
    });
    if (out.outcome !== "approved") throw new Error(out.outcome);
    expect(out.revisions).toBe(2);
    const first = loadRevision(users[0]!).revision as {
      number: number;
      previousDraft: string;
      previousFields: { title: string };
      feedback: { passage: string; reason: string }[];
    };
    // Revision 1 sees the exact initial article, its generated fields and the verifier feedback.
    expect(first.number).toBe(1);
    expect(first.previousDraft).toBe(initial);
    expect(first.previousFields.title).toBe("A treaty already bans weather weapons");
    expect(first.feedback[0]).toMatchObject({ passage: "proves" });
    // Revision 2 sees the first revised article, not the original.
    const second = loadRevision(users[1]!).revision as { number: number; previousDraft: string };
    expect(second.number).toBe(2);
    expect(second.previousDraft).toContain("(revision 1)");
    expect(second.previousDraft).not.toBe(initial);
  });

  it("stops before any model call when the previous draft cannot be read (#489)", async () => {
    const { pkg, metadata } = await drafted();
    const writer = model("fake/must-not-write", writerResponse());
    let draftReads = 0;
    const unreadable = new Proxy(content, {
      get(target, prop, receiver) {
        if (prop === "read") {
          // The verifier reads the draft first; the revision loop's own read
          // of the previous article is the one that fails.
          return async (ref: { path: string }) => {
            if (ref.path.endsWith(".md") && ++draftReads > 1) throw new Error("unreadable");
            return target.read(ref as never);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const out = await verifyWithRevisions({
      operations,
      content: unreadable,
      archive,
      package: pkg.ref,
      metadata,
      writer,
      verifier: model("fake/independent-verifier", OVERSTATED),
      sourceUrl: "https://pub.example.com/p/p1",
    });
    expect(out).toMatchObject({ outcome: "failed", reason: "draft-unavailable" });
    expect(writer.calls).toBe(0);
  });

  it("retains the last valid draft and verifier report when mechanical redraft repair fails", async () => {
    const { pkg, metadata, draft } = await drafted();
    const out = await verifyWithRevisions({
      operations,
      content,
      archive,
      package: pkg.ref,
      metadata,
      writer: model("fake/bad-redraft", "{broken"),
      verifier: model("fake/independent-verifier", OVERSTATED),
      sourceUrl: "https://pub.example.com/p/p1",
      mechanicalPolicy: { maxTurns: 1 },
    });
    expect(out).toMatchObject({
      outcome: "failed",
      reason: "malformed-output",
      revisions: 0,
      draft,
    });
    if (out.outcome !== "failed" || !out.report || !out.mechanicalRun)
      throw new Error("missing retained refs");
    expect(JSON.parse(await content.read(out.report)).outcome).toBe("redraft");
    expect(JSON.parse(await content.read(out.mechanicalRun)).outcome).toBe("turns-exhausted");
  });
});
