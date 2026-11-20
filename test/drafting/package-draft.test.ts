import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
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
});

describe("drafting from a writer package (#149)", () => {
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
    expect(md).toContain("Original post: https://pub.example.com/p/p1");
    expect(md).toContain("**Supported by the evidence.**");
    expect(md).toContain("[1]");
    expect(md).toContain(`1. ${SHARED}`);
    expect(md).toContain("**Unresolved.** No source documenting");
    const meta = JSON.parse(await content.read(out.metadata));
    expect(meta).toMatchObject({
      package: { path: ref.path },
      templateVersion: "package-explainer-v1",
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
      prompt: { version: "package-draft-v2", instructions: "x" },
    });
    if (one.status !== "drafted" || two.status !== "drafted") throw new Error("expected drafts");
    expect(two.draft.path).not.toBe(one.draft.path);
    expect(await content.read(one.draft)).toContain("Original post");
  });
});
