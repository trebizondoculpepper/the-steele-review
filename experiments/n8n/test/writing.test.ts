// Contract tests for the n8n writing code (#916): the shared article rules, taken from the
// Git-defined workflow, must render the shared article fixture to exactly its expected Markdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
interface Node { name: string; parameters: { jsCode?: string } }
const wf = JSON.parse(readFileSync(here("../workflows/writing-run.json"), "utf8")) as { nodes: Node[] };
const js = wf.nodes.find((n) => n.name === "Validate and render")!.parameters.jsCode!;
const shared = js.slice(js.indexOf("// ---- shared"), js.indexOf("// ---- end shared ----"));
type Rules = {
  checkArticle: (a: unknown) => { article?: Record<string, unknown>; error?: string };
  renderArticle: (a: unknown) => string;
  unsupportedMarkdown: (a: unknown) => string | null;
  lengthGuidance: (a: unknown) => { summaryWords: number; conclusionWords: number; warning: string | null };
};
const rules = new Function(`${shared}; return { checkArticle, renderArticle, unsupportedMarkdown, lengthGuidance };`)() as Rules;

const fixture = JSON.parse(readFileSync(here("../../shared/fixtures/article-v1.example.json"), "utf8")) as Record<string, unknown>;
const expected = readFileSync(here("../../shared/fixtures/article-v1.example.md"), "utf8");

test("the shared article fixture renders to exactly its expected Markdown", () => {
  const { article, error } = rules.checkArticle(fixture);
  assert.equal(error, undefined);
  assert.equal(rules.renderArticle(article), expected);
});

test("fields are trimmed before rendering and the output ends with one newline", () => {
  const padded = { ...fixture, summary: `  ${fixture.summary as string}  `, conclusion: `\n${fixture.conclusion as string}\n` };
  assert.equal(rules.renderArticle(rules.checkArticle(padded).article), expected);
});

test("partial or malformed model output is refused with a reason", () => {
  assert.equal(rules.checkArticle({ ...fixture, critique: [] }).error, "critique");
  assert.equal(rules.checkArticle({ ...fixture, extra: 1 }).error, "extra");
  assert.equal(rules.checkArticle({ ...fixture, critique: [{ point: "p", category: "proven", why_it_matters: "w" }, ...(fixture.critique as unknown[])] }).error, "critique.0.category");
  assert.equal(rules.checkArticle([]).error, "schema");
});

test("Markdown the draft service would reject is refused", () => {
  const base = rules.checkArticle(fixture).article!;
  assert.equal(rules.unsupportedMarkdown({ ...base, summary: "See <b>this</b>" }), "html");
  assert.equal(rules.unsupportedMarkdown({ ...base, conclusion: "# Heading" }), "heading");
  assert.equal(rules.unsupportedMarkdown({ ...base, summary: "[x](http://example.com)" }), "non-https-link");
  assert.equal(rules.unsupportedMarkdown(base), null);
});

test("length guidance counts words like the Mastra track and only warns", () => {
  const g = rules.lengthGuidance(rules.checkArticle(fixture).article);
  assert.equal(g.warning, "length-outside-guidance"); // the fixture summary is short
  assert.ok(g.summaryWords > 0 && g.conclusionWords > 0);
});

// The Plan node decides each run's single action from stored state. Interrupted calls are tested here
// rather than live, because a live interruption would consume the platform's one live call.
const plan = wf.nodes.find((n) => n.name === "Plan")!.parameters.jsCode!;
const runPlan = (ctx: Record<string, unknown> | null, pinned: Record<string, unknown> = {}) =>
  new Function("$", "$json", "require", plan)(
    (name: string) => ({ first: () => ({ json: name === "Read attempt" ? { result: ctx } : {} }) }),
    pinned,
    (m: string) => (m === "crypto" ? require("node:crypto") : undefined),
  ) as { json: { action: string; reason?: string } }[];
const attempt = (o: Record<string, unknown>) => ({ attempt: "n8n-20261126T000000Z-0000", source_version: "v", store: "live", prompt_identity: "p", ...o });

test("a call still inside its window is reported as in progress and left alone", () => {
  assert.deepEqual(runPlan(attempt({ status: "calling", mode: "live", secondsSinceCallStarted: 60 }))[0]!.json.reason, "model-call-in-progress");
  assert.deepEqual(runPlan(attempt({ status: "calling", mode: "fake", secondsSinceCallStarted: 10 }))[0]!.json.reason, "model-call-in-progress");
});

test("an interrupted live call fails as provider-uncertain and is never resent", () => {
  const r = runPlan(attempt({ status: "calling", mode: "live", secondsSinceCallStarted: 131 }))[0]!.json;
  assert.deepEqual([r.action, r.reason], ["fail", "provider-uncertain"]);
});

test("saved output is reused, a saved article is done, and a failed attempt stays failed", () => {
  assert.equal(runPlan(attempt({ status: "model-done" }))[0]!.json.action, "validate");
  assert.equal(runPlan(attempt({ status: "saved", article_id: "x" }))[0]!.json.action, "done");
  assert.deepEqual(runPlan(attempt({ status: "failed", error: "provider-uncertain" }))[0]!.json.reason, "provider-uncertain");
});

test("empty and oversized sources stop before any call", () => {
  const pending = attempt({ status: "pending", mode: "fake" });
  assert.equal(runPlan(pending, { bundle: { text: "  " } })[0]!.json.reason, "no-usable-text");
  assert.equal(runPlan(pending, { bundle: { text: "x".repeat(60001) } })[0]!.json.reason, "source-too-large");
});

test("a source that cannot be loaded never destroys saved progress", () => {
  assert.equal(runPlan(attempt({ status: "model-done" }), { loadError: "source-unavailable: database down" })[0]!.json.action, "validate");
  const transient = runPlan(attempt({ status: "pending", mode: "fake" }), { loadError: "connect ECONNREFUSED" })[0]!.json;
  assert.deepEqual([transient.action, transient.reason], ["stop", "source-unavailable: connect ECONNREFUSED"]);
  const missing = runPlan(attempt({ status: "pending", mode: "fake" }), { loadError: "not-found: no source version v" })[0]!.json;
  assert.deepEqual([missing.action, missing.reason], ["fail", "not-found: no source version v"]);
});

test("the fake call window outlasts the slowest fake call (60 s)", () => {
  assert.equal(runPlan(attempt({ status: "calling", mode: "fake", secondsSinceCallStarted: 70 }))[0]!.json.reason, "model-call-in-progress");
  assert.equal(runPlan(attempt({ status: "calling", mode: "fake", secondsSinceCallStarted: 76 }))[0]!.json.reason, "interrupted-fake-call");
});

test("the trace carries the pinned source's text source and warnings on every path", () => {
  const pinned = { sha256: "h", warnings: ["text-is-article-description-not-transcript"],
    bundle: { text: "words", title: "T", medium: "video", textSource: "article-html", publishedAt: null } };
  for (const status of ["model-done", "saved"]) {
    const t = (runPlan(attempt({ status, article_id: "x" }), pinned)[0]!.json as unknown as { trace: Record<string, unknown> }).trace;
    assert.deepEqual([t.textSource, t.sourceWarnings], ["article-html", ["text-is-article-description-not-transcript"]]);
  }
});

const loadFailed = wf.nodes.find((n) => n.name === "Load failed")!.parameters.jsCode!;
const mapLoadError = (message: string) =>
  (new Function("$json", "$execution", loadFailed)({ error: { message } }, { id: "42" }) as { json: { loadError: string } }[])[0]!.json.loadError;

test("source-load errors are categorised; dependency details never pass through", () => {
  assert.equal(mapLoadError("not-found: no source version x [line 4]"), "not-found: no source version x");
  assert.equal(mapLoadError("connect ECONNREFUSED 192.168.1.2:5432"), "source-unavailable (execution 42)");
  assert.equal(mapLoadError("password authentication failed for user \"steele\""), "source-unavailable (execution 42)");
});
