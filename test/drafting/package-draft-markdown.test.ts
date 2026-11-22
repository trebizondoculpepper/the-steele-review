import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { deterministicIssues } from "../../src/drafting/package-verify.js";
import { PackageDraftMetadataSchema, draftFromPackage } from "../../src/drafting/package-draft.js";
import { DraftAttemptDiagnosticSchema } from "../../src/drafting/draft-diagnostics.js";
import { MechanicalRecordSchema } from "../../src/drafting/mechanical-record.js";
import { artifactRef } from "../../src/drafting/publication-payload.js";
import { markdownToProseMirror } from "../../src/publishing/substack/prosemirror.js";
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
  "## What the treaty says",
  "",
  "> The ENMOD Convention prohibits hostile environmental modification.",
  "",
  "That part is right — Ünïcödé and “curly quotes” survive intact.",
  "",
  "- No record of the payment was found.",
  "- So it stays unresolved.",
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

  it("keeps the body's text exactly, including leading spaces inside a paragraph", async () => {
    const body = "  Leading spaces stay.\n\nThen prose.";
    const out = await draft(model(doc(header(), body)));
    expect(out.status).toBe("drafted");
    if (out.status !== "drafted") return;
    expect(await content.read(out.draft)).toContain(body);
  });

  it("sends Markdown the publisher cannot render back for correction before verification", async () => {
    const fenced = "Intro.\n\n```\ncode\n```\n\nOutro.";
    const provider = model(doc(header(), fenced), doc());
    const out = await draft(provider);
    expect(out.status).toBe("drafted");
    expect(provider.calls).toBe(2);
    if (out.status !== "drafted") return;
    const { markdownToProseMirror } = await import("../../src/publishing/substack/prosemirror.js");
    const rendered = await content.read(out.draft);
    expect(() => markdownToProseMirror(rendered)).not.toThrow();
  });

  it.each([
    "The relation x<y is established.",
    '<script>alert("untrusted")</script>',
    "A source quotes [an unsafe link](javascript:alert(1)).",
  ])(
    "stops immutable source formatting failures without buying a writer correction: %s",
    async (passage) => {
      const pkg = WriterPackageSchema.parse(JSON.parse(await content.read(await packageRef())));
      const evidence = pkg.claims.find((c) => c.claimRecordId === "claim-treaty")!.evidence[0]!;
      evidence.passage = passage;
      const ref = await content.write(
        "writer-packages/pub/p1/awkward-source.json",
        JSON.stringify(pkg),
      );
      const original = await content.read(ref);
      expect(() => markdownToProseMirror(BODY)).not.toThrow();
      const provider = model(doc());
      const out = await draft(provider, ref);
      expect(out).toMatchObject({
        status: "failed",
        reason: "application-format-failed",
        validationFailure: "application-format",
        problems: ["application-format-failed"],
      });
      expect(provider.calls).toBe(1);
      if (out.status !== "failed") return;
      const diagnostic = DraftAttemptDiagnosticSchema.parse(
        JSON.parse(await content.read(out.diagnostics![0]!)),
      );
      expect(diagnostic).toMatchObject({
        kind: "application-format",
        issues: [{ code: "custom", path: [] }],
      });
      const mechanical = MechanicalRecordSchema.parse(
        JSON.parse(await content.read(out.mechanicalRun!)),
      );
      expect(mechanical.outcome).toBe("application-format-failed");
      expect(mechanical.turns).toHaveLength(1);
      // The returned writer bytes and pinned evidence stay intact for application repair.
      const manifest = JSON.parse(await content.read(artifactRef(diagnostic.writerAttempt!)));
      expect(await content.read(artifactRef(manifest.raw))).toBe(doc());
      expect(await content.read(ref)).toBe(original);
      const replay = model(doc());
      expect(await draft(replay, ref)).toMatchObject({
        status: "failed",
        reason: "application-format-failed",
      });
      expect(replay.calls).toBe(0);
    },
  );

  it("leaves title-only repair when a merged title exposes an undeliverable body", async () => {
    const fenced = "Intro.\n\n```\ncode\n```\n\nOutro.";
    const provider = model(
      doc(header({ title: "t".repeat(200) }), fenced),
      JSON.stringify({ title: "A short title" }),
      doc(header({ title: "A short title" })),
    );
    const out = await draft(provider);
    expect(out.status).toBe("drafted");
    expect(provider.calls).toBe(3);
  });
});
