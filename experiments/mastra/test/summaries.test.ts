import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GitRepository } from "../src/common/git/index.js";
import { ModelError, type ChatModel, type ChatRequest } from "../src/common/model/openrouter.js";
import { SUMMARIES_DECLARATION, summariseSource, type SourceSummary } from "../src/summaries/summarise.js";
import { createSummariseNewContentStep } from "../src/mastra/steps/summarise-new-content.js";

const pinned = readFileSync(fileURLToPath(new URL("./fixtures/themes/pinned-article.json", import.meta.url)), "utf8");
const PATH = "raw_content/substack/fixturepub/pinned-episode/article.json";
const SUMMARY = { summary: "The speaker says public consultation on new standards is too short and claims that patent filings reveal plans before they are announced." };

function scripted(replies: Array<string | Error>): ChatModel & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    calls,
    async complete(request) {
      calls.push(request);
      const next = replies.shift();
      if (next === undefined) throw new Error("unexpected model call");
      if (next instanceof Error) throw next;
      return { model: request.model, raw: next, provider: "fake", finishReason: "stop", usage: { promptTokens: 300, completionTokens: 60, costUsd: 0.00005 } };
    },
  };
}

async function harness(article = pinned, path = PATH) {
  const root = mkdtempSync(join(tmpdir(), "summaries-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", root]);
  const repo = new GitRepository(root);
  const { commit } = await repo.commit({ parent: null, writes: [{ path, content: article }], message: "pinned source" });
  return { repo, ref: { path, commit: commit! } };
}

test("a usable transcript is summarised as a transcript, linked to the original URL and exact version", async () => {
  const h = await harness();
  const model = scripted([JSON.stringify(SUMMARY)]);
  const r = await summariseSource(h.ref, { repo: h.repo, model });
  assert.equal(r.outcome, "proposed");
  assert.match(model.calls[0]!.user, /Text type: transcript/);
  const saved = JSON.parse((await h.repo.readText("main", r.summary!.path))!.text) as SourceSummary;
  assert.equal(saved.summary, SUMMARY.summary);
  assert.equal(saved.url, "https://fixturepub.example.org/p/pinned-episode?utm_source=rss");
  assert.equal(saved.source.textType, "transcript");
  assert.equal(saved.source.commit, h.ref.commit);
  assert.equal(saved.source.blob, (await h.repo.readFile(h.ref.commit, PATH))!.blob);
  assert.match(saved.prompt, /^source-summary-v1@sha256:[0-9a-f]{64}$/);
  assert.deepEqual(r.usage, { promptTokens: 300, completionTokens: 60, costUsd: 0.00005 });
  assert.ok(r.timings.modelMs !== null);
});

test("a recording without a usable transcript is summarised from its description, and says so", async () => {
  const rec = JSON.parse(pinned);
  rec.transcript = { ...rec.transcript, status: "unusable" };
  rec.analysis = { use: "skip", reason: "transcript-garbled" };
  const h = await harness(JSON.stringify(rec));
  const model = scripted([JSON.stringify({ summary: "The description of this recording says it is the show notes for the pinned episode." })]);
  const r = await summariseSource(h.ref, { repo: h.repo, model });
  assert.equal(r.outcome, "proposed");
  assert.match(model.calls[0]!.user, /Text type: description/);
  const saved = JSON.parse((await h.repo.readText("main", r.summary!.path))!.text) as SourceSummary;
  assert.equal(saved.source.textType, "description");
});

test("unavailable input is recorded explicitly without a model call", async () => {
  const rec = JSON.parse(pinned);
  rec.transcript = { ...rec.transcript, status: "missing", content: null };
  rec.text = { role: "description", content: "" };
  const h = await harness(JSON.stringify(rec));
  const model = scripted([]);
  const r = await summariseSource(h.ref, { repo: h.repo, model });
  assert.equal(r.outcome, "skipped");
  assert.equal(r.reason, "no-usable-text: missing");
  assert.equal(model.calls.length, 0);
});

test("replay reuses the summary; a changed source version gets its own; a model failure is recorded then recovered", async () => {
  const h = await harness();
  const failed = await summariseSource(h.ref, { repo: h.repo, model: scripted([new ModelError("provider-error", "500")]) });
  assert.equal(failed.outcome, "model-failed");
  const first = await summariseSource(h.ref, { repo: h.repo, model: scripted([JSON.stringify(SUMMARY)]) });
  assert.equal(first.outcome, "proposed");
  const model = scripted([]);
  const replay = await summariseSource(h.ref, { repo: h.repo, model });
  assert.equal(model.calls.length, 0);
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.summary, first.summary);

  const changed = JSON.parse(pinned);
  changed.title = "A revised episode";
  const { commit } = await h.repo.commit({ writes: [{ path: PATH, content: JSON.stringify(changed) }], message: "new version" });
  const second = await summariseSource({ path: PATH, commit: commit! }, { repo: h.repo, model: scripted([JSON.stringify(SUMMARY)]) });
  assert.notEqual(second.operation, first.operation);
  assert.notEqual(second.summary!.summaryId, first.summary!.summaryId);
});

test("the workflow step summarises newly captured items automatically, isolates failures, and replays without model calls", async () => {
  const { parseDeclaration } = await import("../src/collections/declaration.js");
  assert.equal(parseDeclaration("summaries", JSON.stringify(SUMMARIES_DECLARATION)).mappingVersion, 1);
  const h = await harness();
  const fetchedOutput = {
    poll: { ok: true, commit: null, sources: [], committed: [] },
    fetched: [
      { sourceId: "fixturepub", itemId: "pinned-episode", status: "captured" as const, path: PATH, commit: h.ref.commit },
      { sourceId: "fixturepub", itemId: "missing", status: "captured" as const, path: "raw_content/substack/fixturepub/missing/article.json", commit: h.ref.commit },
      { sourceId: "fixturepub", itemId: "failed-item", status: "failed" as const, error: "post-not-found" },
    ],
  };
  const model = scripted([JSON.stringify(SUMMARY)]);
  const step = createSummariseNewContentStep(() => ({ repo: h.repo, model }));
  const run = (step.execute as (a: unknown) => Promise<{ summaries: Array<{ itemId: string; outcome: string; reused?: boolean }> }>);
  const out = await run({ inputData: fetchedOutput });
  assert.deepEqual(out.summaries.map((s) => [s.itemId, s.outcome]), [["pinned-episode", "proposed"], ["missing", "error"]], "only captured items; one failure does not stop the others");
  assert.equal(model.calls.length, 1);
  const replay = await run({ inputData: fetchedOutput });
  assert.equal(replay.summaries[0]!.reused, true);
  assert.equal(model.calls.length, 1, "no duplicate model call on replay");
});

test("an unfinished summary is retried by a later run with nothing new captured (review on #968)", async () => {
  const h = await harness();
  const fetchedOutput = {
    poll: { ok: true, commit: null, sources: [], committed: [] },
    fetched: [{ sourceId: "fixturepub", itemId: "pinned-episode", status: "captured" as const, path: PATH, commit: h.ref.commit }],
  };
  const run = (model: ChatModel, input: unknown) =>
    (createSummariseNewContentStep(() => ({ repo: h.repo, model })).execute as (a: unknown) => Promise<{ summaries: Array<{ outcome: string; retried?: boolean }> }>)({ inputData: input });
  const first = await run(scripted([new ModelError("provider-error", "500")]), fetchedOutput);
  assert.equal(first.summaries[0]!.outcome, "model-failed");

  const empty = { poll: fetchedOutput.poll, fetched: [] };
  const model = scripted([JSON.stringify(SUMMARY)]);
  const later = await run(model, empty);
  assert.deepEqual(later.summaries.map((s) => [s.outcome, s.retried]), [["proposed", true]]);
  const after = await run(scripted([]), empty);
  assert.deepEqual(after.summaries, [], "a completed summary is not retried again");
});

test("an unfinished summary superseded by a model change leaves the retry queue (review on #968)", async () => {
  const { unfinishedSummaries } = await import("../src/summaries/summarise.js");
  const h = await harness();
  await summariseSource(h.ref, { repo: h.repo, model: scripted([new ModelError("provider-error", "500")]), modelId: "old/model" });
  assert.equal((await unfinishedSummaries(h.repo, "main", 10, "old/model")).length, 1);
  // Under the new model the summary is simply missing: it is queued once,
  // and after it succeeds the superseded failure occupies no slot.
  const fetched = { poll: { ok: true, commit: null, sources: [], committed: [] }, fetched: [] };
  const run = (model: ChatModel) =>
    (createSummariseNewContentStep(() => ({ repo: h.repo, model, modelId: "new/model" })).execute as (a: unknown) => Promise<{ summaries: Array<{ outcome: string }> }>)({ inputData: fetched });
  assert.deepEqual((await run(scripted([JSON.stringify(SUMMARY)]))).summaries.map((x) => x.outcome), ["proposed"]);
  assert.deepEqual(await unfinishedSummaries(h.repo, "main", 10, "new/model"), []);
  assert.deepEqual((await run(scripted([]))).summaries, []);
});

test("a version whose reservation never committed is still found and summarised later (review on #968)", async () => {
  const { unfinishedSummaries } = await import("../src/summaries/summarise.js");
  const h = await harness();
  const commit = h.repo.commit.bind(h.repo);
  h.repo.commit = async () => {
    throw new Error("storage unavailable");
  };
  const fetched = { poll: { ok: true, commit: null, sources: [], committed: [] }, fetched: [{ sourceId: "fixturepub", itemId: "pinned-episode", status: "captured" as const, path: PATH, commit: h.ref.commit }] };
  const run = (model: ChatModel, input: unknown) =>
    (createSummariseNewContentStep(() => ({ repo: h.repo, model })).execute as (a: unknown) => Promise<{ summaries: Array<{ outcome: string; retried?: boolean }> }>)({ inputData: input });
  assert.equal((await run(scripted([]), fetched)).summaries[0]!.outcome, "error");
  h.repo.commit = commit;
  assert.equal((await unfinishedSummaries(h.repo)).length, 1);
  const later = await run(scripted([JSON.stringify(SUMMARY)]), { ...fetched, fetched: [] });
  assert.deepEqual(later.summaries.map((s) => [s.outcome, s.retried]), [["proposed", true]]);
});

test("a truncated reply whose provider names a different model stays queued (review on #968)", async () => {
  const { unfinishedSummaries } = await import("../src/summaries/summarise.js");
  const h = await harness();
  const truncating: ChatModel = {
    async complete() {
      return { model: "deepseek/deepseek-v4.1-flash-20261101", raw: "{\"summ", provider: "fake", finishReason: "length", usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } };
    },
  };
  const r = await summariseSource(h.ref, { repo: h.repo, model: truncating });
  assert.equal(r.outcome, "model-failed");
  assert.equal((await unfinishedSummaries(h.repo)).length, 1);
});

test("warnings such as source-truncated reach the workflow output (review on #968)", async () => {
  const rec = JSON.parse(pinned);
  rec.transcript.content = "Word ".repeat(16000);
  const h = await harness(JSON.stringify(rec));
  const fetched = { poll: { ok: true, commit: null, sources: [], committed: [] }, fetched: [{ sourceId: "fixturepub", itemId: "pinned-episode", status: "captured" as const, path: PATH, commit: h.ref.commit }] };
  const step = createSummariseNewContentStep(() => ({ repo: h.repo, model: scripted([JSON.stringify(SUMMARY)]) }));
  const out = await (step.execute as (a: unknown) => Promise<{ summaries: Array<{ outcome: string; warnings?: string[] }> }>)({ inputData: fetched });
  assert.equal(out.summaries[0]!.outcome, "proposed");
  assert.ok(out.summaries[0]!.warnings?.includes("source-truncated"));
});
