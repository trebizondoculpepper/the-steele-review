import { describe, expect, it } from "vite-plus/test";
import {
  InvalidResearchEntryError,
  RESEARCH_ENTRY_SCHEMA_VERSION,
  parseResearchEntry,
  researchEntryJsonSchema,
} from "../../src/research/research-entry.js";

// Synthetic values only.
const external = {
  kind: "external" as const,
  url: "https://evidence.example.org/synthetic-report",
  title: "Synthetic evidence report",
  publisher: "Synthetic Evidence Bureau",
  publishedAt: "2026-01-05T00:00:00Z",
  retrievedAt: "2026-02-01T00:00:00Z",
  lastCheckedAt: "2026-02-10T00:00:00Z",
  passage: "A synthetic report states the synthetic figure was 3%.",
  artifact: {
    repository: "synthetic-archive",
    commit: "0123456789abcdef0123456789abcdef01234567",
    path: "research/example/report.txt",
    hash: `sha256:${"ef".repeat(32)}`,
  },
};

const monitored = {
  kind: "monitored" as const,
  url: "https://example-pub.substack.com/p/a-synthetic-post",
  title: "A synthetic post",
  retrievedAt: "2026-02-01T00:00:00Z",
  lastCheckedAt: "2026-02-10T00:00:00Z",
  passage: "The synthetic council said it may raise fees by 3%.",
};

const entry = () => ({
  schemaVersion: RESEARCH_ENTRY_SCHEMA_VERSION,
  question: "Did the synthetic council raise fees by 3%?",
  addressedClaims: [
    {
      claimId: `sha256:${"12".repeat(32)}`,
      statement: "The synthetic council raised fees by 3%.",
      finding: "supported" as const,
      evidence: [external, monitored],
    },
  ],
  explanation: {
    text: "A synthetic explanation of why the report supports the claim.",
    generatedBy: "synthetic-model-v1",
  },
  limitations: ["Only synthetic sources were consulted."],
  unresolvedGaps: [],
  provenance: {
    modelVersion: "synthetic-model-v1",
    promptVersion: "research-v1",
    createdAt: "2026-02-11T00:00:00Z",
  },
});

describe("parseResearchEntry", () => {
  it("accepts a complete entry and keeps kinds distinguishable", () => {
    const parsed = parseResearchEntry(entry());
    const claim = parsed.addressedClaims[0]!;
    expect(claim.evidence.map((source) => source.kind)).toEqual(["external", "monitored"]);
    expect(claim.finding).toBe("supported");
    expect(parsed.explanation.generatedBy).toBe("synthetic-model-v1");
    expect(parsed.schemaVersion).toBe(RESEARCH_ENTRY_SCHEMA_VERSION);
  });

  it("accepts an unsupported finding with no evidence", () => {
    const input = entry();
    input.addressedClaims[0]!.finding = "unsupported";
    input.addressedClaims[0]!.evidence = [];
    expect(parseResearchEntry(input).addressedClaims[0]?.finding).toBe("unsupported");
  });

  it("accepts an unresolved finding with an explicit reason and records the gap", () => {
    const input = entry();
    input.addressedClaims[0]!.finding = "unresolved";
    input.addressedClaims[0]!.evidence = [];
    input.addressedClaims[0] = {
      ...input.addressedClaims[0]!,
      unresolvedReason: "No synthetic source settles the figure.",
    } as never;
    input.unresolvedGaps = ["The exact synthetic figure remains unchecked."];
    const parsed = parseResearchEntry(input);
    expect(parsed.addressedClaims[0]?.unresolvedReason).toContain("synthetic source");
    expect(parsed.unresolvedGaps).toHaveLength(1);
  });

  it("accepts evidence without optional dates or an archive reference", () => {
    const input = entry();
    const { publishedAt: _p, artifact: _a, ...bare } = external;
    input.addressedClaims[0]!.evidence = [bare];
    expect(() => parseResearchEntry(input)).not.toThrow();
  });
});

describe("required evidence for conclusions", () => {
  it.each(["supported", "contradicted"] as const)(
    "rejects a %s finding backed only by the monitored source",
    (finding) => {
      const input = entry();
      input.addressedClaims[0]!.finding = finding;
      input.addressedClaims[0]!.evidence = [monitored];
      expect(() => parseResearchEntry(input)).toThrow(InvalidResearchEntryError);
    },
  );

  it.each(["supported", "contradicted"] as const)(
    "rejects a %s finding with no evidence",
    (finding) => {
      const input = entry();
      input.addressedClaims[0]!.finding = finding;
      input.addressedClaims[0]!.evidence = [];
      expect(() => parseResearchEntry(input)).toThrow(InvalidResearchEntryError);
    },
  );

  it("rejects an unresolved finding with no reason", () => {
    const input = entry();
    input.addressedClaims[0]!.finding = "unresolved";
    input.addressedClaims[0]!.evidence = [];
    expect(() => parseResearchEntry(input)).toThrow(InvalidResearchEntryError);
  });
});

describe("dates and references", () => {
  it("rejects a last-checked time before retrieval", () => {
    const input = entry();
    input.addressedClaims[0]!.evidence = [
      { ...external, retrievedAt: "2026-02-10T00:00:00Z", lastCheckedAt: "2026-02-01T00:00:00Z" },
    ];
    expect(() => parseResearchEntry(input)).toThrow(InvalidResearchEntryError);
  });

  it("rejects a publication date after the last check", () => {
    const input = entry();
    input.addressedClaims[0]!.evidence = [
      { ...external, publishedAt: "2026-03-01T00:00:00Z", lastCheckedAt: "2026-02-10T00:00:00Z" },
    ];
    expect(() => parseResearchEntry(input)).toThrow(InvalidResearchEntryError);
  });

  it("rejects missing retrieval or last-checked dates", () => {
    for (const field of ["retrievedAt", "lastCheckedAt"] as const) {
      const input = entry();
      const evidence: Record<string, unknown> = { ...external };
      delete evidence[field];
      input.addressedClaims[0]!.evidence = [evidence as never];
      expect(() => parseResearchEntry(input)).toThrow(InvalidResearchEntryError);
    }
  });

  it("rejects a non-HTTPS or malformed evidence URL", () => {
    for (const url of ["http://evidence.example.org/x", "evidence.example.org/x", "not a url"]) {
      const input = entry();
      input.addressedClaims[0]!.evidence = [{ ...external, url }];
      expect(() => parseResearchEntry(input)).toThrow(InvalidResearchEntryError);
    }
  });

  it("rejects an invalid archive reference", () => {
    const input = entry();
    input.addressedClaims[0]!.evidence = [
      { ...external, artifact: { ...external.artifact, path: "/private/report.txt" } },
    ];
    expect(() => parseResearchEntry(input)).toThrow(InvalidResearchEntryError);
  });

  it("rejects a malformed claim ID", () => {
    const input = entry();
    input.addressedClaims[0]!.claimId = "claim-1";
    expect(() => parseResearchEntry(input)).toThrow(InvalidResearchEntryError);
  });
});

describe("generated explanation and structure", () => {
  it("rejects a bare explanation string so generated prose stays labelled", () => {
    const input = entry() as Record<string, unknown>;
    input.explanation = "An unlabelled string.";
    expect(() => parseResearchEntry(input)).toThrow(InvalidResearchEntryError);
  });

  it("rejects an explanation without the generating model", () => {
    const input = entry();
    (input.explanation as Record<string, unknown>).generatedBy = undefined;
    expect(() => parseResearchEntry(input)).toThrow(InvalidResearchEntryError);
  });

  it.each([
    ["unknown source kind", { evidence: [{ ...external, kind: "secondary" }] }],
    ["unknown finding", { finding: "true" }],
    ["blank statement", { statement: "  " }],
    ["empty evidence passage", { evidence: [{ ...external, passage: "" }] }],
    ["unknown evidence field", { evidence: [{ ...external, confidence: 0.9 }] }],
  ])("rejects %s", (_name, patch) => {
    const input = entry();
    Object.assign(input.addressedClaims[0]!, patch);
    expect(() => parseResearchEntry(input)).toThrow(InvalidResearchEntryError);
  });

  it("rejects an entry without addressed claims or provenance", () => {
    const noClaims = entry();
    noClaims.addressedClaims = [];
    expect(() => parseResearchEntry(noClaims)).toThrow(InvalidResearchEntryError);

    const noProvenance = entry() as Record<string, unknown>;
    delete noProvenance.provenance;
    expect(() => parseResearchEntry(noProvenance)).toThrow(InvalidResearchEntryError);
  });

  it("rejects non-object input without echoing it", () => {
    for (const input of [null, "entry", 42]) {
      try {
        parseResearchEntry(input);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidResearchEntryError);
        expect((error as Error).message).not.toContain("synthetic council");
      }
    }
  });
});

describe("JSON Schema export", () => {
  it("exports a strict, versioned schema", () => {
    const schema = researchEntryJsonSchema() as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual([
      "addressedClaims",
      "explanation",
      "limitations",
      "provenance",
      "question",
      "schemaVersion",
      "unresolvedGaps",
    ]);
    expect(schema.required).toContain("addressedClaims");
    const version = schema.properties.schemaVersion as { const?: number };
    expect(version.const).toBe(RESEARCH_ENTRY_SCHEMA_VERSION);
  });
});
