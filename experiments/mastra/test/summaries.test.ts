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
