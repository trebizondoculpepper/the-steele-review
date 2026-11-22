import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as clients from "@restatedev/restate-sdk-clients";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { restateRuns } from "../../src/dashboard/adapters.js";
import { articleTrigger } from "../../src/dashboard/trigger.js";
import { recoveryWorkflowKey } from "../../src/dashboard/recovery.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { articleRunKey, type ArticleRunInput } from "../../src/workflow/article-run.js";

// Synthetic capture and a fake Restate ingress: no engine, model or provider (#749).
const text = "Synthetic captured post.";
const revision = sourceVersionFor(text);
const artifact = {
  repository: "archive",
  commit: "a".repeat(40),
  path: "substack/pub/post/collected.json",
  sha256: "b".repeat(64),
};
const record = {
  item: { publicationId: "pub", postId: "post", title: "T", url: "https://example.test/post" },
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
const post = { publicationId: "pub", postId: "post", sourceVersion: revision };

type Run = { state: "running" } | { state: "finished"; result: Record<string, unknown> };
/** Workflow state by key, as Restate ingress would report it. */
const engine = new Map<string, Run>();
let unavailable = false;
const fakeConnect = (() => ({
  workflowClient: (_def: unknown, key: string) => ({
    workflowOutput: async () => {
      if (unavailable) throw new Error("ingress down");
      const run = engine.get(key);
      if (!run) throw new clients.HttpCallError(404, "not found", "");
      return run.state === "finished" ? { ready: true, result: run.result } : { ready: false };
    },
    progress: async () => ({ stage: "research", status: "running" }),
  }),
})) as unknown as typeof clients.connect;

let dir: string;
let operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-reschedule-"));
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
  engine.clear();
  unavailable = false;
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

function setup() {
  const submitted: { key: string; input: ArticleRunInput }[] = [];
  const runs = restateRuns("http://ingress.invalid", 1_000, operations, fakeConnect);
  const trigger = articleTrigger({
    archive: { lookup: async () => artifact, read: async () => JSON.stringify(record) },
    submitter: {
      submit: async (input, key) => {
        const k = key ?? articleRunKey(input);
        submitted.push({ key: k, input });
        // Restate does not restart a finished workflow under the same key.
        if (!engine.has(k)) engine.set(k, { state: "running" });
      },
    },
    researchDeadlineMs: 60_000,
    researchRequestLimit: 2,
    runs,
    attempts: operations,
  });
  return { trigger, runs, submitted };
}

/** Render the confirm page and return its form, as the browser would post it. */
async function confirmForm(trigger: ReturnType<typeof articleTrigger>) {
  const html = await trigger.view.render(
    new URL(
      `https://example.test/articles/run?${new URLSearchParams({ publication: "pub", post: "post", revision })}`,
    ),
  );
  const form = new URLSearchParams();
  for (const m of html.matchAll(/name="([^"]+)" value="([^"]*)"/g)) form.set(m[1]!, m[2]!);
  form.set("confirm", "yes");
  return form;
}

describe("rescheduling a failed article (#749)", () => {
  it("starts a fresh attempt whose own status replaces the old failure as current", async () => {
    const { trigger, runs, submitted } = setup();
    // The original run failed under the stable key.
    engine.set(articleRunKey(post), {
      state: "finished",
      result: { outcome: "failed", reason: "draft: json-syntax", research: [] },
    });
    expect(await runs.status(post)).toMatchObject({
      state: "finished",
      result: { outcome: "failed" },
    });

    const form = await confirmForm(trigger);
    expect(form.get("request")).toMatch(/^console-/);
    expect(await trigger.submit(form)).toMatchObject({ status: 303 });
    expect(submitted).toHaveLength(1);
    const attemptKey = submitted[0]!.key;
    expect(attemptKey).not.toBe(articleRunKey(post));
    expect(attemptKey).toMatch(/~run-[0-9a-f]{16}$/);

    // Every status read now selects the new attempt, not the old failure.
    const running = await runs.status(post);
    expect(running).toMatchObject({ state: "running", workflowKey: attemptKey });
    // Resubmitting the same confirm form attaches: no second paid run.
    expect(await trigger.submit(form)).toMatchObject({ status: 303 });
    expect(submitted).toHaveLength(1);

    // The new attempt reaches its own terminal result.
    engine.set(attemptKey, {
      state: "finished",
      result: { outcome: "verified", research: [] },
    });
    expect(await runs.status(post)).toMatchObject({
      state: "finished",
      result: { outcome: "verified" },
      workflowKey: attemptKey,
    });
    // The original failure is still there as history.
    expect(engine.get(articleRunKey(post))).toMatchObject({ result: { outcome: "failed" } });
    // The same form, after the attempt finished, still starts nothing new.
    expect(await trigger.submit(form)).toMatchObject({ status: 303 });
    expect(submitted.filter((s) => s.key !== attemptKey)).toHaveLength(0);
  });

  it("refuses to guess while the run state is unavailable", async () => {
    const { trigger, submitted } = setup();
    engine.set(articleRunKey(post), {
      state: "finished",
      result: { outcome: "failed", research: [] },
    });
    const form = await confirmForm(trigger);
    unavailable = true;
    expect(await trigger.submit(form)).toEqual({ status: 503 });
    expect(submitted).toHaveLength(0);
  });

  it("attaches to a running run and submits a never-run revision under its stable key", async () => {
    const { trigger, submitted } = setup();
    const form = await confirmForm(trigger);
    expect(await trigger.submit(form)).toMatchObject({ status: 303 });
    expect(submitted.map((s) => s.key)).toEqual([articleRunKey(post)]);
    // Now running under the stable key: a second confirm only attaches.
    expect(await trigger.submit(await confirmForm(trigger))).toMatchObject({ status: 303 });
    expect(submitted).toHaveLength(1);
  });

  it("does not rerun a finished revision without a valid one-time request token", async () => {
    const { trigger, submitted } = setup();
    engine.set(articleRunKey(post), {
      state: "finished",
      result: { outcome: "failed", research: [] },
    });
    const form = await confirmForm(trigger);
    form.delete("request");
    expect(await trigger.submit(form)).toEqual({ status: 409 });
    form.set("request", "../forged");
    expect(await trigger.submit(form)).toEqual({ status: 409 });
    expect(submitted).toHaveLength(0);
  });

  it("never lets one confirmation start a second run after its first one finished", async () => {
    const { trigger, submitted } = setup();
    const form = await confirmForm(trigger);
    // A never-run revision starts under its stable key...
    expect(await trigger.submit(form)).toMatchObject({ status: 303 });
    expect(submitted.map((s) => s.key)).toEqual([articleRunKey(post)]);
    // ...and finishes. Reposting the same form must not start an attempt.
    engine.set(articleRunKey(post), {
      state: "finished",
      result: { outcome: "failed", research: [] },
    });
    expect(await trigger.submit(form)).toMatchObject({ status: 303 });
    expect(submitted).toHaveLength(1);
    // A fresh confirmation does start one.
    expect(await trigger.submit(await confirmForm(trigger))).toMatchObject({ status: 303 });
    expect(submitted).toHaveLength(2);
  });

  it("does not start an attempt beside an active or unknown recovery", async () => {
    const { trigger, submitted } = setup();
    engine.set(articleRunKey(post), {
      state: "finished",
      result: { outcome: "failed", reason: "research: credit-exhausted", research: [] },
    });
    engine.set(recoveryWorkflowKey(articleRunKey(post)), { state: "running" });
    expect(await trigger.submit(await confirmForm(trigger))).toMatchObject({ status: 303 });
    expect(submitted).toHaveLength(0);
  });

  it("reports status as unavailable when attempts cannot be read", async () => {
    engine.set(articleRunKey(post), {
      state: "finished",
      result: { outcome: "failed", research: [] },
    });
    const runs = restateRuns(
      "http://ingress.invalid",
      1_000,
      {
        articleAttempts: () => {
          throw new Error("store unavailable");
        },
      },
      fakeConnect,
    );
    // The stable run's old failure is not presented as current.
    expect(await runs.status(post)).toEqual({ state: "unavailable" });
  });
});
