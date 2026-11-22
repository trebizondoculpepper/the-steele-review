import { describe, expect, it } from "vite-plus/test";
import * as clients from "@restatedev/restate-sdk-clients";
import { restateRuns } from "../../src/dashboard/adapters.js";
import { traceArticle } from "../../src/dashboard/articles.js";
import { renderTrace } from "../../src/dashboard/article-views.js";
const post = {
  publicationId: "fixture",
  postId: "post",
  sourceVersion: `sha256:${"a".repeat(64)}`,
};
describe("operator attempt visibility", () => {
  it("shows the exact recorded rerun and its judge progress instead of the old terminal workflow", async () => {
    const key = "fixture/post@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa~run-bbbbbbbbbbbbbbbb";
    const requested: string[] = [];
    const connect = (() => ({
      workflowClient: (_: unknown, workflowKey: string) => {
        requested.push(workflowKey);
        return {
          workflowOutput: async () =>
            workflowKey === key
              ? { ready: false }
              : { ready: true, result: { outcome: "failed", reason: "old-result", research: [] } },
          progress: async () => ({
            stage: "editorial",
            phase: "judge",
            round: 1,
            status: "running",
            at: new Date().toISOString(),
          }),
        };
      },
    })) as unknown as typeof clients.connect;
    const runs = restateRuns(
      "https://restate.example",
      1000,
      {
        articleAttempts: () => [
          {
            workflowKey: key,
            requestId: "request-one",
            sourceVersion: post.sourceVersion,
            recordedAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
      connect,
    );
    const state = await runs.status(post);
    expect(state).toMatchObject({
      state: "running",
      workflowKey: key,
      progress: { phase: "judge" },
    });
    const trace = await traceArticle({
      post,
      articles: { recent: async () => [post], find: async () => post },
      runs,
    });
    expect(trace.workflowKey).toBe(key);
    expect(trace.stages.find((s) => s.stage === "verification")).toMatchObject({
      state: "pending",
      detail: expect.stringContaining("editorial judge pass 2"),
    });
    expect(renderTrace(trace)).toContain(key);
    expect(requested).toContain(key);
  });
});
