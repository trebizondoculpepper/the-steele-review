import { describe, expect, it } from "vite-plus/test";
import { recoverPassage } from "../../src/analysis/extraction.js";

const SOURCE =
  "Speaker one:  the Treaty bans hostile weather modification.\nIt was signed in 1977 and it is not a hoax.";

describe("formatting-tolerant passage recovery (#202)", () => {
  it("keeps exact matches exact", () => {
    expect(recoverPassage(SOURCE, "signed in 1977")).toMatchObject({
      method: "exact",
      text: "signed in 1977",
    });
  });

  it("recovers case, whitespace and typographic differences and saves the unchanged source text", () => {
    const m = recoverPassage(SOURCE, "The treaty bans hostile weather modification.");
    expect(m).toMatchObject({
      method: "formatting",
      text: "the Treaty bans hostile weather modification.",
    });
    const n = recoverPassage(SOURCE, "it is not a hoax.");
    expect(n).toMatchObject({ method: "exact" });
    const spaced = recoverPassage(SOURCE, "Speaker one: the treaty");
    expect(spaced).toMatchObject({ method: "formatting", text: "Speaker one:  the Treaty" });
    const curly = recoverPassage("He said “it’s a hoax” today.", '"it\'s a hoax"');
    expect(curly).toMatchObject({ method: "formatting", text: "“it’s a hoax”" });
    if (typeof m !== "string") expect(SOURCE.slice(m.start, m.end)).toBe(m.text);
  });

  it("never accepts changed words, numbers or negation", () => {
    expect(recoverPassage(SOURCE, "the treaty allows hostile weather modification.")).toBe(
      "absent",
    );
    expect(recoverPassage(SOURCE, "signed in 1978")).toBe("absent");
    expect(recoverPassage(SOURCE, "it is a hoax.")).toBe("absent");
  });

  it("keeps repeated formatting-only matches ambiguous", () => {
    expect(recoverPassage("The Plan. the plan.", "THE PLAN.")).toBe("ambiguous");
  });
});
