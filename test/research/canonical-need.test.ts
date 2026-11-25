import { it, expect } from "vite-plus/test";
import {
  canonicalNeed,
  canonicalNeedId,
} from "../../src/research/canonical-need.js";
import { createClaim } from "../../src/analysis/claim.js";
import { createClaimOccurrence } from "../../src/analysis/claim-occurrence.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
const statement = "The ENMOD Convention was adopted on 10 December 1976.";
function fixture(
  postId = "first",
  text = statement,
  dates: { text: string; value?: string }[] = [
    { text: "10 December 1976", value: "1976-12-10" },
  ],
) {
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
      dates,
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
  expect(canonicalNeedId(canonicalNeed(a))).toBe(
    canonicalNeedId(canonicalNeed(b)),
  );
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
  expect(canonicalNeedId(canonicalNeed(legacy(a)))).toBe(
    canonicalNeedId(canonicalNeed(legacy(a))),
  );
});
it("scopes missing or mismatched accepted semantic associations to the exact occurrence", () => {
  const a = fixture();
  const b = fixture("second");
  const unknown = (f: ReturnType<typeof fixture>) => ({
    ...f,
    kind: "quotation" as const,
    occurrence: {
      ...f.occurrence,
      assertionKind: "quotation",
      speaker: { kind: "unknown" },
    },
  });
  expect(canonicalNeedId(canonicalNeed(unknown(a)))).not.toBe(
    canonicalNeedId(canonicalNeed(unknown(b))),
  );
  expect(
    canonicalNeed({
      ...a,
      occurrence: { ...a.occurrence, claimId: `sha256:${"e".repeat(64)}` },
    }).occurrenceScope,
  ).toBeDefined();
  expect(
    canonicalNeed({ ...a, claim: { statement } }).occurrenceScope,
  ).toBeDefined();
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
          canonicalNeed(
            fixture(
              "same",
              `The ENMOD Convention cost ${v} on 10 December 1976.`,
            ),
          ),
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

it("preserves source qualifier appearance order rather than sorting or deduplicating it", () => {
  const input = fixture(
    "same",
    "The ENMOD Convention allegedly and reportedly was adopted on 10 December 1976.",
  );
  const withOrder = (qualifiers: string[]) =>
    canonicalNeed({
      ...input,
      claim: { ...input.claim, qualifiers },
      occurrence: { ...input.occurrence, qualifiers },
    });
  expect(canonicalNeedId(withOrder(["allegedly", "reportedly"]))).not.toBe(
    canonicalNeedId(withOrder(["reportedly", "allegedly"])),
  );
  expect(canonicalNeedId(withOrder(["allegedly"]))).not.toBe(
    canonicalNeedId(withOrder(["allegedly", "allegedly"])),
  );
});

it("does not infer shared scope from a full schema-4 wrapper around an unnamed generic proposition", () => {
  const generic = (postId: string, derivation?: 1 | 2) => {
    const text = "A payment funded an attack.";
    const source = {
      text,
      sourceVersion: sourceVersionFor(text),
      artifact: {
        repository: "synthetic",
        commit: "a".repeat(40),
        path: `${postId}.md`,
        hash: `sha256:${"b".repeat(64)}`,
      },
      publicationId: "pub",
      postId,
      url: `https://source.example/${postId}`,
    };
    const claim = createClaim(
      {
        statement: text,
        claimType: "factual",
        sourceVersion: source.sourceVersion,
        span: { start: 0, end: text.length },
        passage: text,
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
    return canonicalNeed({
      ...fixture(postId),
      ...(derivation ? { derivation } : {}),
      claim,
      occurrence,
      binding: {
        ...fixture(postId).binding,
        sourceVersion: source.sourceVersion,
        source: source.artifact,
      },
    });
  };
  // Version 2 scopes it and labels the need v2; version 1, used to check
  // bindings saved earlier, reproduces the old unscoped v1 need exactly.
  expect(generic("first").version).toBe("canonical-theme-need-v2");
  expect(generic("first", 1).version).toBe("canonical-theme-need-v1");
  expect(generic("first", 1).occurrenceScope).toBeUndefined();
  expect(canonicalNeedId(generic("first", 1))).toBe(
    canonicalNeedId(generic("second", 1)),
  );
  // A need the new rule does not change keeps the v1 label and ID.
  expect(canonicalNeed(fixture()).version).toBe("canonical-theme-need-v1");
  expect(canonicalNeedId(canonicalNeed({ ...fixture(), derivation: 1 }))).toBe(
    canonicalNeedId(canonicalNeed(fixture())),
  );
  expect(generic("first").occurrenceScope).toBeDefined();
  expect(canonicalNeedId(generic("first"))).not.toBe(
    canonicalNeedId(generic("second")),
  );
});

it("scopes dates whose meaning depends on the publication date, across posts", () => {
  for (const text of [
    "two days ago",
    "on Monday",
    "March 3",
    "last spring",
    "yesterday",
  ]) {
    const claim = `The council approved the measure ${text}.`;
    const a = canonicalNeed(fixture("first", claim, [{ text }]));
    const b = canonicalNeed(fixture("second", claim, [{ text }]));
    expect(a.occurrenceScope, text).toBeDefined();
    expect(canonicalNeedId(a), text).not.toBe(canonicalNeedId(b));
  }
});

it("shares fully specified dates and bare years across posts", () => {
  for (const dates of [
    [{ text: "3 March 2021", value: "2021-03-03" }],
    [{ text: "in 2019" }],
  ]) {
    const claim = `The council approved the measure ${dates[0]!.text}.`;
    const a = canonicalNeed(fixture("first", claim, dates));
    const b = canonicalNeed(fixture("second", claim, dates));
    expect(a.occurrenceScope).toBeUndefined();
    expect(canonicalNeedId(a)).toBe(canonicalNeedId(b));
  }
});

it("never shares research across different stated reporting periods (#889)", () => {
  const text = "Acme reported revenue of 10 million on 10 December 1976.";
  const withPeriod = (postId: string, period: string) => {
    const fx = fixture(postId, text);
    return canonicalNeed({
      ...fx,
      claim: {
        ...fx.claim,
        reportingPeriod: { dependsOnPeriod: true, text: period },
      },
    });
  };
  expect(canonicalNeedId(withPeriod("first", "Q3 2026"))).toBe(
    canonicalNeedId(withPeriod("second", "Q3 2026")),
  );
  expect(canonicalNeedId(withPeriod("first", "Q3 2026"))).not.toBe(
    canonicalNeedId(withPeriod("second", "Q4 2026")),
  );
  expect(withPeriod("first", "Q3 2026").proposition.reportingPeriod).toBe(
    "Q3 2026",
  );
  // An older claim (no period field) stating a figure without a resolved
  // date is researched only for its own occurrence.
  const older = (postId: string) =>
    canonicalNeed(fixture(postId, "Acme reported revenue of 10 million.", []));
  expect(older("first").occurrenceScope).toBeDefined();
  expect(canonicalNeedId(older("first"))).not.toBe(
    canonicalNeedId(older("second")),
  );
});
