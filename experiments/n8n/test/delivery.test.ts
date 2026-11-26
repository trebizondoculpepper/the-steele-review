// Decision rules of the n8n delivery loop (#917), taken from the Git-defined workflow: bounded tries,
// reconciliation before any re-create, and success only with strict readback evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Node { name: string; parameters: { jsCode?: string } }
const wf = JSON.parse(readFileSync(fileURLToPath(new URL("../workflows/delivery-deliver.json", import.meta.url)), "utf8")) as { nodes: Node[] };
const js = (name: string) => wf.nodes.find((n) => n.name === name)!.parameters.jsCode!;
type State = Record<string, unknown>;
const next = (s: State) => (new Function("$json", js("Next step"))(s) as { json: State }[])[0]!.json;
const outcome = (s: State) => (new Function("$json", js("Outcome"))(s) as { json: State }[])[0]!.json;
const ok = { titleMatches: true, published: false, emailSent: false };
const base: State = { tries: 0, mustReconcile: false, maybeCreated: false, readbackTried: false, last: null, history: [], request: { source: {}, article: "a" } };

test("the first step delivers; an unanswered create is reconciled, never re-created", () => {
  assert.equal(next(base).action, "deliver");
  assert.equal(next({ ...base, tries: 1, mustReconcile: true, maybeCreated: true }).action, "reconcile");
});

test("tries are bounded at three, and an unanswered create ends uncertain", () => {
  const s = { ...base, tries: 3, mustReconcile: true, maybeCreated: true };
  assert.equal(next(s).action, "finish");
  assert.equal(outcome(s).status, "uncertain");
});

test("conflict, invalid and forbidden are never retried", () => {
  for (const status of ["conflict", "invalid", "forbidden"]) assert.equal(next({ ...base, tries: 1, last: { status } }).action, "finish");
});

test("success needs strict readback evidence, with one fresh readback if it is missing", () => {
  const created = { ...base, tries: 1, last: { status: "created", readback: null } };
  assert.equal(next(created).action, "status");
  assert.equal(next({ ...created, readbackTried: true }).action, "finish");
  assert.equal(outcome({ ...created, readbackTried: true }).status, "unverified");
  assert.equal(outcome({ ...base, tries: 1, last: { status: "created", readback: { ...ok, published: "false" } } }).status, "unverified");
  assert.equal(outcome({ ...base, tries: 1, last: { status: "existing", readback: ok } }).status, "existing");
});

test("the result never carries the private editor link", () => {
  const o = outcome({ ...base, tries: 1, last: { status: "created", readback: ok, editorUrl: "https://private.example/draft" } });
  assert.equal(JSON.stringify(o).includes("private.example"), false);
});
