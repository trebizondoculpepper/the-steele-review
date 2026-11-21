import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_RESEARCH_MODEL,
  ResearchModelSelectionSchema,
  researchModel,
} from "../../src/config/research-model.js";

describe("research model configuration", () => {
  it.each([undefined, "", " ", "\t\n"])("defaults absent/blank optional setting %j", (value) => {
    expect(researchModel({ STEELE_RESEARCH_MODEL: value })).toBe(DEFAULT_RESEARCH_MODEL);
  });
  it("uses a valid configured model and trims optional configuration", () => {
    expect(researchModel({ STEELE_RESEARCH_MODEL: " vendor/research " })).toBe("vendor/research");
  });
  it("lets the explicit CLI model win over configured or blank environment", () => {
    for (const configured of ["", "vendor/configured", "invalid model"])
      expect(researchModel({ STEELE_RESEARCH_MODEL: configured }, "vendor/explicit")).toBe(
        "vendor/explicit",
      );
  });
  it.each(["", " ", "invalid model", "model?query", "x".repeat(201)])(
    "rejects an invalid explicit override %j",
    (requested) => {
      expect(
        ResearchModelSelectionSchema.safeParse({ configured: "vendor/valid", requested }).success,
      ).toBe(false);
    },
  );
  it("does not silently replace invalid nonblank configuration", () => {
    expect(() => researchModel({ STEELE_RESEARCH_MODEL: "invalid model" })).toThrow();
  });
});
