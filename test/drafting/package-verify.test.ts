import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { draftFromPackage } from "../../src/drafting/package-draft.js";
import {
  approvalValidFor,
  deterministicIssues,
  verifyPackageDraft,
  verifyWithRevisions,
} from "../../src/drafting/package-verify.js";
import { saveWriterPackage, WriterPackageSchema } from "../../src/drafting/writer-package.js";
import { LexicalShortlister, assessPostCoverage } from "../../src/research/librarian.js";
import { CLAIMS, SHARED, TEXT, librarianFixtures } from "../research/librarian-fixtures.js";

let dir: string;
let content: GitArtifactStore;
let fx: ReturnType<typeof librarianFixtures>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-package-verify-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  fx = librarianFixtures(content);
});
afterEach(async () => {
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
    content,
    archive,
    package: pkg.ref,
    provider: writer,
    sourceUrl: "https://pub.example.com/p/p1",
  });
  if (out.status !== "drafted") throw new Error(out.status);
  return { pkg, ...out };
}

describe("package draft verification (#150)", () => {
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
    expect(approvalValidFor(out.report, md)).toBe(true);
    expect(approvalValidFor(out.report, `${md}\nEdited.`)).toBe(false);
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
      .replace("**Unresolved.** No record", "**Contradicted by the evidence.** No record");
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
