import { it, expect } from "vite-plus/test";
import { canonicalNeed, canonicalNeedId } from "../../src/research/canonical-need.js";
import { createClaim } from "../../src/analysis/claim.js";
import { createClaimOccurrence } from "../../src/analysis/claim-occurrence.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
const statement = "The ENMOD Convention was adopted on 10 December 1976.";
function fixture(postId = "first", text = statement) {
  const artifact = {
    repository: "synthetic",
    commit: "a".repeat(40),
    path: `${postId}.md`,
    hash: `sha256:${"b".repeat(64)}`,
  };
  const source = {
    text,
    sourceVersion: sourceVersionFor(text),
    artifact,
    publicationId: "pub",
    postId,
    url: `https://source.example/${postId}`,
    author: `Author ${postId}`,
  };
  const claim = createClaim(
    {
      statement: text,
      claimType: "factual",
      sourceVersion: source.sourceVersion,
      span: { start: 0, end: text.length },
      passage: text,
      entities: ["ENMOD Convention"],
      dates: [{ text: "10 December 1976", value: "1976-12-10" }],
      extraction: {
        modelVersion: "synthetic",
        promptVersion: "synthetic",
        extractedAt: "2026-01-01T00:00:00Z",
      },
    },
    source,
  );
  const occurrence = createClaimOccurrence({
    claim,
    source,
    speaker: { kind: "author-voice" },
    assertionKind: "assertion",
    themes: ["enmod"],
  });
  return {
    themeId: "enmod",
    claimRecordId: "same-grouped-id",
    kind: "assertion" as const,
    claim,
    occurrence,
    binding: {
      schemaVersion: 4,
      publicationId: "pub",
      postId,
      sourceVersion: source.sourceVersion,
      source: artifact,
      analysis: {
        repository: "synthetic",
        commit: "c".repeat(40),
        path: `${postId}.json`,
        hash: `sha256:${"d".repeat(64)}`,
      },
      index: 0,
    },
  };
}
it("shares full accepted semantic claims independently of extraction IDs and source authors", () => {
  const a = fixture();
  const b = { ...fixture("second"), claimRecordId: "renamed" };
  expect(canonicalNeedId(canonicalNeed(a))).toBe(canonicalNeedId(canonicalNeed(b)));
});
it("keeps permissive legacy data occurrence-specific even with identical grouped IDs", () => {
  const a = fixture();
  const b = fixture("second");
  const legacy = (f: ReturnType<typeof fixture>) => ({
    ...f,
    binding: { ...f.binding, schemaVersion: 2 },
  });
  expect(canonicalNeedId(canonicalNeed(legacy(a)))).not.toBe(
    canonicalNeedId(canonicalNeed(legacy(b))),
  );
  expect(canonicalNeedId(canonicalNeed(legacy(a)))).toBe(canonicalNeedId(canonicalNeed(legacy(a))));
});
it("scopes missing or mismatched accepted semantic associations to the exact occurrence", () => {
  const a = fixture();
  const b = fixture("second");
  const unknown = (f: ReturnType<typeof fixture>) => ({
    ...f,
    kind: "quotation" as const,
    occurrence: { ...f.occurrence, assertionKind: "quotation", speaker: { kind: "unknown" } },
  });
  expect(canonicalNeedId(canonicalNeed(unknown(a)))).not.toBe(
    canonicalNeedId(canonicalNeed(unknown(b))),
  );
  expect(
    canonicalNeed({ ...a, occurrence: { ...a.occurrence, claimId: `sha256:${"e".repeat(64)}` } })
      .occurrenceScope,
  ).toBeDefined();
  expect(canonicalNeed({ ...a, claim: { statement } }).occurrenceScope).toBeDefined();
});
it("preserves quantity, punctuation, case, negation and semantic qualifiers", () => {
  const variants = [
    "56 million",
    "5.6 million",
    "56 billion",
    "not 56 million",
    "56-million",
    "56 Million",
  ];
  expect(
    new Set(
      variants.map((v) =>
        canonicalNeedId(
          canonicalNeed(fixture("same", `The ENMOD Convention cost ${v} on 10 December 1976.`)),
        ),
      ),
    ).size,
  ).toBe(variants.length);
  const a = fixture();
  expect(canonicalNeedId(canonicalNeed(a))).not.toBe(
    canonicalNeedId(
      canonicalNeed({
        ...a,
        claim: { ...a.claim, qualifiers: ["allegedly"] },
        occurrence: { ...a.occurrence, qualifiers: ["allegedly"] },
      }),
    ),
  );
});
