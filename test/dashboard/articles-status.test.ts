import { describe, expect, it } from "vite-plus/test";
import { articleViews, statusBucket } from "../../src/dashboard/article-views.js";

const article = (postId: string) => ({
  publicationId: "pub",
  postId,
  sourceVersion: `sha256:${"a".repeat(64)}`,
});

const view = (runs: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  articleViews({
    canTrigger: false,
    articles: {
      recent: async () => [article("p1"), article("p2"), article("p3"), article("p4")],
      find: async () => undefined,
    },
    runs: {
      status: async (a: { postId: string }) => runs[a.postId] ?? { state: "not-started" },
      ...extra,
    },
  }).find((v) => v.path === "/articles")!;

const finished = (outcome: string, reason?: string) => ({
  state: "finished",
  result: { outcome, ...(reason ? { reason } : {}) },
});

describe("article status filtering (#510)", () => {
  it("buckets editorial outcome separately from workflow state", () => {
    expect(statusBucket("verified")).toBe("approved");
    expect(statusBucket("rejected")).toBe("unverified");
    expect(statusBucket("drafted-unverified")).toBe("unverified");
    expect(statusBucket("credit-exhausted")).toBe("failed");
    expect(statusBucket("running")).toBe("pending");
    expect(statusBucket("not-started")).toBe("not-started");
    // An unreadable run state is not an unverified article.
    expect(statusBucket("unknown")).toBe("unknown");
    expect(statusBucket("unavailable")).toBe("unknown");
    expect(statusBucket("not-configured")).toBe("unknown");
  });

  it("filters to approved only, never mixing rejected verification in", async () => {
    const v = view({
      p1: finished("verified"),
      p2: finished("rejected"),
      p3: finished("evidence-gap"),
      p4: { state: "running" },
    });
    const html = await v.render(new URL("https://x/articles?status=approved"));
    expect(html).toContain(">p1<");
    expect(html).not.toContain(">p2<");
    expect(html).not.toContain(">p3<");
    expect(html).not.toContain(">p4<");
    expect(html).toContain("with status “approved”");
  });

  it("filters pending and failed, treating credit exhaustion as a failure", async () => {
    const v = view({
      p1: finished("failed", "claims: credit-exhausted"),
      p2: { state: "running" },
      p3: finished("verified"),
      p4: { state: "not-started" },
    });
    const failed = await v.render(new URL("https://x/articles?status=failed"));
    expect(failed).toContain(">p1<");
    expect(failed).not.toContain(">p2<");
    const pending = await v.render(new URL("https://x/articles?status=pending"));
    expect(pending).toContain(">p2<");
    expect(pending).not.toContain(">p1<");
  });

  it("preserves the sort when switching filters and explains an empty result", async () => {
    const v = view({ p1: finished("verified") });
    const html = await v.render(new URL("https://x/articles?status=approved&sort=oldest"));
    expect(html).toContain("sort=oldest");
    const empty = await v.render(new URL("https://x/articles?status=evidence-gap"));
    expect(empty).toContain("No archived articles currently have the status");
  });

  it("keeps every scanned match instead of dropping the overflow", async () => {
    // Two index pages, each fully matching: both pages' rows must be shown.
    let page = 0;
    const v = articleViews({
      canTrigger: false,
      articles: {
        recent: async () => [],
        find: async () => undefined,
        page: async () => {
          page++;
          return {
            entries: Array.from({ length: 25 }, (_, i) => article(`p${page}-${i}`)),
            ...(page === 1 ? { next: "cursor-2" } : {}),
          };
        },
      },
      runs: { status: async () => finished("verified") },
    }).find((x) => x.path === "/articles")!;
    const html = await v.render(new URL("https://x/articles?status=approved"));
    // The page stops at one page's worth of matches rather than slicing them
    // away, and the cursor still points at the next page so nothing is lost.
    expect(html).toContain("Showing 25 archived articles");
    expect(html).toContain("Next page");
  });

  it("keeps unavailable runs out of the unverified bucket", async () => {
    const v = articleViews({
      canTrigger: false,
      articles: {
        recent: async () => [article("p1"), article("p2")],
        find: async () => undefined,
      },
      runs: {
        status: async (a: { postId: string }) =>
          a.postId === "p1" ? { state: "unavailable" } : finished("rejected"),
      },
    }).find((x) => x.path === "/articles")!;
    const unverified = await v.render(new URL("https://x/articles?status=unverified"));
    expect(unverified).toContain(">p2<");
    expect(unverified).not.toContain(">p1<");
    const unknown = await v.render(new URL("https://x/articles?status=unknown"));
    expect(unknown).toContain(">p1<");
  });

  it("ignores an unknown status value instead of failing", async () => {
    const v = view({ p1: finished("verified") });
    const html = await v.render(new URL("https://x/articles?status=nonsense"));
    expect(html).toContain(">p1<");
  });
});
