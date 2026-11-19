import { describe, expect, it } from "vite-plus/test";
import { COVERAGE_NOTE, findEarlierCoverage } from "../../src/retrieval/earlier-coverage.js";
import type {
  RetrievedPassage,
  RetrievalQuery,
  RetrievalResult,
} from "../../src/retrieval/passage-retrieval.js";

const artifact = {
  repository: "test-archive",
  commit: "a".repeat(40),
  path: "p.json",
  hash: `sha256:${"b".repeat(64)}`,
};
const passage = (
  postId: string,
  publishedAt: string | undefined,
  fused: number,
  publicationId = "pub-a",
): RetrievedPassage => ({
  passageId: `${postId}-${fused}`,
  sourceId: `substack/${publicationId}/${postId}`,
  publicationId,
  postId,
  ...(publishedAt ? { publishedAt } : {}),
  text: `Passage from ${postId}.`,
  start: 0,
  end: 10,
  artifact,
  signals: { fused },
});

function retriever(passages: RetrievedPassage[], mode: RetrievalResult["mode"] = "hybrid") {
  const queries: RetrievalQuery[] = [];
  return {
    queries,
    retrieve: async (q: RetrievalQuery): Promise<RetrievalResult> => {
      queries.push(q);
      return {
        mode,
        ...(mode === "keyword-only" ? { semanticUnavailable: "no-embedder" as const } : {}),
        passages,
      };
    },
  };
}

const request = {
  claim: { statement: "The council raised fees.", sourceVersion: `sha256:${"c".repeat(64)}` },
  publicationId: "pub-a",
  sourcePostId: "source",
  sourcePublishedAt: "2026-03-01T00:00:00Z",
};

describe("findEarlierCoverage", () => {
  it("excludes the source post and later posts inside the retrieval query", async () => {
    const r = retriever([]);
    await findEarlierCoverage(r, request);
    expect(r.queries[0]).toMatchObject({
      text: "The council raised fees.",
      publicationId: "pub-a",
      before: "2026-03-01T00:00:00Z",
      excludePostIds: ["source"],
    });
  });

  it("returns strictly earlier passages, oldest first, one per post", async () => {
    const r = retriever([
      passage("feb", "2026-02-01T00:00:00Z", 0.03),
      passage("jan", "2026-01-01T00:00:00Z", 0.02),
      passage("jan", "2026-01-01T00:00:00Z", 0.01),
      passage("same-time", "2026-03-01T00:00:00Z", 0.05),
    ]);
    const result = await findEarlierCoverage(r, request);
    expect(result.passages.map((p) => p.postId)).toEqual(["jan", "feb"]);
    expect(result.passages[0]!.signals.fused).toBe(0.02);
  });

  it("excludes the source post, other publications and undated posts, and counts the undated", async () => {
    const r = retriever([
      passage("source", "2026-01-15T00:00:00Z", 0.05),
      passage("elsewhere", "2026-01-10T00:00:00Z", 0.04, "pub-b"),
      passage("undated", undefined, 0.03),
      passage("ok", "2026-01-05T00:00:00Z", 0.01),
    ]);
    const result = await findEarlierCoverage(r, request);
    expect(result.passages.map((p) => p.postId)).toEqual(["ok"]);
    expect(result.limitations.excludedUndated).toBe(1);
  });

  it("states coverage limits, including for empty results and keyword-only mode", async () => {
    const result = await findEarlierCoverage(retriever([], "keyword-only"), request);
    expect(result).toEqual({
      passages: [],
      limitations: {
        mode: "keyword-only",
        semanticUnavailable: "no-embedder",
        excludedUndated: 0,
        note: COVERAGE_NOTE,
      },
    });
  });

  it("bounds the result count", async () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      passage(`p${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`, i / 100),
    );
    const result = await findEarlierCoverage(retriever(many), { ...request, limit: 3 });
    expect(result.passages.map((p) => p.postId)).toEqual(["p12", "p13", "p14"]);
  });

  it("validates the request", async () => {
    await expect(
      findEarlierCoverage(retriever([]), { ...request, sourcePublishedAt: "yesterday" }),
    ).rejects.toThrow();
    await expect(findEarlierCoverage(retriever([]), { ...request, limit: 100 })).rejects.toThrow();
  });
});
