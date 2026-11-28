import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GitRepository } from "../src/common/git/index.js";
import { ModelError, type ChatModel, type ChatRequest } from "../src/common/model/openrouter.js";
import { proposeThemes, THEMES_DECLARATION, type OperationMeta, type ThemeProposal } from "../src/themes/propose.js";
import { createProposeThemesStep } from "../src/mastra/steps/propose-themes.js";

const pinned = readFileSync(fileURLToPath(new URL("./fixtures/themes/pinned-article.json", import.meta.url)), "utf8");
const PATH = "raw_content/substack/fixturepub/pinned-episode/article.json";

const GOOD = {
  themes: [
    { title: "How technical standards are written", description: "The source discusses who drafts standards and who reads them.", evidence: ["how technical standards are written, and who gets to read them"] },
    { title: "Consultation periods", description: "The speaker says public consultation is too short.", evidence: ["public consultation on new standards is too short for ordinary people to respond"] },
    { title: "Patent filings as early signals", description: "The source claims patents reveal plans early.", evidence: ["patent filings reveal plans long before any announcement is made"] },
  ],
};

function scripted(replies: Array<string | Error>): ChatModel & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    calls,
    async complete(request) {
      calls.push(request);
      const next = replies.shift();
      if (next === undefined) throw new Error("unexpected model call");
      if (next instanceof Error) throw next;
      return { model: request.model, raw: next, provider: "fake", finishReason: "stop", usage: { promptTokens: 400, completionTokens: 120, costUsd: 0.0001 } };
    },
  };
}

async function harness(article = pinned) {
  const root = mkdtempSync(join(tmpdir(), "themes-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", root]);
  const repo = new GitRepository(root);
  const { commit } = await repo.commit({ parent: null, writes: [{ path: PATH, content: article }], message: "pinned source" });
  return { repo, ref: { path: PATH, commit: commit! } };
}

test("proposes grounded themes, saved with source references, stable IDs, prompt identity, usage and timings", async () => {
  const h = await harness();
  const model = scripted([JSON.stringify(GOOD)]);
  const r = await proposeThemes(h.ref, { repo: h.repo, model });
  assert.equal(r.outcome, "proposed");
  assert.equal(r.reused, false);
  assert.equal(r.themes.length, 3);
  assert.deepEqual(r.usage, { promptTokens: 400, completionTokens: 120, costUsd: 0.0001 });
  assert.ok(r.timings.totalMs >= 0 && r.timings.modelMs !== null);
  assert.match(model.calls[0]!.user, /patent filings reveal plans/, "the transcript is the input when analysis uses it");
  const saved = JSON.parse((await h.repo.readText("main", r.themes[0]!.path))!.text) as ThemeProposal;
  assert.equal(saved.title, "How technical standards are written");
  assert.equal(saved.source.path, PATH);
  assert.equal(saved.source.commit, h.ref.commit);
  assert.equal(saved.source.blob, (await h.repo.readFile(h.ref.commit, PATH))!.blob);
  assert.equal(saved.source.textType, "transcript");
  assert.match(saved.prompt, /^theme-proposals-v1@sha256:[0-9a-f]{64}$/);
  assert.match(saved.themeId, /^[0-9a-f]{16}$/);
  const meta = JSON.parse((await h.repo.readText("main", r.themes[0]!.path.replace(/[^/]+\.json$/, "operation.meta")))!.text) as OperationMeta;
  assert.deepEqual(meta.themes, r.themes.map((t) => t.themeId));
  assert.ok(await h.repo.readText("main", "themes/collection.json"));
});

test("valid proposals are kept when others fail validation", async () => {
  const h = await harness();
  const reply = {
    themes: [
      GOOD.themes[0],
      { title: "Invented theme", description: "Not in the source.", evidence: ["this sentence does not appear anywhere in the source text"] },
      { title: "", description: "No title.", evidence: ["public consultation on new standards is too short"] },
      { title: "How technical standards are written", description: "Duplicate.", evidence: ["who gets to read them before they are adopted"] },
    ],
  };
  const r = await proposeThemes(h.ref, { repo: h.repo, model: scripted([JSON.stringify(reply)]) });
  assert.equal(r.outcome, "partial");
  assert.equal(r.themes.length, 1);
  assert.deepEqual(r.rejected, [
    { rank: 2, reason: "evidence-not-in-source" },
    { rank: 3, reason: "invalid-title" },
    { rank: 4, reason: "duplicate-title" },
  ]);
});

test("a retry reuses the saved result without another model call, with the same theme IDs", async () => {
  const h = await harness();
  const first = await proposeThemes(h.ref, { repo: h.repo, model: scripted([JSON.stringify(GOOD)]) });
  const head = await h.repo.resolve("main");
  const model = scripted([]);
  const again = await proposeThemes(h.ref, { repo: h.repo, model });
  assert.equal(model.calls.length, 0);
  assert.equal(again.reused, true);
  assert.deepEqual(again.themes, first.themes);
  assert.equal(await h.repo.resolve("main"), head, "no new commit");
});

test("a model failure is recorded and a later run recovers with one call", async () => {
  const h = await harness();
  const failed = await proposeThemes(h.ref, { repo: h.repo, model: scripted([new ModelError("rate-limited", "429")]) });
  assert.equal(failed.outcome, "model-failed");
  assert.equal(failed.reason, "rate-limited");
  const model = scripted([JSON.stringify(GOOD)]);
  const recovered = await proposeThemes(h.ref, { repo: h.repo, model });
  assert.equal(recovered.outcome, "proposed");
  assert.equal(model.calls.length, 1);
  assert.equal(failed.operation, recovered.operation, "the same operation is completed, not duplicated");
});

test("unusable output yields none-valid; a skipped source makes no model call", async () => {
  let h = await harness();
  const none = await proposeThemes(h.ref, { repo: h.repo, model: scripted(["not json"]) });
  assert.equal(none.outcome, "none-valid");
  assert.ok(none.warnings.includes("model-output-not-json"));

  const skipped = JSON.parse(pinned);
  skipped.analysis = { use: "skip", reason: "transcript-garbled" };
  h = await harness(JSON.stringify(skipped));
  const model = scripted([]);
  const r = await proposeThemes(h.ref, { repo: h.repo, model });
  assert.equal(r.outcome, "skipped");
  assert.equal(r.reason, "transcript-garbled");
  assert.equal(model.calls.length, 0);
});

test("a changed source version gets its own operation", async () => {
  const h = await harness();
  const first = await proposeThemes(h.ref, { repo: h.repo, model: scripted([JSON.stringify(GOOD)]) });
  const changed = JSON.parse(pinned);
  changed.title = "A revised title";
  const { commit } = await h.repo.commit({ writes: [{ path: PATH, content: JSON.stringify(changed) }], message: "revised source" });
  const second = await proposeThemes({ path: PATH, commit: commit! }, { repo: h.repo, model: scripted([JSON.stringify(GOOD)]) });
  assert.notEqual(second.operation, first.operation);
  assert.equal(second.reused, false);
});

test("the step is independently runnable, and the themes declaration is valid for the indexer", async () => {
  const { parseDeclaration } = await import("../src/collections/declaration.js");
  assert.equal(parseDeclaration("themes", JSON.stringify(THEMES_DECLARATION)).mappingVersion, 1);
  const h = await harness();
  const step = createProposeThemesStep(() => ({ repo: h.repo, model: scripted([JSON.stringify(GOOD)]) }));
  const out = (await (step.execute as (a: unknown) => Promise<{ outcome: string }>)({ inputData: h.ref }));
  assert.equal(out.outcome, "proposed");
  const saved = JSON.parse((await h.repo.readText("main", (out as unknown as { themes: { path: string }[] }).themes[0]!.path))!.text);
  const declared = Object.keys(THEMES_DECLARATION.mapping.properties);
  assert.deepEqual(Object.keys(saved).filter((k) => !declared.includes(k)), []);
});

test("a run that loses a race never overwrites a completed result for the same operation (review on #966)", async () => {
  const h = await harness();
  const commit = h.repo.commit.bind(h.repo);
  let raced = false;
  // While this run's model call fails, a concurrent run completes the same operation.
  h.repo.commit = async (request) => {
    if (!raced) {
      raced = true;
      h.repo.commit = commit;
      await proposeThemes(h.ref, { repo: h.repo, model: scripted([JSON.stringify(GOOD)]) });
    }
    return commit(request);
  };
  const r = await proposeThemes(h.ref, { repo: h.repo, model: scripted([new ModelError("provider-error", "500")]) });
  assert.equal(r.outcome, "proposed", "the completed result is returned");
  assert.equal(r.reused, true);
  const model = scripted([]);
  const again = await proposeThemes(h.ref, { repo: h.repo, model });
  assert.equal(again.outcome, "proposed");
  assert.equal(model.calls.length, 0, "the completed operation is still reused");
});
