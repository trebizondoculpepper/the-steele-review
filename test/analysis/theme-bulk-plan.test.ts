import { describe, expect, it } from "vite-plus/test";
import {
  normaliseThemeTitle,
  planThemeBulk,
  rankThemeFrequency,
  type SavedThemeExtraction,
} from "../../src/analysis/theme-bulk-plan.js";

// Synthetic corpus only.
const post = (postId: string) => ({ publicationId: "pub", postId });
const current = { modelVersion: "model-a", promptVersion: "themes-v2" };
const saved = (over: Partial<SavedThemeExtraction> = {}): SavedThemeExtraction => ({
  sourceVersion: `sha256:${"a".repeat(64)}`,
  processor: current,
  readable: true,
  titles: ["Weather modification"],
  ...over,
});

describe("theme-only bulk plan (#526)", () => {
  it("reuses compatible results, extracts missing ones and flags a different processor", () => {
    const plan = planThemeBulk({
      selection: [post("p1"), post("p2"), post("p3")],
      saved: new Map([
        ["pub/p1", saved()],
        ["pub/p2", saved({ processor: { modelVersion: "model-b", promptVersion: "themes-v2" } })],
      ]),
      current,
    });
    expect(plan.entries.map((e) => [e.postId, e.action])).toEqual([
      ["p1", "reuse"],
      ["p2", "incompatible"],
      ["p3", "extract"],
    ]);
    expect(plan.counts).toEqual({ reuse: 1, extract: 1, incompatible: 1 });
    expect(plan.truncated).toBe(false);
  });

  it("extracts when a saved result is unreadable rather than trusting it", () => {
    const plan = planThemeBulk({
      selection: [post("p1")],
      saved: new Map([["pub/p1", saved({ readable: false })]]),
      current,
    });
    expect(plan.entries[0]).toMatchObject({ action: "extract", reason: /unreadable/ });
  });

  it("bounds one pass and reports truncation instead of silently covering less", () => {
    const plan = planThemeBulk({
      selection: [post("p1"), post("p2"), post("p3")],
      saved: new Map(),
      current,
      limit: 2,
    });
    expect(plan.entries).toHaveLength(2);
    expect(plan.truncated).toBe(true);
  });

  it("ranks by distinct posts, not by proposal count", () => {
    const ranked = rankThemeFrequency([
      saved({ titles: ["Weather modification", "Weather modification", "Chemtrails"] }),
      saved({ titles: ["weather MODIFICATION!"] }),
      saved({ titles: ["Chemtrails"] }),
    ]);
    // Both appear in two posts; the tie is broken by key, not by proposal count.
    expect(ranked.map((r) => [r.key, r.postCount])).toEqual([
      ["chemtrails", 2],
      ["weather modification", 2],
    ]);
    // Every saved wording is kept, most common first.
    expect(ranked[1]!.titles[0]).toBe("Weather modification");
  });

  it("ignores unreadable results and normalises titles consistently", () => {
    expect(normaliseThemeTitle("  Weather   MODIFICATION!! ")).toBe("weather modification");
    const ranked = rankThemeFrequency([saved({ readable: false })]);
    expect(ranked).toEqual([]);
  });
});
