import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { savedReviews } from "../../src/dashboard/reviews.js";
import { reviewViews } from "../../src/dashboard/review-views.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-reviews-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const post = { publicationId: "pub", postId: "p1" };
const ref = (name: string, sha: string) => ({
  repository: "content",
  commit: "a".repeat(40),
  path: `articles/pub/p1/${name}.md`,
  hash: `sha256:${sha.repeat(64)}`,
});

const report = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  outcome: "redraft",
  draft: ref("draft-1", "1"),
  package: ref("package", "2"),
  source: ref("source", "3"),
  themes: ref("themes", "4"),
  issues: [
    {
      passage: "<script>alert(1)</script> proves it",
      reason: "the evidence does not prove this",
      severity: "substantive",
    },
  ],
  checks: ["source-citations"],
  verifierModel: "fake/verifier",
  promptVersion: "package-verifier-v3",
  verifiedAt: "2026-01-01T00:00:00Z",
  ...over,
});

const writeReport = (name: string, body: unknown) =>
  content.write(`verifications/pub/p1/${name}.json`, JSON.stringify(body));

describe("review history (#499)", { timeout: 60_000 }, () => {
  it("lists every saved pass newest first with its exact draft and feedback", async () => {
    await writeReport("pass-1", report({ verifiedAt: "2026-01-01T00:00:00Z" }));
    await writeReport(
      "pass-2",
      report({
        draft: ref("draft-2", "5"),
        verifiedAt: "2026-01-02T00:00:00Z",
        issues: [{ passage: "payment", reason: "not in evidence", severity: "minor" }],
      }),
    );
    await writeReport(
      "pass-3",
      report({
        outcome: "approved",
        draft: ref("draft-3", "6"),
        verifiedAt: "2026-01-03T00:00:00Z",
        issues: [],
        schemaVersion: 2,
        publication: {
          repository: "content",
          commit: "a".repeat(40),
          path: "publications/pub/p1.json",
          hash: `sha256:${"7".repeat(64)}`,
        },
      }),
    );
    const history = await savedReviews(content).forPost(post);
    expect(history.state).toBe("ok");
    expect(history.reviews.map((r) => r.kind)).toEqual(["review", "review", "review"]);
    const [newest, middle, oldest] = history.reviews as Array<
      Extract<(typeof history.reviews)[number], { kind: "review" }>
    >;
    expect(newest).toMatchObject({
      outcome: "approved",
      scope: "publication",
      draft: { path: "articles/pub/p1/draft-3.md" },
      issues: [],
    });
    expect(middle).toMatchObject({
      outcome: "redraft",
      scope: "body-only",
      draft: { path: "articles/pub/p1/draft-2.md" },
      modelVersion: "fake/verifier",
    });
    expect(oldest.issues[0]).toMatchObject({
      passage: "<script>alert(1)</script> proves it",
      severity: "substantive",
    });
    expect(oldest.draft.hash).toBe(`sha256:${"1".repeat(64)}`);

    // Reads are immutable: the same saved passes, never duplicated.
    const again = await savedReviews(content).forPost(post);
    expect(again.reviews.map((r) => r.path)).toEqual(history.reviews.map((r) => r.path));
  });

  it("distinguishes the terminal unresolved wrapper from a model review", async () => {
    await writeReport("pass-1", report({}));
    await writeReport("pass-1.unresolved", {
      outcome: "unresolved",
      revisions: 2,
      report: {
        repository: "content",
        commit: "a".repeat(40),
        path: "verifications/pub/p1/pass-1.json",
        hash: `sha256:${"8".repeat(64)}`,
      },
      issues: [{ passage: "p", reason: "still unsupported", severity: "substantive" }],
    });
    const history = await savedReviews(content).forPost(post);
    const wrapper = history.reviews.find((r) => r.kind === "unresolved");
    expect(wrapper).toMatchObject({
      outcome: "unresolved",
      revisions: 2,
      reportPath: "verifications/pub/p1/pass-1.json",
    });
    expect(history.reviews.filter((r) => r.kind === "review")).toHaveLength(1);
  });

  it("reports unreadable reports without inventing a completed review", async () => {
    await writeReport("pass-1", report({}));
    await content.write("verifications/pub/p1/broken.json", "{not json");
    const history = await savedReviews(content).forPost(post);
    expect(history.state).toBe("partial");
    expect(history.reviews.find((r) => r.path.endsWith("broken.json"))).toMatchObject({
      kind: "unreadable",
    });
  });

  it("returns none for a post with no saved reviews", async () => {
    expect(await savedReviews(content).forPost(post)).toMatchObject({
      state: "none",
      reviews: [],
      editorial: [],
    });
  });

  it("keeps manual editorial decisions separate from automatic reviews", async () => {
    await content.write(
      "editorial-decisions/pub/p1/rev/decision-1.json",
      JSON.stringify({
        schemaVersion: 1,
        requestId: "decision-1",
        publicationId: "pub",
        postId: "p1",
        draft: ref("draft-1", "1"),
        action: "reject",
        decidedAt: "2026-01-04T00:00:00Z",
        comment: "Not ready.",
      }),
    );
    const history = await savedReviews(content).forPost(post);
    expect(history.reviews).toEqual([]);
    expect(history.editorial).toEqual([
      {
        path: "editorial-decisions/pub/p1/rev/decision-1.json",
        action: "reject",
        decidedAt: "2026-01-04T00:00:00Z",
        draftHash: `sha256:${"1".repeat(64)}`,
        comment: "Not ready.",
      },
    ]);
  });

  it("paginates a long history without rescanning unboundedly", async () => {
    for (let i = 0; i < 23; i++) {
      await writeReport(
        `pass-${String(i).padStart(2, "0")}`,
        report({ verifiedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
      );
    }
    const first = await savedReviews(content).forPost(post, 0);
    expect(first.reviews).toHaveLength(20);
    expect(first.next).toBe(1);
    const second = await savedReviews(content).forPost(post, 1);
    expect(second.reviews).toHaveLength(3);
    expect(second.next).toBeUndefined();
    // Pages never overlap.
    const paths = new Set([...first.reviews, ...second.reviews].map((r) => r.path));
    expect(paths.size).toBe(23);
  });

  it("escapes feedback and links the article and drafts", async () => {
    await writeReport("pass-1", report({}));
    const [view] = reviewViews(savedReviews(content));
    const html = await view!.render(
      new URL("http://x/reviews?publication=pub&post=p1"),
    );
    expect(html).toContain("Review history");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('href="/articles/trace?publication=pub&post=p1"');
    expect(html).toContain('href="/drafts?publication=pub&post=p1"');
    expect(html).toContain("fake/verifier");
  });
});
