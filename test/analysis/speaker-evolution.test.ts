import { describe, expect, it } from "vite-plus/test";
import { normalisedClaimKey, type ClaimOccurrence } from "../../src/analysis/claim-occurrence.js";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";
import type {
  SameSpeakerHistory,
  SameSpeakerMatch,
} from "../../src/analysis/same-speaker-history.js";
import { explainSpeakerEvolution, patternOf } from "../../src/analysis/speaker-evolution.js";

const h = (c: string) => `sha256:${c.repeat(64)}`;
const ref = (p: string) => ({
  repository: "archive",
  commit: "a".repeat(40),
  path: `${p}.json`,
  hash: h("e"),
});
const NAME = "Dr Synthetic";
const CURRENT_PASSAGE = `${NAME} said the masts are weakening immunity, and the council's own survey proves it.`;

const current: ClaimOccurrence = {
  schemaVersion: 1,
  occurrenceId: h("1"),
  grouping: {
    key: normalisedClaimKey("masts weaken immunity"),
    method: "normalised-text",
    version: "1",
  },
  publicationId: "pub",
  postId: "now",
  url: "https://pub.substack.com/p/now",
  claimId: h("c"),
  statement: "Phone masts weaken people's immunity.",
  claimType: "factual",
  qualifiers: [],
  passage: CURRENT_PASSAGE,
  span: { start: 0, end: CURRENT_PASSAGE.length },
  sourceVersion: h("d"),
  artifact: ref("now"),
  sourcePublishedAt: "2026-06-01T00:00:00Z",
  assertionDates: [],
  themes: ["5g"],
  publisher: { publicationId: "pub" },
  speaker: { kind: "quoted", name: NAME, evidence: { start: 0, end: NAME.length } },
  extraction: { modelVersion: "m", promptVersion: "p", extractedAt: "2026-06-01T00:00:00Z" },
};

const match = (post: string, publishedAt: string, quote: string): SameSpeakerMatch => ({
  occurrenceId: h(post[0]!),
  postId: post,
  publicationId: "pub",
  url: `https://pub.substack.com/p/${post}`,
  publishedAt,
  speaker: { name: NAME, basis: "named-speaker" },
  quote,
  statement: quote,
  artifact: ref(post),
  sourceVersion: h("f"),
  matchedBy: "model",
});
const REPEAT = "the masts are weakening immunity";
const RETOLD = "the masts were switched on to weaken immunity, and a whistleblower confirmed it";
const LOOSE = "the masts are ugly and nobody asked for them";
const history = (...m: SameSpeakerMatch[]): SameSpeakerHistory => ({
  outcome: "matches",
  speaker: { name: NAME, basis: "named-speaker" },
  matches: m,
  diagnostics: {
    candidates: m.length,
    excludedUndated: 0,
    excludedReposts: 0,
    rejectedByModel: 0,
    invalidDocuments: 0,
    note: "",
  },
});
const fixture = history(
  match("b-2026", "2026-02-01T00:00:00Z", REPEAT),
  match("a-2025", "2025-03-01T00:00:00Z", RETOLD),
  match("c-loose", "2026-03-01T00:00:00Z", LOOSE),
);

const model = (answer: unknown): ExtractionModelProvider => ({
  modelVersion: "test/model",
  async complete() {
    return typeof answer === "string" ? answer : JSON.stringify(answer);
  },
});

const finding = (o: Record<string, unknown>) => ({
  aspects: {},
  explanation: "Interpretation.",
  uncertainty: "low",
  ...o,
});

describe("explainSpeakerEvolution (#369)", () => {
  it("orders repetition and a changed retelling by date with pinned quotes", async () => {
    const r = await explainSpeakerEvolution({
      occurrence: current,
      history: fixture,
      provider: model({
        findings: [
          finding({ kind: "repetition", earlierId: "e2", earlierQuote: REPEAT }),
          finding({
            kind: "substantive-change",
            earlierId: "e1",
            earlierQuote: RETOLD,
            currentQuote: "the council's own survey proves it",
            aspects: {
              mechanism: { status: "same" },
              proof: { status: "changed", note: "Whistleblower earlier; council survey now." },
            },
          }),
          finding({ kind: "reframing", earlierId: "e3", earlierQuote: LOOSE, uncertainty: "high" }),
        ],
      }),
    });
    expect(r.status).toBe("complete");
    expect(r.timeline.map((t) => t.postId)).toEqual(["a-2025", "b-2026", "c-loose"]);
    expect(r.findings.map((f) => [f.kind, f.earlier.postId])).toEqual([
      ["substantive-change", "a-2025"],
      ["repetition", "b-2026"],
      ["reframing", "c-loose"],
    ]);
    const changed = r.findings[0]!;
    expect(changed.aspects.proof).toEqual({
      status: "changed",
      note: "Whistleblower earlier; council survey now.",
    });
    expect(changed.earlier).toMatchObject({
      quote: RETOLD,
      publishedAt: "2025-03-01T00:00:00Z",
      artifact: { path: "a-2025.json" },
    });
    expect(changed.current.quote).toBe("the council's own survey proves it");
    // Interpretation is separate from the quoted evidence.
    expect(changed.explanation).toEqual({
      text: "Interpretation.",
      generatedBy: "test/model",
      isEvidence: false,
    });
    expect(r.pattern).toBe("recurring");
  });

  it("does not report one weak match as a pattern", async () => {
    const r = await explainSpeakerEvolution({
      occurrence: current,
      history: history(match("c-loose", "2026-03-01T00:00:00Z", LOOSE)),
      provider: model({
        findings: [
          finding({ kind: "reframing", earlierId: "e1", earlierQuote: LOOSE, uncertainty: "high" }),
        ],
      }),
    });
    expect(r.pattern).toBe("none");
    expect(r.findings).toHaveLength(1);
  });

  it("calls a single confident match a single comparison, not a pattern", () => {
    const f = { kind: "repetition", uncertainty: "low", earlier: { postId: "x" } } as never;
    expect(patternOf([f])).toBe("single-comparison");
    expect(patternOf([f, f])).toBe("single-comparison");
  });

  it("rejects reversals without both quotes and a circumstances check, and invented quotes", async () => {
    const r = await explainSpeakerEvolution({
      occurrence: current,
      history: fixture,
      provider: model({
        findings: [
          finding({
            kind: "possible-reversal",
            earlierId: "e2",
            earlierQuote: REPEAT,
            currentQuote: "the masts are weakening immunity",
          }),
          finding({ kind: "repetition", earlierId: "e1", earlierQuote: "masts cause cancer" }),
          finding({ kind: "repetition", earlierId: "e9", earlierQuote: REPEAT }),
        ],
      }),
    });
    expect(r.status).toBe("incomplete");
    expect(r.findings).toHaveLength(0);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      "unsupported-reversal",
      "invalid-citation",
      "invalid-citation",
    ]);
  });

  it("needs no model call when there is no history, and reports provider failure", async () => {
    let calls = 0;
    const counting: ExtractionModelProvider = {
      modelVersion: "m",
      async complete() {
        calls++;
        return "{}";
      },
    };
    const none = await explainSpeakerEvolution({
      occurrence: current,
      history: history(),
      provider: counting,
    });
    expect(none).toMatchObject({ status: "no-history", pattern: "none" });
    expect(calls).toBe(0);
    const failed = await explainSpeakerEvolution({
      occurrence: current,
      history: fixture,
      provider: model("not json"),
    });
    expect(failed).toMatchObject({ status: "failed", failure: "malformed-output" });
  });
});
