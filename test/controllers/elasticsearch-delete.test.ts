import { describe, expect, it } from "vite-plus/test";
import { ElasticsearchController, IndexingError } from "../../src/controllers/elasticsearch.js";

const controller = (response: unknown) =>
  new ElasticsearchController("http://localhost:9200", undefined, {
    deleteByQuery: async () => response,
  } as never);

describe("deleteMatching", () => {
  it("returns the count for a complete delete", async () => {
    expect(await controller({ deleted: 3, failures: [] }).deleteMatching("i", {})).toBe(3);
  });
  it("rejects partial results so a checkpoint never advances past them", async () => {
    await expect(
      controller({ deleted: 1, failures: [{ id: "x" }] }).deleteMatching("i", {}),
    ).rejects.toBeInstanceOf(IndexingError);
    await expect(
      controller({ deleted: 0, timed_out: true }).deleteMatching("i", {}),
    ).rejects.toBeInstanceOf(IndexingError);
  });
});
