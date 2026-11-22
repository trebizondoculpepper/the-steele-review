import { describe, expect, it } from "vite-plus/test";
import type { ClaimRow, ClaimsPort } from "../../src/dashboard/claims.js";
import {
  claimRowArtifact,
  claimRowId,
  claimsCollectionAdapter,
} from "../../src/dashboard/claims-collection.js";
import { queryCollection } from "../../src/dashboard/collection-query.js";

const row = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  result: "claim-extractions/pub/p1/v1.json",
  resultCommit: "a".repeat(40),
  resultHash: `sha256:${"b".repeat(64)}`,
  category: "accepted",
  index: 0,
  publicationId: "pub",
  postId: "p1",
  sourceVersion: `sha256:${"c".repeat(64)}`,
  statement: "The council raised fees by 3%.",
  themes: [],
  ...over,
});

const port = (listing: {
  state: "ok" | "unavailable";
  rows: ClaimRow[];
  next?: string;
  partial?: boolean;
  unreadable?: number;
}): ClaimsPort => ({
  list: async () => ({
    state: listing.state,
    rows: listing.rows,
    ...(listing.next ? { next: listing.next } : {}),
    partial: listing.partial ?? false,
    unreadable: listing.unreadable ?? 0,
  }),
  detail: async () => undefined,
  sourceText: async () => undefined,
  forPost: async () => [],
});

describe("claims in the shared browser (#619)", () => {
  it("carries the exact extraction reference on every row", async () => {
    const page = await queryCollection(
      claimsCollectionAdapter(port({ state: "ok", rows: [row()] })),
      {},
    );
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.id).toBe(claimRowId(row()));
    expect(page.rows[0]!.artifact).toEqual({
      repository: "content",
      commit: "a".repeat(40),
      path: "claim-extractions/pub/p1/v1.json",
      hash: `sha256:${"b".repeat(64)}`,
    });
    expect(page.rows[0]!.summary).toBe("The council raised fees by 3%.");
  });

  it("does not show a row it cannot pin to an exact extraction", async () => {
    const page = await queryCollection(
      claimsCollectionAdapter(
        port({ state: "ok", rows: [row(), row({ index: 1, resultCommit: undefined })] }),
      ),
      {},
    );
    expect(page.rows).toHaveLength(1);
    expect(page.limitations.join(" ")).toMatch(/no exact extraction reference/);
    expect(claimRowArtifact(row({ resultHash: undefined }))).toBeUndefined();
  });

  it("passes filters and the cursor through and reports the port's own state", async () => {
    const calls: unknown[] = [];
    const p: ClaimsPort = {
      ...port({ state: "ok", rows: [row()], next: "c2", partial: true, unreadable: 2 }),
      list: async (filter) => {
        calls.push(filter);
        return { state: "ok", rows: [row()], next: "c2", partial: true, unreadable: 2 };
      },
    };
    const page = await queryCollection(claimsCollectionAdapter(p), {
      text: "fees",
      filters: { post: "pub/p1", category: "accepted" },
      cursor: "c1",
    });
    expect(calls[0]).toMatchObject({ query: "fees", post: "pub/p1", category: "accepted", after: "c1" });
    expect(page.next).toBe("c2");
    expect(page.limitations.join(" ")).toMatch(/reached its bound/);
    expect(page.limitations.join(" ")).toMatch(/2 saved extraction/);
  });

  it("refuses an invalid post filter rather than silently ignoring it", async () => {
    await expect(
      queryCollection(claimsCollectionAdapter(port({ state: "ok", rows: [] })), {
        filters: { post: "not-a-post" },
      }),
    ).rejects.toMatchObject({ code: "invalid-filter" });
  });
});
