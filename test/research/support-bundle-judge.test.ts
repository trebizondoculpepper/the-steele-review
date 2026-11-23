import { describe, expect, it } from "vite-plus/test";
import { ModelSupportJudge } from "../../src/research/support-judge.js";
import { bundleExcerpt } from "../../src/research/runner.js";

const provider = (answer: string) => {
  const seen: { system: string; user: string }[] = [];
  return {
    seen,
    modelVersion: "fake/m",
    complete: async (req: { system: string; user: string }) => {
      seen.push(req);
      return answer;
    },
  };
};
const input = {
  findings: [{ id: "f1", statement: "Masts emit radiation above limits" }],
  report: "Report text.",
  sources: [{ index: 0, url: "https://a.example/x", excerpt: "Excerpt about masts." }],
};
const signal = new AbortController().signal;

describe("bundle support judge (#795)", () => {
  it("sends one prompt with every source and parses ranked hints", async () => {
    const p = provider(
      'Here: {"sources":[{"index":0,"relevance":1,"note":"Key","passages":[{"findingId":"f1","passage":"about masts"}]}],"brief":"Use source 0."}',
    );
    const out = await new ModelSupportJudge(p as never).judgeBundle(input, signal);
    expect(p.seen).toHaveLength(1);
    expect(p.seen[0]!.user).toContain("Source 0 (https://a.example/x):");
    expect(out).toEqual({
      sources: [
        {
          index: 0,
          relevance: 1,
          note: "Key",
          passages: [{ findingId: "f1", passage: "about masts" }],
        },
      ],
      brief: "Use source 0.",
    });
  });

  it("treats a malformed answer as a failed call, never as support", async () => {
    await expect(
      new ModelSupportJudge(provider("not json") as never).judgeBundle(input, signal),
    ).rejects.toThrow();
  });

  it("keeps short sources whole and windows long ones around finding words", () => {
    expect(bundleExcerpt("short", input.findings, 3)).toBe("short");
    const long = "x ".repeat(10_000) + "the masts radiation reading" + " y".repeat(10_000);
    const ex = bundleExcerpt(long, input.findings, 20);
    expect(ex.length).toBeLessThanOrEqual(2_500);
    expect(ex).toContain("masts radiation");
  });
});
