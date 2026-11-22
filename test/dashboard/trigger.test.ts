import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { articleAttemptHash } from "../../src/workflow/article-attempt.js";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vite-plus/test";
import { articleTrigger } from "../../src/dashboard/trigger.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { articleRunKey, type ArticleRunInput } from "../../src/workflow/article-run.js";

const text = "Synthetic captured post.";
const revision = sourceVersionFor(text);
const artifact = {
  repository: "archive",
  commit: "a".repeat(40),
  path: "substack/pub/post/collected.json",
  sha256: "b".repeat(64),
};
const record = {
  item: {
    publicationId: "pub",
    postId: "post",
    title: "Synthetic post",
    url: "https://example.test/post",
  },
  ingestionReason: "backfill",
  text,
  complete: true,
  supplied: {},
  provenance: {
    sourceUrl: "https://example.test/post",
    acquiredAt: "2026-01-01T00:00:00Z",
    method: "text",
  },
};
const selection = { publication: "pub", post: "post", revision };
function setup() {
  const runs = new Map<string, ArticleRunInput>();
  const trigger = articleTrigger({
    archive: { lookup: async () => artifact, read: async () => JSON.stringify(record) },
    submitter: {
      submit: async (input) => {
        runs.set(articleRunKey(input), input);
      },
    },
    researchDeadlineMs: 60_000,
    researchRequestLimit: 2,
  });
  return { trigger, runs };
}

describe("confirmed article trigger", () => {
  it("shows the exact revision and warning without submitting on GET", async () => {
    const { trigger, runs } = setup();
    const html = await trigger.view.render(
      new URL(`https://example.test/articles/run?${new URLSearchParams(selection)}`),
    );
    expect(html).toContain(revision);
    expect(html).toContain("incur model and research charges");
    expect(html).toContain('method="post"');
    expect(runs.size).toBe(0);
  });

  it("pins the capture, enforces server limits and reuses workflow identity", async () => {
    const { trigger, runs } = setup();
    const form = new URLSearchParams({ ...selection, confirm: "yes" });
    expect((await trigger.submit(form)).status).toBe(303);
    expect((await trigger.submit(form)).status).toBe(303);
    expect(runs.size).toBe(1);
    expect([...runs.values()][0]).toMatchObject({
      sourceVersion: revision,
      source: { artifact },
      researchRequestLimit: 2,
      researchDeadlineMs: 60_000,
    });
    expect(
      (
        await trigger.submit(
          new URLSearchParams({ ...selection, confirm: "yes", researchRequestLimit: "100" }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await trigger.submit(
          new URLSearchParams({
            ...selection,
            revision: `sha256:${"f".repeat(64)}`,
            confirm: "yes",
          }),
        )
      ).status,
    ).toBe(409);
    expect((await trigger.submit(new URLSearchParams(selection))).status).toBe(400);
  });

  it("records new normal attempts with live policy and reconnects the same form without copying settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trigger-live-policy-"));
    const operations = new OperationStore({ path: join(dir, "state.sqlite") });
    const submissions: { input: ArticleRunInput; key?: string }[] = [];
    try {
      const trigger = articleTrigger({
        archive: { lookup: async () => artifact, read: async () => JSON.stringify(record) },
        attempts: operations,
        runs: { status: async () => ({ state: "not-started" as const }) },
        submitter: {
          submit: async (input, key) => {
            submissions.push({ input, key });
          },
        },
        researchDeadlineMs: 60000,
        researchRequestLimit: 2,
      });
      const request = "console-00000000-0000-4000-8000-000000000001";
      const form = new URLSearchParams({ ...selection, request, confirm: "yes" });
      expect((await trigger.submit(form)).status).toBe(303);
      expect((await trigger.submit(form)).status).toBe(303);
      expect(submissions).toHaveLength(1);
      const submitted = submissions[0]!;
      expect(submitted.input.editorialExecution).toBe("live-policy-v1");
      expect(submitted.input.editorial).toBeUndefined();
      expect(submitted.input.operatorRequestId).toBe(request);
      expect(submitted.input.sourceVersion).toBe(revision);
      expect(submitted.key).not.toBe(articleRunKey(submitted.input));
      expect(operations.articleAttempt("pub", "post", request)).toMatchObject({
        workflowKey: submitted.key,
        inputHash: articleAttemptHash(submitted.input),
      });
    } finally {
      operations.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("requires a bounded same-origin POST and sanitizes failures", async () => {
    let calls = 0;
    const actions = {
      origin: "http://example.test",
      routes: {
        "/articles/run": async () => {
          calls++;
          throw new Error("private provider diagnostic");
        },
      },
    };
    const server = createDashboardServer([], actions);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    actions.origin = base;
    const post = (headers: Record<string, string>, body = "confirm=yes") =>
      fetch(`${base}/articles/run`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body,
      });
    try {
      expect((await post({})).status).toBe(403);
      expect((await post({ origin: "https://evil.test" })).status).toBe(403);
      const wrongHost = await new Promise<number>((resolve, reject) => {
        const req = request(
          `${base}/articles/run`,
          {
            method: "POST",
            headers: {
              host: "evil.test",
              origin: base,
              "content-type": "application/x-www-form-urlencoded",
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        req.on("error", reject);
        req.end("confirm=yes");
      });
      expect(wrongHost).toBe(403);
      expect((await post({ origin: base, "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await post({ origin: base }, "x=" + "a".repeat(4096))).status).toBe(413);
      expect((await post({ origin: base }, "confirm=yes&confirm=no")).status).toBe(400);
      expect(calls).toBe(0);
      const failure = await post({ origin: base });
      expect(failure.status).toBe(503);
      expect(await failure.text()).not.toContain("private provider diagnostic");
      expect(calls).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
