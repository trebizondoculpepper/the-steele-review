import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { ModelProviderError } from "../../src/controllers/openrouter.js";
import { draftFromPackage, draftProblems } from "../../src/drafting/package-draft.js";
import { saveWriterPackage, WriterPackageSchema } from "../../src/drafting/writer-package.js";
import { LexicalShortlister, assessPostCoverage } from "../../src/research/librarian.js";
import { CLAIMS, SHARED, TEXT, librarianFixtures } from "../research/librarian-fixtures.js";

let dir: string;
let content: GitArtifactStore;
let fx: ReturnType<typeof librarianFixtures>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-package-draft-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  fx = librarianFixtures(content);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** In-memory archive returning the captured post the fixtures point at. */
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
};

async function packageRef(
  plan: Parameters<typeof fx.researcher>[0] = () => ({
    passages: [{ claimRecordId: "claim-treaty", url: SHARED }],
  }),
) {
  const a = await fx.analysis("p1", CLAIMS);
  const coverage = await assessPostCoverage({
    artifacts: content,
    ...a,
    commission: fx.researcher(plan).commission,
    shortlister: new LexicalShortlister(),
  });
  return (await saveWriterPackage({ content, coverage: coverage.ref })).ref;
}

/** A package built with the archive: it pins the capture's original URL and title (#276). */
async function pinnedPackageRef() {
  const a = await fx.analysis("p1", CLAIMS);
  const coverage = await assessPostCoverage({
    artifacts: content,
    ...a,
    commission: fx.researcher(() => ({
      passages: [{ claimRecordId: "claim-treaty", url: SHARED }],
    })).commission,
    shortlister: new LexicalShortlister(),
  });
  return (
    await saveWriterPackage({
      content,
      archive: archive as unknown as Parameters<typeof saveWriterPackage>[0]["archive"],
      coverage: coverage.ref,
    })
  ).ref;
}

const model = (...responses: string[]) => {
  let calls = 0;
  return {
    modelVersion: "fake/writer",
    get calls() {
      return calls;
    },
    complete: async () => responses[Math.min(calls++, responses.length - 1)],
  };
};

const GOOD = JSON.stringify({
  summary:
    "The post says a treaty bans weather weapons and that a 56 million payment funded an attack.",
  themes: ["Weather warfare"],
  responses: [
    {
      claimRecordId: "claim-treaty",
      verdict: "supported",
      text: "The ENMOD Convention does prohibit hostile environmental modification.",
      evidence: [0],
    },
    {
      claimRecordId: "claim-payment",
      verdict: "unresolved",
      text: "No source documenting such a payment was found.",
      evidence: [],
    },
  ],
  limitations: ["The payment claim could not be checked against any record."],
  narrative: { status: "limited", limitation: "No earlier posts were compared." },
  widerContext: { status: "limited", limitation: "No independent background was used." },
});

describe("drafting from a writer package (#149)", { timeout: 60_000 }, () => {
  it("writes a cited draft traceable to the package, keeping gaps as unresolved", async () => {
    const ref = await packageRef();
    const provider = model(GOOD);
    const out = await draftFromPackage({
      content,
      archive,
      package: ref,
      provider,
      sourceUrl: "https://pub.example.com/p/p1",
    });
    if (out.status !== "drafted") throw new Error(out.status);
    const md = await content.read(out.draft);
    // A package without a pinned URL takes the caller's, as an explicit link.
    expect(md).toContain(
      "Original post: [https://pub.example.com/p/p1](<https://pub.example.com/p/p1>)",
    );
    expect(md).not.toMatch(/^#{2,3} (?!Sources$)/m);
    expect(md).toMatch(/<!-- claim-verdict [a-f0-9]+ supported -->/);
    expect(md).toContain("[1]");
    expect(md).toContain(`1. ${SHARED}`);
    expect(md).toContain("No source documenting");
    const meta = JSON.parse(await content.read(out.metadata));
    expect(meta).toMatchObject({
      package: { path: ref.path },
      templateVersion: "package-explainer-v4",
      modelVersion: "fake/writer",
    });
  });

  it("reuses the saved draft on retry without another model call", async () => {
    const ref = await packageRef();
    const provider = model(GOOD);
    const one = await draftFromPackage({
      content,
      archive,
      package: ref,
      provider,
      sourceUrl: "https://x/p",
    });
    const two = await draftFromPackage({
      content,
      archive,
      package: ref,
      provider,
      sourceUrl: "https://x/p",
    });
    expect(two).toMatchObject({ status: "drafted", reused: true });
    expect(one.status === "drafted" && two.status === "drafted" && two.draft.path).toBe(
      one.status === "drafted" && one.draft.path,
    );
    expect(provider.calls).toBe(1);
  });

  it("never turns a gap into a correction or confirmation", async () => {
    const pkg = WriterPackageSchema.parse(JSON.parse(await content.read(await packageRef())));
    const bad = {
      summary: "s",
      themes: [],
      responses: [
        {
          claimRecordId: "claim-payment",
          verdict: "contradicted" as const,
          text: "This payment never happened.",
          evidence: [0],
        },
      ],
      limitations: [],
    };
    expect(draftProblems(pkg, bad)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("gap claim"),
        expect.stringContaining("cites evidence"),
      ]),
    );
    expect(
      draftProblems(pkg, {
        ...bad,
        responses: [
          { claimRecordId: "claim-treaty", verdict: "supported", text: "t", evidence: [5] },
        ],
      }),
    ).toEqual([expect.stringContaining("unknown evidence")]);
  });

  it("rejects malformed and invalid output, then succeeds on a valid retry", async () => {
    const ref = await packageRef();
    const invalid = JSON.stringify({
      ...JSON.parse(GOOD),
      responses: [
        { claimRecordId: "claim-payment", verdict: "contradicted", text: "x", evidence: [] },
      ],
    });
    const failed = await draftFromPackage({
      content,
      archive,
      package: ref,
      provider: model("not json", invalid),
      sourceUrl: "https://x/p",
    });
    expect(failed).toMatchObject({ status: "failed", reason: "invalid-draft" });
    const ok = await draftFromPackage({
      content,
      archive,
      package: ref,
      provider: model("not json", GOOD),
      sourceUrl: "https://x/p",
    });
    expect(ok.status).toBe("drafted");
  });

  it("does not draft from an evidence-gap package", async () => {
    const ref = await packageRef(() => "failed");
    expect(
      await draftFromPackage({
        content,
        archive,
        package: ref,
        provider: model(GOOD),
        sourceUrl: "https://x/p",
      }),
    ).toEqual({ status: "evidence-gap" });
  });

  it("keeps older drafts when the prompt version changes", async () => {
    const ref = await packageRef();
    const one = await draftFromPackage({
      content,
      archive,
      package: ref,
      provider: model(GOOD),
      sourceUrl: "https://x/p",
    });
    const two = await draftFromPackage({
      content,
      archive,
      package: ref,
      provider: model(GOOD),
      sourceUrl: "https://x/p",
      prompt: { version: "comparison-test-alternate-prompt", instructions: "x" },
    });
    if (one.status !== "drafted" || two.status !== "drafted") throw new Error("expected drafts");
    expect(two.draft.path).not.toBe(one.draft.path);
    expect(await content.read(one.draft)).toContain("Original post");
  });

  describe("narrative and wider context (#176)", () => {
    const comparison = (
      source: unknown,
      sourceVersion: string,
      extra: Record<string, unknown> = {},
    ) =>
      JSON.stringify({
        status: "complete",
        claimId: `sha256:${"c".repeat(64)}`,
        findings: [
          {
            kind: "repetition",
            explanation: {
              text: "The author made the same treaty claim in May 2023.",
              generatedBy: "m",
              isEvidence: false,
            },
            uncertainty: "low",
            current: {
              claimId: "x",
              quote: "A treaty bans weather weapons.",
              artifact: source,
              sourceVersion,
              start: 0,
              end: 30,
            },
            earlier: [
              {
                passageId: "p",
                postId: "earlier",
                publishedAt: "2023-05-01",
                url: "https://pub.example.com/p/earlier",
                quote: "The treaty bans weather weapons.",
                artifact: {
                  repository: "archive",
                  commit: "d".repeat(40),
                  path: "substack/pub/earlier/collected.json",
                  hash: `sha256:${"e".repeat(64)}`,
                },
                start: 0,
                end: 32,
              },
            ],
            ...extra,
          },
        ],
        rejected: [],
        modelVersion: "m",
        promptVersion: "p",
      });
    const withContext = (over: Record<string, unknown>) =>
      JSON.stringify({ ...JSON.parse(GOOD), ...over });

    it("requires limitations when history is absent, and cites independent background for wider context", async () => {
      const ref = await packageRef();
      const pkg = WriterPackageSchema.parse(JSON.parse(await content.read(ref)));
      expect(pkg.context!.history.status).toBe("gap");
      const overreach = {
        ...JSON.parse(GOOD),
        narrative: { status: "supported", text: "The author has long claimed this.", history: [0] },
      };
      expect(draftProblems(pkg, overreach)).toEqual(
        expect.arrayContaining([expect.stringContaining("without historical evidence")]),
      );
      const out = await draftFromPackage({
        content,
        archive,
        package: ref,
        provider: model(
          withContext({
            narrative: { status: "limited", limitation: "No earlier posts were compared." },
            widerContext: {
              status: "supported",
              text: "The treaty is a standard reference in this movement's claims.",
              background: [0],
            },
          }),
        ),
        sourceUrl: "https://x/p",
      });
      if (out.status !== "drafted") throw new Error(out.status);
      const md = await content.read(out.draft);
      expect(md).toContain("No earlier posts were compared.");
      expect(md).not.toContain("## The wider movement");
      expect(md).toMatch(/standard reference in this movement's claims\. \[\d\]/);
    });

    it("renders dated earlier passages as quotes and the comparison as labelled analysis", async () => {
      const a = await fx.analysis("p1", CLAIMS);
      const coverage = await assessPostCoverage({
        artifacts: content,
        ...a,
        commission: fx.researcher(() => ({
          passages: [{ claimRecordId: "claim-treaty", url: SHARED }],
        })).commission,
        shortlister: new LexicalShortlister(),
      });
      const record = JSON.parse(await content.read(coverage.ref));
      const themes = JSON.parse(
        await content.read((await content.lookup(record.themeResult.path))!),
      );
      const cmp = await content.write(
        "comparisons/pub/p1/a.json",
        comparison(record.source, themes.sourceVersion, {
          kind: "possible-contradiction",
          conflictRationale: "Earlier wording was narrower in scope.",
        }),
      );
      const { ref } = await saveWriterPackage({
        content,
        coverage: coverage.ref,
        comparisons: [cmp],
      });
      const out = await draftFromPackage({
        content,
        archive,
        package: ref,
        provider: model(
          withContext({
            narrative: {
              status: "supported",
              text: "The post reframes an earlier claim.",
              history: [0],
            },
          }),
        ),
        sourceUrl: "https://x/p",
      });
      if (out.status !== "drafted") throw new Error(out.status);
      const md = await content.read(out.draft);
      expect(md).toContain(
        '> "The treaty bans weather weapons." (2023-05-01, https://pub.example.com/p/earlier)',
      );
      expect(md).toContain("analysis, not evidence");
      expect(md).toContain("_Qualification: Earlier wording was narrower in scope._");
      // Different context, different package: a distinct draft identity.
      const plain = await packageRef();
      expect(plain.path).not.toBe(ref.path);
    });

    it("rejects citations of context the package does not hold", async () => {
      const pkg = WriterPackageSchema.parse(JSON.parse(await content.read(await packageRef())));
      const bad = {
        ...JSON.parse(GOOD),
        widerContext: { status: "supported", text: "t", background: [99] },
      };
      expect(draftProblems(pkg, bad)).toEqual([expect.stringContaining("unknown background")]);
    });
  });

  describe("writer model override (#260)", () => {
    it("records requested and resolved models, keeps distinct models' drafts apart, and reuses on replay", async () => {
      const ref = await packageRef();
      const a = model(GOOD);
      const one = await draftFromPackage({
        content,
        archive,
        package: ref,
        provider: { ...a, modelVersion: "openrouter/vendor/model-a", complete: a.complete },
        sourceUrl: "https://x/p",
        requestedModel: "vendor/model-a",
        resolvedModel: () => "vendor/model-a-2026-01",
      });
      const b = model(GOOD);
      const two = await draftFromPackage({
        content,
        archive,
        package: ref,
        provider: { ...b, modelVersion: "openrouter/vendor/model-b", complete: b.complete },
        sourceUrl: "https://x/p",
        requestedModel: "vendor/model-b",
      });
      if (one.status !== "drafted" || two.status !== "drafted") throw new Error("expected drafts");
      expect(two.draft.path).not.toBe(one.draft.path);
      expect(JSON.parse(await content.read(one.metadata))).toMatchObject({
        modelVersion: "openrouter/vendor/model-a",
        requestedModel: "vendor/model-a",
        resolvedModel: "vendor/model-a-2026-01",
      });
      const again = await draftFromPackage({
        content,
        archive,
        package: ref,
        provider: {
          modelVersion: "openrouter/vendor/model-a",
          complete: async () => {
            throw new Error("must not be called");
          },
        },
        sourceUrl: "https://x/p",
      });
      expect(again).toMatchObject({ status: "drafted", reused: true });
    });

    it("reports an unknown model without retrying or switching models", async () => {
      const ref = await packageRef();
      let calls = 0;
      const out = await draftFromPackage({
        content,
        archive,
        package: ref,
        provider: {
          modelVersion: "openrouter/vendor/does-not-exist",
          complete: async () => {
            calls++;
            throw new ModelProviderError("bad-request", 400);
          },
        },
        sourceUrl: "https://x/p",
        requestedModel: "vendor/does-not-exist",
      });
      expect(out).toMatchObject({
        status: "failed",
        reason: "provider-failed",
        providerError: "bad-request",
      });
      expect(calls).toBe(1);
    });
  });

  it("takes the original post's link from the pinned capture and refuses a different one (#276)", async () => {
    const ref = await pinnedPackageRef();
    const pkg = WriterPackageSchema.parse(JSON.parse(await content.read(ref)));
    expect(pkg.source).toMatchObject({ originalUrl: "https://pub.example.com/p/p1", title: "T" });
    // No URL from the caller: the package's is used, as an explicit titled link.
    const out = await draftFromPackage({ content, archive, package: ref, provider: model(GOOD) });
    if (out.status !== "drafted") throw new Error(out.status);
    expect(await content.read(out.draft)).toContain(
      "Original post: [T](<https://pub.example.com/p/p1>)",
    );
    // A matching URL is accepted and reuses the same draft.
    expect(
      await draftFromPackage({
        content,
        archive,
        package: ref,
        provider: model(GOOD),
        sourceUrl: "https://pub.example.com/p/p1",
      }),
    ).toMatchObject({ status: "drafted", reused: true });
    // A different URL is refused before any model call.
    const provider = model(GOOD);
    expect(
      await draftFromPackage({
        content,
        archive,
        package: ref,
        provider,
        sourceUrl: "https://elsewhere.example.com/p/other",
      }),
    ).toEqual({ status: "failed", reason: "source-url-mismatch" });
  });

  it("needs a link from somewhere for a package without a pinned URL", async () => {
    const ref = await packageRef();
    expect(
      await draftFromPackage({ content, archive, package: ref, provider: model(GOOD) }),
    ).toEqual({ status: "failed", reason: "no-source-url" });
  });

  it("makes exactly one model request with a single attempt, even on malformed output (#261)", async () => {
    const ref = await packageRef();
    const provider = model("not json", GOOD);
    const out = await draftFromPackage({
      content,
      archive,
      package: ref,
      provider,
      sourceUrl: "https://pub.example.com/p/p1",
      maxAttempts: 1,
    });
    expect(out).toMatchObject({ status: "failed", reason: "malformed-output" });
    expect(provider.calls).toBe(1);
  });
});
