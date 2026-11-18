import { describe, expect, it } from "vite-plus/test";
import {
  CLAIM_SCHEMA_VERSION,
  InvalidClaimError,
  SYNTHETIC_CLAIM_EXAMPLES,
  SYNTHETIC_SOURCE_TEXT,
  claimIdFor,
  claimJsonSchema,
  createClaim,
  parseClaim,
} from "../../src/analysis/claim.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";

// Synthetic values only.
const source = {
  text: SYNTHETIC_SOURCE_TEXT,
  sourceVersion: sourceVersionFor(SYNTHETIC_SOURCE_TEXT),
};

const artifact = {
  repository: "synthetic-archive",
  commit: "0123456789abcdef0123456789abcdef01234567",
  path: "sources/synthetic/example.txt",
  hash: `sha256:${"cd".repeat(32)}`,
};

const extraction = {
  modelVersion: "synthetic-model-v1",
  promptVersion: "claim-extraction-v1",
  extractedAt: "2026-02-01T00:00:00Z",
};

const span = { start: 0, end: 63 };
const passage = SYNTHETIC_SOURCE_TEXT.slice(span.start, span.end);

const draft = () => ({
  statement: "A synthetic council may raise fees by 3%.",
  claimType: "ambiguous" as const,
  sourceVersion: source.sourceVersion,
  artifact,
  span,
  passage,
  qualifiers: ["may"],
  entities: ["synthetic council"],
  dates: [{ text: "last spring" }],
  extraction,
});

describe("createClaim", () => {
  it("builds a grounded claim with a derived ID", () => {
    const claim = createClaim(draft(), source);
    expect(claim.schemaVersion).toBe(CLAIM_SCHEMA_VERSION);
    expect(claim.id).toBe(
      claimIdFor({
        sourceVersion: source.sourceVersion,
        start: span.start,
        end: span.end,
        statement: draft().statement,
        modelVersion: extraction.modelVersion,
        promptVersion: extraction.promptVersion,
      }),
    );
    expect(claim.passage).toBe(passage);
    expect(claim.qualifiers).toEqual(["may"]);
    expect(claim.dates).toEqual([{ text: "last spring" }]);
    expect(parseClaim(claim, source)).toEqual(claim);
  });

  it("defaults the optional collections to empty", () => {
    const minimal = draft();
    const claim = createClaim(
      { ...minimal, qualifiers: undefined, entities: undefined, dates: undefined },
      source,
    );
    expect(claim.qualifiers).toEqual([]);
    expect(claim.entities).toEqual([]);
    expect(claim.dates).toEqual([]);
  });

  it("is idempotent for identical extractions and changes with the extractor", () => {
    const first = createClaim(draft(), source);
    expect(createClaim(draft(), source).id).toBe(first.id);
    const reExtracted = createClaim(
      { ...draft(), extraction: { ...extraction, promptVersion: "claim-extraction-v2" } },
      source,
    );
    expect(reExtracted.id).not.toBe(first.id);
  });

  it.each(["factual", "opinion", "prediction", "ambiguous"] as const)(
    "accepts claim type %s",
    (claimType) => {
      expect(createClaim({ ...draft(), claimType }, source).claimType).toBe(claimType);
    },
  );

  it("preserves qualifiers and vague date wording", () => {
    const claim = createClaim(
      { ...draft(), qualifiers: ["may", "according to"], dates: [{ text: "last spring" }] },
      source,
    );
    expect(claim.qualifiers).toEqual(["may", "according to"]);
    expect(claim.dates[0]).toEqual({ text: "last spring" });
    expect(claim.dates[0]).not.toHaveProperty("value");
  });

  it("accepts a normalised date when the passage is unambiguous", () => {
    const claim = createClaim(
      { ...draft(), dates: [{ text: "3 May 2026", value: "2026-05-03" }] },
      source,
    );
    expect(claim.dates[0]?.value).toBe("2026-05-03");
  });
});

describe("grounding failures", () => {
  it("rejects a fabricated passage", () => {
    expect(() =>
      parseClaim({ ...createClaim(draft(), source), passage: "A synthetic invention." }, source),
    ).toThrow(InvalidClaimError);
  });

  it("rejects a span that points at different text", () => {
    const claim = createClaim(draft(), source);
    expect(() => parseClaim({ ...claim, span: { start: 10, end: 73 } }, source)).toThrow(
      InvalidClaimError,
    );
  });

  it("rejects a span outside the source", () => {
    const claim = createClaim(draft(), source);
    expect(() =>
      parseClaim({ ...claim, span: { start: 0, end: SYNTHETIC_SOURCE_TEXT.length + 1 } }, source),
    ).toThrow(InvalidClaimError);
  });

  it("rejects an empty span", () => {
    const claim = createClaim(draft(), source);
    expect(() => parseClaim({ ...claim, span: { start: 4, end: 4 } }, source)).toThrow(
      InvalidClaimError,
    );
  });

  it("rejects a claim made against a different source version", () => {
    const claim = createClaim(draft(), source);
    expect(() =>
      parseClaim(claim, { text: SYNTHETIC_SOURCE_TEXT, sourceVersion: sourceVersionFor("other") }),
    ).toThrow(InvalidClaimError);
  });

  it("rejects a source whose stated version does not match its text", () => {
    expect(() =>
      parseClaim(createClaim(draft(), source), {
        text: SYNTHETIC_SOURCE_TEXT,
        sourceVersion: sourceVersionFor("different text"),
      }),
    ).toThrow(InvalidClaimError);
  });
});

describe("invalid structured output", () => {
  it.each([
    ["missing statement", { statement: undefined }],
    ["blank statement", { statement: "   " }],
    ["unknown claim type", { claimType: "certain" }],
    ["truth verdict", { verdict: "false" }],
    ["support flag", { supported: false }],
    ["missing extraction", { extraction: undefined }],
    ["missing prompt version", { extraction: { ...extraction, promptVersion: undefined } }],
    ["bad extraction time", { extraction: { ...extraction, extractedAt: "yesterday" } }],
    ["missing artifact", { artifact: undefined }],
    ["absolute artifact path", { artifact: { ...artifact, path: "/private/x.txt" } }],
    ["bad span type", { span: { start: "0", end: 63 } }],
    ["negative span", { span: { start: -1, end: 63 } }],
    ["missing passage", { passage: undefined }],
    ["qualifier not a string", { qualifiers: [1] }],
    ["bad date value", { dates: [{ text: "synthetic date", value: "3 May" }] }],
    ["missing schema version", { schemaVersion: undefined }],
    ["wrong schema version", { schemaVersion: 2 }],
  ])("rejects %s", (_name, patch) => {
    const claim = createClaim(draft(), source);
    expect(() => parseClaim({ ...claim, ...patch }, source)).toThrow(InvalidClaimError);
  });

  it("rejects non-object output without echoing it", () => {
    for (const input of [null, "claim", 42, []]) {
      try {
        parseClaim(input, source);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidClaimError);
        expect((error as Error).message).not.toContain("synthetic council");
      }
    }
  });
});

describe("JSON Schema and examples", () => {
  it("exports a strict schema covering every field", () => {
    const schema = claimJsonSchema() as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(
      [
        "artifact",
        "claimType",
        "dates",
        "entities",
        "extraction",
        "id",
        "passage",
        "qualifiers",
        "schemaVersion",
        "sourceVersion",
        "span",
        "statement",
      ].sort(),
    );
    expect(schema.required).not.toContain("verdict");
  });

  it("ships synthetic examples that validate against the synthetic source", () => {
    expect(SYNTHETIC_CLAIM_EXAMPLES).toHaveLength(2);
    for (const example of SYNTHETIC_CLAIM_EXAMPLES) {
      expect(() => parseClaim(example, source)).not.toThrow();
    }
  });
});
