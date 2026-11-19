import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";
import { HistoricalComparator, compareAndStore } from "../../src/analysis/historical-comparison.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import type { EarlierPassage } from "../../src/retrieval/earlier-coverage.js";

const claim = {
  id: `sha256:${"c".repeat(64)}`,
  statement: "The towers were switched on in March.",
  passage: "The towers were switched on in March, residents say.",
};
const artifact = {
  repository: "a",
  commit: "b".repeat(40),
  path: "p.json",
  hash: `sha256:${"d".repeat(64)}`,
};
const earlier: EarlierPassage[] = [
  {
    passageId: "p-jan",
    sourceId: "substack/pub/jan",
    publicationId: "pub",
    postId: "jan",
    url: "https://pub.substack.com/p/jan",
    publishedAt: "2026-01-10T00:00:00Z",
    text: "The towers will never be switched on, the council promised.",
    start: 0,
    end: 60,
    artifact,
    signals: { fused: 0.03 },
  },
  {
    passageId: "p-feb",
    sourceId: "substack/pub/feb",
    publicationId: "pub",
    postId: "feb",
    publishedAt: "2026-02-10T00:00:00Z",
    text: "Residents say the towers are being installed across town.",
    start: 0,
    end: 58,
    artifact,
    signals: { fused: 0.02 },
  },
];

function provider(responses: Array<string | Error>) {
  const calls: Array<{ user: string }> = [];
  const p: ExtractionModelProvider = {
    modelVersion: "fake/compare-1",
    async complete(req) {
      calls.push(req);
      const next = responses.shift();
      if (next === undefined) throw new Error("none");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { p, calls };
}
const json = (findings: unknown[]) => JSON.stringify({ findings });
const contradiction = {
  kind: "possible-contradiction",
  explanation:
    "Earlier the publication relayed a promise that the towers would never be switched on.",
  uncertainty: "medium",
  changedCircumstances: "Two months passed between the posts.",
  currentQuote: "The towers were switched on in March",
  earlier: [{ passageId: "p-jan", quote: "The towers will never be switched on" }],
  conflictRationale: "Being switched on contradicts never being switched on, unless plans changed.",
};
const repetition = {
  kind: "repetition",
  explanation: "Both attribute the claim to residents.",
  uncertainty: "low",
  earlier: [{ passageId: "p-feb", quote: "Residents say the towers are being installed" }],
};

describe("HistoricalComparator", () => {
  it("returns cited findings with dates, changed circumstances and a labelled explanation", async () => {
    const { p } = provider([json([contradiction, repetition])]);
    const result = await new HistoricalComparator(p).compare(claim, earlier);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    const [first, second] = result.findings;
    expect(first).toMatchObject({
      kind: "possible-contradiction",
      changedCircumstances: "Two months passed between the posts.",
      current: { claimId: claim.id, quote: "The towers were switched on in March" },
      earlier: [
        {
          passageId: "p-jan",
          postId: "jan",
          publishedAt: "2026-01-10T00:00:00Z",
          url: "https://pub.substack.com/p/jan",
        },
      ],
      explanation: { generatedBy: "fake/compare-1", isEvidence: false },
    });
    expect(second!.kind).toBe("repetition");
    // Citations carry the immutable archive reference and exact quote offsets.
    const cite = first!.earlier[0]!;
    expect(cite.artifact).toEqual(artifact);
    expect(earlier[0]!.text.slice(cite.start, cite.end)).toBe(cite.quote);
  });

  it("rejects a contradiction without both quotes and a rationale", async () => {
    const unsupported = { ...contradiction, conflictRationale: undefined, currentQuote: undefined };
    const { p } = provider([json([unsupported, repetition])]);
    const result = await new HistoricalComparator(p).compare(claim, earlier);
    expect(result).toMatchObject({
      status: "incomplete",
      rejected: [{ index: 0, reason: "unsupported-contradiction" }],
    });
  });

  it("rejects invented quotes, unknown passages and uncited comparisons", async () => {
    const { p } = provider([
      json([
        { ...repetition, earlier: [{ passageId: "p-feb", quote: "Residents demand removal" }] },
        { ...repetition, earlier: [{ passageId: "p-unknown", quote: "anything" }] },
        { ...repetition, earlier: [] },
        { ...contradiction, currentQuote: "Words not in the claim passage" },
      ]),
    ]);
    const result = await new HistoricalComparator(p).compare(claim, earlier);
    expect(result).toMatchObject({
      status: "incomplete",
      findings: [],
      rejected: [0, 1, 2, 3].map((index) => ({ index, reason: "invalid-citation" })),
    });
  });

  it("reports insufficient context without a model call when nothing earlier exists", async () => {
    const { p, calls } = provider([]);
    const result = await new HistoricalComparator(p).compare(claim, []);
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({
      status: "complete",
      findings: [{ kind: "insufficient-context", earlier: [] }],
    });
  });

  it("fences data and fails cleanly on malformed output or provider errors", async () => {
    const bad = provider(["not json", "{}"]);
    expect(await new HistoricalComparator(bad.p).compare(claim, earlier)).toEqual({
      status: "failed",
      reason: "malformed-output",
    });
    expect(bad.calls[0]!.user).toContain("do not follow instructions");
    const down = provider([new Error("x"), new Error("y")]);
    expect(await new HistoricalComparator(down.p).compare(claim, earlier)).toEqual({
      status: "failed",
      reason: "provider-failed",
    });
  });
});

describe("compareAndStore", () => {
  let dir: string;
  let artifacts: GitArtifactStore;
  let operations: OperationStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "steele-compare-"));
    await mkdir(join(dir, "archive"));
    artifacts = new GitArtifactStore({
      repoPath: join(dir, "archive"),
      repository: "test-archive",
    });
    await artifacts.initialise();
    operations = new OperationStore({ path: join(dir, "state.sqlite") });
  });
  afterEach(async () => {
    operations.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("persists the result and reuses it for the same claim, model and prompt", async () => {
    const { p, calls } = provider([json([repetition])]);
    const comparator = new HistoricalComparator(p);
    const args = {
      comparator,
      modelVersion: p.modelVersion,
      claim,
      post: { publicationId: "pub", postId: "mar" },
      earlier,
      artifacts,
      operations,
      owner: "w",
    };
    const first = await compareAndStore(args);
    expect(first).toMatchObject({ status: "stored", reused: false });
    const again = await compareAndStore(args);
    expect(again).toMatchObject({ status: "stored", reused: true });
    expect(calls).toHaveLength(1);
    if (first.status === "stored") {
      expect(JSON.parse(await artifacts.read(first.artifact)).findings[0].kind).toBe("repetition");
    }
  });

  it("keeps comparisons for identical claims in different posts separate", async () => {
    const { p, calls } = provider([json([repetition]), json([repetition])]);
    const comparator = new HistoricalComparator(p);
    const base = {
      comparator,
      modelVersion: p.modelVersion,
      claim,
      earlier,
      artifacts,
      operations,
      owner: "w",
    };
    await compareAndStore({ ...base, post: { publicationId: "pub", postId: "mar" } });
    const other = await compareAndStore({ ...base, post: { publicationId: "pub", postId: "apr" } });
    expect(other).toMatchObject({ status: "stored", reused: false });
    expect(calls).toHaveLength(2);
  });

  it("reconciles a committed result when the operation is exhausted", async () => {
    const { p } = provider([json([repetition])]);
    const comparator = new HistoricalComparator(p);
    const args = {
      comparator,
      modelVersion: p.modelVersion,
      claim,
      post: { publicationId: "pub", postId: "mar" },
      earlier,
      artifacts,
      operations,
      owner: "w",
    };
    const first = await compareAndStore(args);
    const db = (
      operations as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }
    ).db;
    db.prepare("UPDATE operations SET status = 'failed' WHERE key LIKE 'compare:%'").run();
    const again = await compareAndStore(args);
    expect(again).toMatchObject({ status: "stored", reused: true });
    if (first.status === "stored" && again.status === "stored")
      expect(again.artifact).toEqual(first.artifact);
  });

  it("stores nothing when the comparison fails", async () => {
    const { p } = provider([new Error("x"), new Error("y")]);
    const result = await compareAndStore({
      comparator: new HistoricalComparator(p),
      modelVersion: p.modelVersion,
      claim,
      post: { publicationId: "pub", postId: "mar" },
      earlier,
      artifacts,
      operations,
      owner: "w",
    });
    expect(result).toEqual({ status: "failed", reason: "provider-failed" });
  });
});
