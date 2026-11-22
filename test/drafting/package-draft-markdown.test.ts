import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { deterministicIssues } from "../../src/drafting/package-verify.js";
import { PackageDraftMetadataSchema, draftFromPackage } from "../../src/drafting/package-draft.js";
import { saveWriterPackage, WriterPackageSchema } from "../../src/drafting/writer-package.js";
import { LexicalShortlister, assessPostCoverage } from "../../src/research/librarian.js";
import { CLAIMS, SHARED, TEXT, librarianFixtures } from "../research/librarian-fixtures.js";

let operations: OperationStore;
let dir: string;
let content: GitArtifactStore;
let fx: ReturnType<typeof librarianFixtures>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-md-draft-"));
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
};

async function packageRef() {
  const a = await fx.analysis("p1", CLAIMS);
  const coverage = await assessPostCoverage({
    artifacts: content,
    ...a,
    commission: fx.researcher(() => ({
      passages: [{ claimRecordId: "claim-treaty", url: SHARED }],
    })).commission,
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
    complete: async () => responses[Math.min(calls++, responses.length - 1)]!,
  };
};

const header = (over: Record<string, unknown> = {}) => ({
  title: "A treaty already bans weather weapons",
  subtitle: "What the post claims, and what the evidence shows",
  excerpt:
    "The post says a treaty bans weather weapons; it does, but the payment claim is unsupported.",
  provenance: {
    responses: [
      { claimRecordId: "claim-treaty", verdict: "supported", evidence: [0] },
      { claimRecordId: "claim-payment", verdict: "unresolved", evidence: [] },
    ],
  },
  ...over,
});
const BODY = [
  'The post says a treaty bans weather weapons and that a "56 million" payment funded an attack.',
  "",
  "---",
  "",
  "The ENMOD Convention does prohibit hostile environmental modification — that part is right.",
  "",
  "```",
  "---",
  "```",
  "",
  "No record of the payment was found, so it stays unresolved.",
].join("\n");
const doc = (h: unknown = header(), body = BODY) => `---json\n${JSON.stringify(h)}\n---\n\n${body}`;

const draft = async (
  provider: ReturnType<typeof model>,
  ref?: Awaited<ReturnType<typeof packageRef>>,
) =>
  draftFromPackage({
    operations,
    content,
    archive,
    package: ref ?? (await packageRef()),
    provider,
    sourceUrl: "https://x/p",
    format: "markdown",
  });

describe("Markdown writer output (#535 slice 2)", { timeout: 60_000 }, () => {
  it("keeps the body exactly and frames it with verdict markers and the Sources list", async () => {
    const out = await draft(model(doc()));
    expect(out.status).toBe("drafted");
    if (out.status !== "drafted") return;
    const md = await content.read(out.draft);
    expect(md).toContain(BODY);
    expect(md).toMatch(/^<!-- claim-verdict [0-9a-f]+ supported -->$/m);
    expect(md).toContain("## Sources");
    expect(md).toContain(SHARED);
    const meta = PackageDraftMetadataSchema.parse(JSON.parse(await content.read(out.metadata)));
    expect(meta.format).toBe("markdown-json-header-v1");
    expect(meta.fields).toEqual({
      title: header().title,
      subtitle: header().subtitle,
      excerpt: header().excerpt,
    });
    // The verifier's deterministic checks read the same contract as before.
    const pkg = WriterPackageSchema.parse(
      JSON.parse(await content.read((await content.lookup(meta.package.path))!)),
    );
    expect(deterministicIssues(pkg, md)).toEqual([]);
  });

  it("rejects provenance that cites unknown claims or evidence, then corrects", async () => {
    const bad = header({
      provenance: {
        responses: [{ claimRecordId: "claim-treaty", verdict: "supported", evidence: [9] }],
      },
    });
    const provider = model(doc(bad), doc());
    const out = await draft(provider);
    expect(out.status).toBe("drafted");
    expect(provider.calls).toBe(2);
  });

  it("repairs only a header field with a model-written marker, keeping the body byte for byte", async () => {
    const provider = model(
      doc(header({ title: "Weather weapons [1] are banned" })),
      JSON.stringify({ title: "Weather weapons are banned" }),
    );
    const out = await draft(provider);
    expect(out.status).toBe("drafted");
    if (out.status !== "drafted") return;
    const md = await content.read(out.draft);
    expect(md).toContain(BODY);
    const meta = PackageDraftMetadataSchema.parse(JSON.parse(await content.read(out.metadata)));
    expect(meta.fields?.title).toBe("Weather weapons are banned");
  });

  it("treats a malformed or missing header as a format error and asks for a correction", async () => {
    const provider = model("Just prose, no header.", doc());
    const out = await draft(provider);
    expect(out.status).toBe("drafted");
    expect(provider.calls).toBe(2);
  });

  it("refuses header keys outside the contract", async () => {
    const provider = model(
      doc(header({ publish: true })),
      doc(header({ publish: true })),
      doc(header({ publish: true })),
    );
    const out = await draft(provider);
    expect(out.status).toBe("failed");
  });

  it("gives Markdown drafts their own identity and leaves legacy JSON drafts unchanged", async () => {
    const ref = await packageRef();
    const md = await draft(model(doc()), ref);
    const legacyProvider = model(
      JSON.stringify({
        title: "T",
        subtitle: "S",
        excerpt: "E",
        summary: "Summary.",
        themes: [],
        responses: [
          {
            claimRecordId: "claim-payment",
            verdict: "unresolved",
            text: "Unresolved.",
            evidence: [],
          },
        ],
        limitations: [],
        narrative: { status: "limited", limitation: "None." },
        widerContext: { status: "limited", limitation: "None." },
      }),
    );
    const legacy = await draftFromPackage({
      operations,
      content,
      archive,
      package: ref,
      provider: legacyProvider,
      sourceUrl: "https://x/p",
    });
    expect(md.status).toBe("drafted");
    expect(legacy.status).toBe("drafted");
    if (md.status !== "drafted" || legacy.status !== "drafted") return;
    expect(md.draft.path).not.toBe(legacy.draft.path);
    const legacyMeta = PackageDraftMetadataSchema.parse(
      JSON.parse(await content.read(legacy.metadata)),
    );
    expect(legacyMeta.format).toBeUndefined();
    // A repeat of the Markdown draft reuses it without another model call.
    const again = model(doc());
    const reused = await draft(again, ref);
    expect(reused).toMatchObject({ status: "drafted", reused: true });
    expect(again.calls).toBe(0);
  });

  it("reads the deployment's writer format strictly, defaulting to json", async () => {
    const { writerFormatFromEnv } = await import("../../src/drafting/package-draft.js");
    expect(writerFormatFromEnv({})).toBe("json");
    expect(writerFormatFromEnv({ STEELE_WRITER_FORMAT: "markdown" })).toBe("markdown");
    expect(() => writerFormatFromEnv({ STEELE_WRITER_FORMAT: "yaml" })).toThrow(/json or markdown/);
  });

  it("keeps significant leading indentation in the body", async () => {
    const indented = "    quotedCode();\n    more();\n\nThen prose.";
    const out = await draft(model(doc(header(), indented)));
    expect(out.status).toBe("drafted");
    if (out.status !== "drafted") return;
    expect(await content.read(out.draft)).toContain(indented);
  });
});
