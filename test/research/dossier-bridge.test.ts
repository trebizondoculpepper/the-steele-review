import { describe, expect, it } from "vite-plus/test";
import {
  DossierBridgeError,
  buildDossierProjection,
  citationTraceKey,
  dossierCitationId,
  researchCandidates,
  resolveDossier,
  selectedEvidenceForOccurrence,
  traceBriefCitations,
  type DossierCitationLink,
  type OccurrenceClaimLink,
  type ResearchReference,
} from "../../src/research/dossier-bridge.js";
import { parseDossier, renderDossier } from "../../src/research/dossier.js";
import type { EvidenceSource, ResearchEntry } from "../../src/research/research-entry.js";
import type { DraftingBrief } from "../../src/drafting/brief.js";

// Synthetic values only.
const claimA = `sha256:${"a1".repeat(32)}`;
const claimANormalised = `sha256:${"b2".repeat(32)}`;
const claimB = `sha256:${"c3".repeat(32)}`;

const artifact = {
  repository: "synthetic-research-archive",
  commit: "0123456789abcdef0123456789abcdef01234567",
  path: "research/research-synthetic/v1.json",
  hash: `sha256:${"d4".repeat(32)}`,
};

const external: EvidenceSource = {
  kind: "external",
  url: "https://evidence.example.org/synthetic-report",
  title: "Synthetic evidence report",
  publishedAt: "2026-01-05T00:00:00Z",
  retrievedAt: "2026-02-01T00:00:00Z",
  lastCheckedAt: "2026-02-10T00:00:00Z",
  passage: "A synthetic report states the synthetic figure was 3%.",
};

const monitored: EvidenceSource = {
  kind: "monitored",
  url: "https://example-pub.substack.com/p/a-synthetic-post",
  title: "A synthetic post",
  retrievedAt: "2026-02-01T00:00:00Z",
  lastCheckedAt: "2026-02-10T00:00:00Z",
  passage: "The synthetic council said it may raise fees by 3%.",
};

const entry = (overrides: Partial<ResearchEntry> = {}): ResearchEntry => ({
  schemaVersion: 1,
  question: "Did the synthetic council raise fees by 3%?",
  addressedClaims: [
    {
      claimId: claimANormalised,
      statement: "The synthetic council raised fees by 3%.",
      finding: "supported",
      evidence: [external, monitored],
    },
  ],
  explanation: {
    text: "A synthetic explanation of the evidence.",
    generatedBy: "synthetic-model-v1",
  },
  limitations: ["Only synthetic sources were consulted."],
  unresolvedGaps: [],
  provenance: {
    modelVersion: "synthetic-model-v1",
    promptVersion: "research-v1",
    createdAt: "2026-02-11T00:00:00Z",
  },
  ...overrides,
});

const reference = (overrides: Partial<ResearchReference> = {}): ResearchReference => ({
  entryId: "research-synthetic",
  revision: 1,
  artifact,
  entry: entry(),
  ...overrides,
});

const links: OccurrenceClaimLink[] = [
  { occurrenceClaimId: claimA, normalisedClaimId: claimANormalised },
];

const projection = (overrides: Partial<Parameters<typeof buildDossierProjection>[0]> = {}) =>
  buildDossierProjection({
    themeId: "synthetic-theme",
    title: "Synthetic theme",
    scope: "A synthetic scope for tests.",
    updatedAt: "2026-02-12T00:00:00Z",
    references: [reference()],
    links,
    ...overrides,
  });

describe("buildDossierProjection", () => {
  it("projects settled external evidence into covered citations", () => {
    const built = projection();
    expect(built.metadata.claims).toEqual([
      {
        claimId: claimA,
        status: "covered",
        citations: [dossierCitationId({ ...reference(), evidence: external })],
      },
    ]);
    expect(built.metadata.citations).toHaveLength(1);
    expect(built.metadata.citations[0]).toMatchObject({
      url: external.url,
      title: external.title,
      passage: external.passage,
      sourceDate: external.publishedAt,
      checkedAt: external.lastCheckedAt,
    });
    expect(built.citations[0]).toMatchObject({
      entryId: "research-synthetic",
      revision: 1,
      entryArtifact: artifact,
    });
    expect(built.citations[0]!.evidence).toEqual(external);
  });

  it("keeps an occurrence a gap when only monitored evidence exists", () => {
    const built = projection({
      references: [
        reference({
          entry: entry({
            addressedClaims: [
              {
                claimId: claimANormalised,
                statement: "The synthetic council raised fees by 3%.",
                finding: "supported",
                evidence: [monitored],
              },
            ],
          }),
        }),
      ],
    });
    expect(built.metadata.claims[0]).toMatchObject({ claimId: claimA, status: "gap" });
    expect(built.metadata.claims[0]).not.toHaveProperty("citations");
    expect(built.metadata.citations).toEqual([]);
  });

  it("records an unresolved finding with its stated reason", () => {
    const built = projection({
      references: [
        reference({
          entry: entry({
            addressedClaims: [
              {
                claimId: claimANormalised,
                statement: "The synthetic council raised fees by 3%.",
                finding: "unresolved",
                unresolvedReason: "No synthetic source settles the figure.",
                evidence: [],
              },
            ],
          }),
        }),
      ],
    });
    expect(built.metadata.claims[0]).toEqual({
      claimId: claimA,
      status: "gap",
      reason: "No synthetic source settles the figure.",
    });
  });

  it("reuses canonical coverage for distinct occurrences through the mapping", () => {
    const built = projection({
      links: [
        { occurrenceClaimId: claimA, normalisedClaimId: claimANormalised },
        { occurrenceClaimId: claimB, normalisedClaimId: claimANormalised },
      ],
    });
    expect(built.metadata.claims).toHaveLength(2);
    const [first, second] = built.metadata.claims as Array<{
      claimId: string;
      status: "covered";
      citations: string[];
    }>;
    expect(first!.claimId).toBe(claimA);
    expect(second!.claimId).toBe(claimB);
    expect(second!.citations).toEqual(first!.citations);
  });

  it("rejects the same source version with conflicting provenance", () => {
    const later: EvidenceSource = { ...external, lastCheckedAt: "2026-03-01T00:00:00Z" };
    expect(() =>
      projection({
        references: [
          reference({
            entry: entry({
              addressedClaims: [
                {
                  claimId: claimANormalised,
                  statement: "The synthetic council raised fees by 3%.",
                  finding: "supported",
                  evidence: [external],
                },
                {
                  claimId: claimANormalised,
                  statement: "A synthetic second wording of the same claim.",
                  finding: "supported",
                  evidence: [later],
                },
              ],
            }),
          }),
        ],
      }),
    ).toThrow(/conflicting evidence provenance/);
  });

  it("deduplicates identical evidence cited by two claims", () => {
    const built = projection({
      references: [
        reference({
          entry: entry({
            addressedClaims: [
              {
                claimId: claimANormalised,
                statement: "The synthetic council raised fees by 3%.",
                finding: "supported",
                evidence: [external],
              },
              {
                claimId: claimANormalised,
                statement: "A synthetic second wording of the same claim.",
                finding: "contradicted",
                evidence: [external],
              },
            ],
          }),
        }),
      ],
    });
    expect(built.metadata.citations).toHaveLength(1);
  });

  it("rejects an unmapped claim, duplicate occurrence and malformed IDs", () => {
    expect(() =>
      projection({ links: [{ occurrenceClaimId: claimA, normalisedClaimId: claimB }] }),
    ).toThrow(DossierBridgeError);
    expect(() =>
      projection({
        links: [
          { occurrenceClaimId: claimA, normalisedClaimId: claimANormalised },
          { occurrenceClaimId: claimA, normalisedClaimId: claimANormalised },
        ],
      }),
    ).toThrow(/mapped twice/);
    expect(() =>
      projection({
        links: [{ occurrenceClaimId: "claim-1", normalisedClaimId: claimANormalised }],
      }),
    ).toThrow(/not a claim ID/);
  });
});

describe("dossier round trip", () => {
  it("survives Markdown serialisation and reconstructs the committed evidence", () => {
    const built = projection();
    const reparsed = parseDossier(
      renderDossier({ metadata: built.metadata, body: "Synthetic body." }),
    );
    const resolved = resolveDossier({
      metadata: reparsed.metadata,
      citations: built.citations,
      links: built.links,
    });
    const selected = selectedEvidenceForOccurrence(resolved, claimA);
    expect(selected).toEqual([
      {
        entryId: "research-synthetic",
        revision: 1,
        entryArtifact: artifact,
        evidence: external,
      },
    ]);
    expect(selected[0]!.evidence.artifact).toBeUndefined();
  });

  it("keeps a missing publication date missing instead of using the check date", () => {
    const undated = { ...external };
    delete (undated as { publishedAt?: string }).publishedAt;
    const built = projection({
      references: [
        reference({
          entry: entry({
            addressedClaims: [
              {
                claimId: claimANormalised,
                statement: "The synthetic council raised fees by 3%.",
                finding: "supported",
                evidence: [undated],
              },
            ],
          }),
        }),
      ],
    });
    expect(built.metadata.citations[0]).not.toHaveProperty("sourceDate");
    const resolved = resolveDossier({
      metadata: built.metadata,
      citations: built.citations,
      links: built.links,
    });
    expect(selectedEvidenceForOccurrence(resolved, claimA)[0]!.evidence).not.toHaveProperty(
      "publishedAt",
    );
  });

  it("returns no evidence for a gap claim", () => {
    const built = projection({
      references: [
        reference({
          entry: entry({
            addressedClaims: [
              {
                claimId: claimANormalised,
                statement: "The synthetic council raised fees by 3%.",
                finding: "unsupported",
                evidence: [],
              },
            ],
          }),
        }),
      ],
    });
    const resolved = resolveDossier({
      metadata: built.metadata,
      citations: built.citations,
      links: built.links,
    });
    expect(selectedEvidenceForOccurrence(resolved, claimA)).toEqual([]);
    expect(selectedEvidenceForOccurrence(resolved, claimA)).toHaveLength(0);
  });
});

describe("resolveDossier rejects broken references", () => {
  const built = () => projection();

  it("rejects a recorded citation with no committed evidence", () => {
    const { metadata } = built();
    expect(() => resolveDossier({ metadata, citations: [], links })).toThrow(
      /no committed evidence/,
    );
  });

  it("rejects evidence that is not cited by the dossier", () => {
    const { metadata, citations } = built();
    const stray: DossierCitationLink = {
      ...citations[0]!,
      citationId: "c-0000000000000000",
    };
    expect(() => resolveDossier({ metadata, citations: [citations[0]!, stray], links })).toThrow(
      /not cited/,
    );
  });

  it("rejects a citation whose text disagrees with the committed evidence", () => {
    const { metadata, citations } = built();
    const tampered = structuredClone(citations[0]!);
    tampered.evidence = { ...tampered.evidence, passage: "A different synthetic passage." };
    expect(() => resolveDossier({ metadata, citations: [tampered], links })).toThrow(
      /does not match its committed evidence/,
    );
  });

  it("rejects monitored material used as dossier coverage", () => {
    const { metadata, citations } = built();
    const promoted = structuredClone(citations[0]!);
    promoted.evidence = { ...monitored };
    expect(() => resolveDossier({ metadata, citations: [promoted], links })).toThrow(
      /monitored material/,
    );
  });

  it("rejects a link to a claim the dossier does not address", () => {
    const { metadata, citations } = built();
    expect(() =>
      resolveDossier({
        metadata,
        citations,
        links: [...links, { occurrenceClaimId: claimB, normalisedClaimId: claimANormalised }],
      }),
    ).toThrow(/does not address/);
  });
});

describe("researchCandidates", () => {
  it("builds assessor input from the cited committed revisions", () => {
    const built = projection();
    const resolved = resolveDossier({
      metadata: built.metadata,
      citations: built.citations,
      links: built.links,
    });
    const candidates = researchCandidates(resolved, [reference()]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      entryId: "research-synthetic",
      revision: 1,
      score: 0,
      question: entry().question,
      artifact,
    });
    expect(candidates[0]!.matches).toHaveLength(1);
    expect(candidates[0]!.matches[0]).toMatchObject({
      claimId: claimANormalised,
      finding: "supported",
    });
    expect(candidates[0]!.explanation.isEvidence).toBe(false);
    expect(candidates[0]!.limitations).toEqual(["Only synthetic sources were consulted."]);
  });

  it("refuses to assess an entry cited at more than one revision", () => {
    const second = reference({
      revision: 2,
      entry: entry({
        addressedClaims: [
          {
            claimId: claimANormalised,
            statement: "The synthetic council raised fees by 3%.",
            finding: "supported",
            evidence: [external],
          },
        ],
      }),
    });
    const built = projection({ references: [reference(), second] });
    expect(built.metadata.citations).toHaveLength(2);
    const resolved = resolveDossier({
      metadata: built.metadata,
      citations: built.citations,
      links: built.links,
    });
    expect(() => researchCandidates(resolved, [reference(), second])).toThrow(
      /cites revisions 1, 2 of research-synthetic; assess one revision/,
    );
  });

  it("keeps a missing research reference explicit", () => {
    const built = projection();
    const resolved = resolveDossier({
      metadata: built.metadata,
      citations: built.citations,
      links: built.links,
    });
    expect(() => researchCandidates(resolved, [])).toThrow(/is not supplied/);
  });
});

describe("traceBriefCitations", () => {
  it("maps dossier citation IDs to the brief's E IDs for the same source version", () => {
    const built = projection();
    const resolved = resolveDossier({
      metadata: built.metadata,
      citations: built.citations,
      links: built.links,
    });
    const brief = {
      citations: [
        {
          citationId: "E1",
          entryId: "research-synthetic",
          entryRevision: 1,
          entryArtifact: artifact,
          evidence: external,
        },
      ],
    } as DraftingBrief;
    expect(traceBriefCitations(resolved, brief)).toEqual([
      {
        citationId: dossierCitationId({ ...reference(), evidence: external }),
        briefCitationId: "E1",
      },
    ]);
    expect(citationTraceKey({ ...reference(), evidence: external })).toBe(
      citationTraceKey({ entryId: "research-synthetic", revision: 1, evidence: external }),
    );
    // An unrelated citation is not invented into the mapping.
    expect(
      traceBriefCitations(resolved, {
        citations: [{ ...brief.citations[0]!, entryId: "research-other" }],
      } as DraftingBrief),
    ).toEqual([]);
  });
});
