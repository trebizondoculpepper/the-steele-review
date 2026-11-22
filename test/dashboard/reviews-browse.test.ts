import { describe, expect, it } from "vite-plus/test";
import type { AssessmentRow, AssessmentsPort } from "../../src/dashboard/assessments.js";
import { queryCollection } from "../../src/dashboard/collection-query.js";
import type { JudgmentRow, JudgmentsPort } from "../../src/dashboard/judgments.js";
import { reviewsBrowseViews } from "../../src/dashboard/reviews-browse-views.js";
import { reviewsCollection } from "../../src/dashboard/reviews-collection.js";
import type { ReviewHistoryPort } from "../../src/dashboard/reviews.js";

const assessment = (n: number, over: Partial<AssessmentRow> = {}): AssessmentRow => ({
  path: `assessments/pub/p${n}/${String(n).padStart(32, "0")}.json`,
  publicationId: "pub",
  postId: `p${n}`,
  state: "findings",
  findings: 2,
  deterministicFindings: 0,
  assessorModel: "fake/assessor",
  promptVersion: "v1",
  assessedAt: `2026-01-0${n}T00:00:00Z`,
  hasDocument: true,
  ...over,
});
const judgment = (n: number, over: Partial<JudgmentRow> = {}): JudgmentRow => ({
  path: `judgments/pub/p${n}/${String(n).padStart(32, "0")}.json`,
  publicationId: "pub",
  postId: `p${n}`,
  state: "decided",
  decision: "approve",
  gateCount: 0,
  decidedAt: "2026-01-01T00:00:00Z",
  hasDocument: true,
  ...over,
});

function ports(a: AssessmentRow[][], j: JudgmentRow[] = []) {
  const assessments: AssessmentsPort = {
    async list({ after, state }) {
      const i = after ? Number(after) : 0;
      const rows = (a[i] ?? []).filter((r) => !state || r.state === state);
      return {
        state: "ok",
        rows,
        partial: false,
        unreadable: 0,
        ...(i + 1 < a.length ? { next: String(i + 1) } : {}),
      };
    },
    async detail() {
      return undefined;
    },
  };
  const judgments: JudgmentsPort = {
    async list({ decision, state }) {
      const rows = j.filter(
        (r) => (!decision || r.decision === decision) && (!state || r.state === state),
      );
      return { state: "ok", rows, partial: false, unreadable: 0 };
    },
    async detail() {
      return undefined;
    },
  };
  const reviews: ReviewHistoryPort = {
    async forPost() {
      return {
        state: "ok",
        reviews: [
          {
            kind: "review",
            path: "verifications/pub/p1/r1.json",
            outcome: "approved",
            draft: { commit: "c".repeat(40), path: "articles/pub/p1/x.md", hash: "h" },
            scope: "publication",
            issues: [],
            checks: [],
          },
          { kind: "unreadable", path: "verifications/pub/p1/r2.json" },
        ],
        editorial: [],
        truncated: false,
      };
    },
  };
  return { assessments, judgments, reviews };
}
const content = {
  lookup: async (path: string) => ({
    repository: "content",
    commit: "c".repeat(40),
    path,
    sha256: "d".repeat(64),
  }),
};

describe("review search (#622)", () => {
  it("keeps assessments, judgments and verifier reports as distinct lists with recorded outcomes", async () => {
    const p = ports(
      [[assessment(1), assessment(2, { state: "incomplete", findings: undefined })]],
      [judgment(1), judgment(2, { state: "gated", decision: "none", gateCount: 2 })],
    );
    const a = await queryCollection(reviewsCollection(p, content), {});
    expect(a.rows.map((r) => r.outcome)).toEqual(["findings", "incomplete"]);
    // An incomplete assessment shows no invented count and is never approval.
    expect(a.rows[1]).not.toHaveProperty("count");
    const j = await queryCollection(reviewsCollection(p, content), {
      filters: { kind: "judgment" },
    });
    // A gated judgment shows its state, never a decision it did not make.
    expect(j.rows.map((r) => r.outcome)).toEqual(["approve", "gated"]);
  });

  it("asks for a post for legacy verifier reports and lists them for that post", async () => {
    const p = ports([[]]);
    const none = await queryCollection(reviewsCollection(p, content), {
      filters: { kind: "verifier-report" },
    });
    expect(none.rows).toHaveLength(0);
    expect(none.limitations.join(" ")).toMatch(/choose a post/);
    const listed = await queryCollection(reviewsCollection(p, content), {
      filters: { kind: "verifier-report", post: "pub/p1" },
    });
    expect(listed.rows.map((r) => r.outcome)).toEqual(["approved", "unreadable"]);
  });

  it("filters only by outcomes valid for the chosen kind", async () => {
    const p = ports([[assessment(1), assessment(2, { state: "no-faults" })]]);
    const ok = await queryCollection(reviewsCollection(p, content), {
      filters: { outcome: "no-faults" },
    });
    expect(ok.rows.map((r) => r.postId)).toEqual(["p2"]);
    await expect(
      queryCollection(reviewsCollection(p, content), { filters: { outcome: "approve" } }),
    ).rejects.toThrow(/invalid-filter/);
  });

  it("pages across reader pages without skipping and escapes hostile text", async () => {
    const p = ports([[assessment(1), assessment(2), assessment(3)], [assessment(4)]]);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await queryCollection(reviewsCollection(p, content), {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.rows.map((r) => r.postId));
      cursor = page.next;
      if (!cursor) break;
    }
    expect(seen).toEqual(["p1", "p2", "p3", "p4"]);
    const hostile = ports([[assessment(1, { postId: "<script>" as never })]]);
    const html = await reviewsBrowseViews(hostile, content)[0]!.render(
      new URL("https://d.test/reviews/search"),
    );
    expect(html).not.toContain("<script>");
    expect(
      await reviewsBrowseViews(hostile, content)[0]!.render(
        new URL("https://d.test/reviews/search?f.__proto__=x"),
      ),
    ).toContain("not valid");
  });
});
