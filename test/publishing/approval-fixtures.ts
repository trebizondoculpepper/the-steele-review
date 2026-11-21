import type { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { draftFromPackage } from "../../src/drafting/package-draft.js";
import { verifyPackageDraft } from "../../src/drafting/package-verify.js";
import { saveWriterPackage } from "../../src/drafting/writer-package.js";
import { LexicalShortlister, assessPostCoverage } from "../../src/research/librarian.js";
import { CLAIMS, SHARED, TEXT, librarianFixtures } from "../research/librarian-fixtures.js";

// A deterministic approved package draft for publishing tests (#262, #315):
// fixture research, a fake writer and a fake verifier; no model calls.

export const archive = {
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

const WRITER = JSON.stringify({
  title: "A treaty already bans weather weapons",
  subtitle: "What the post claims, and what the evidence shows",
  excerpt:
    "The post says a treaty bans weather weapons; it does, but the payment claim is unsupported.",
  summary: "The post says a treaty bans weather weapons.",
  themes: ["Weather warfare"],
  responses: [
    {
      claimRecordId: "claim-treaty",
      verdict: "supported",
      text: "The ENMOD Convention prohibits this.",
      evidence: [0],
    },
    {
      claimRecordId: "claim-payment",
      verdict: "unresolved",
      text: "No record was found.",
      evidence: [],
    },
  ],
  limitations: [],
  narrative: { status: "limited", limitation: "None compared." },
  widerContext: { status: "limited", limitation: "None used." },
});
const fake = (version: string, response: string) => ({
  modelVersion: version,
  complete: async () => response,
});

/** An approved package draft and its saved verification report. */
export async function approvedReport(
  content: GitArtifactStore,
  verdict = "approved",
  legacy = false,
) {
  const fx = librarianFixtures(content);
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
  const draft = await draftFromPackage({
    content,
    archive,
    package: pkg.ref,
    provider: fake("fake/writer", WRITER),
    sourceUrl: "https://pub.example.com/p/p1",
  });
  if (draft.status !== "drafted") throw new Error(draft.status);
  let metadata = draft.metadata;
  if (legacy) {
    const old = JSON.parse(await content.read(metadata));
    delete old.fields;
    metadata = await content.write(
      metadata.path.replace(/\.json$/, "-legacy.json"),
      JSON.stringify(old),
    );
  }
  const verified = await verifyPackageDraft({
    content,
    archive,
    metadata,
    verifier: fake(
      "fake/verifier",
      JSON.stringify({
        verdict,
        issues:
          verdict === "approved" ? [] : [{ passage: "x", reason: "y", severity: "substantive" }],
      }),
    ),
  });
  if (verified.status !== "verified") throw new Error(verified.status);
  return verified.ref;
}
