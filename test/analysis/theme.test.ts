import { describe, expect, it } from "vite-plus/test";
import {
  InvalidThemeError,
  SYNTHETIC_THEME_SOURCE_TEXT as TEXT,
  THEME_SCHEMA_VERSION,
  normaliseThemeLabel,
  parseThemeSet,
  themeSetJsonSchema,
} from "../../src/analysis/theme.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";

const artifact = {
  repository: "synthetic-archive",
  commit: "0123456789abcdef0123456789abcdef01234567",
  path: "substack/example-pub/a-post/collected.json",
  hash: `sha256:${"cd".repeat(32)}`,
};
const source = { text: TEXT, sourceVersion: sourceVersionFor(TEXT), artifact };
const span = (passage: string) => {
  const start = TEXT.indexOf(passage);
  return { start, end: start + passage.length, passage };
};

const set = (themes: unknown[]) => ({
  schemaVersion: THEME_SCHEMA_VERSION,
  sourceVersion: source.sourceVersion,
  artifact,
  themes,
  extraction: {
    modelVersion: "synthetic-model-v1",
    promptVersion: "themes-v1",
    extractedAt: "2026-03-01T00:00:00Z",
  },
});
const surveillance = {
  label: "mass surveillance",
  wording: "Mass Surveillance",
  confidence: "high",
  evidence: [span("The synthetic towers are watching everyone.")],
};
const consent = {
  label: "consent and democracy",
  wording: "Consent & democracy",
  confidence: "low",
  evidence: [span("Nobody voted for the new synthetic meters.")],
};

describe("normaliseThemeLabel", () => {
  it.each([
    ["  Mass   Surveillance ", "mass surveillance"],
    ["Consent & democracy", "consent and democracy"],
    ["5G / EMF—weapons!", "5g emf weapons"],
    ["--anti-vaccine--", "anti-vaccine"],
    ["one two three four five six seven", "one two three four five six"],
    ["!!!", ""],
  ])("normalises %j to %j", (input, expected) => {
    expect(normaliseThemeLabel(input)).toBe(expected);
  });
});

describe("parseThemeSet", () => {
  it("accepts grounded themes with uncertainty, including new labels", () => {
    const parsed = parseThemeSet(set([surveillance, consent]), source);
    expect(parsed.themes.map((t) => t.label)).toEqual([
      "mass surveillance",
      "consent and democracy",
    ]);
    expect(parsed.themes[1]!.confidence).toBe("low");
  });

  it("checks the novel flag against a supplied vocabulary", () => {
    const known = new Set(["mass surveillance"]);
    expect(
      parseThemeSet(
        set([
          { ...surveillance, novel: false },
          { ...consent, novel: true },
        ]),
        source,
        known,
      ).themes.map((t) => t.novel),
    ).toEqual([false, true]);
    expect(() => parseThemeSet(set([{ ...surveillance, novel: true }]), source, known)).toThrow(
      "novel flag",
    );
    expect(() => parseThemeSet(set([{ ...surveillance, novel: true }]), source)).toThrow(
      "novel flag",
    );
  });

  it.each([
    ["missing evidence", [{ ...surveillance, evidence: [] }], "structure"],
    [
      "mismatched passage",
      [
        {
          ...surveillance,
          evidence: [{ ...span("The synthetic towers"), passage: "The real towers" }],
        },
      ],
      "does not match",
    ],
    [
      "span outside text",
      [{ ...surveillance, evidence: [{ start: 0, end: TEXT.length + 5, passage: TEXT }] }],
      "outside",
    ],
    ["unnormalised label", [{ ...surveillance, label: "Mass Surveillance" }], "normalised"],
    [
      "duplicate label",
      [surveillance, { ...surveillance, wording: "mass surveillance" }],
      "duplicate",
    ],
    ["verdict field", [{ ...surveillance, verdict: "false" }], "structure"],
    ["truth field", [{ ...surveillance, isTrue: false }], "structure"],
  ])("rejects %s", (_name, themes, message) => {
    expect(() => parseThemeSet(set(themes), source)).toThrow(message);
  });

  it("rejects a set for a different source version or artifact", () => {
    expect(() =>
      parseThemeSet({ ...set([surveillance]), sourceVersion: sourceVersionFor("other") }, source),
    ).toThrow("source version");
    expect(() =>
      parseThemeSet(
        { ...set([surveillance]), artifact: { ...artifact, commit: "f".repeat(40) } },
        source,
      ),
    ).toThrow("artifact");
  });

  it("does not echo source or model text in errors", () => {
    try {
      parseThemeSet(set([{ ...surveillance, label: "Secret Words" }]), source);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidThemeError);
      expect((error as Error).message).not.toMatch(/Secret|towers/);
    }
  });
});

describe("themeSetJsonSchema", () => {
  it("exports a strict schema with no verdict field", () => {
    const schema = themeSetJsonSchema() as {
      properties: {
        themes: { items: { properties: Record<string, unknown>; additionalProperties: boolean } };
      };
    };
    const theme = schema.properties.themes.items;
    expect(Object.keys(theme.properties).sort()).toEqual([
      "confidence",
      "evidence",
      "label",
      "novel",
      "wording",
    ]);
    expect(theme.additionalProperties).toBe(false);
  });
});
