// Contract tests for the n8n writing code (#916): the shared article rules, taken from the
// Git-defined workflow, must render the shared article fixture to exactly its expected Markdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
