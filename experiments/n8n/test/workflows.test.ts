// Static checks of the Git-defined workflows (run: node --test experiments/n8n/test/*.test.ts).
// They catch what n8n would otherwise only report at run time: Code nodes that do not
// parse, broken connections, duplicate IDs, and published IDs with no definition.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../workflows/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
interface WorkflowNode {
  name: string;
  parameters: { jsCode?: unknown };
}
interface Workflow {
  id: string;
  nodes: WorkflowNode[];
  connections: Record<string, { main: { node: string }[][] }>;
}
// n8n runs every Code node inside an async function, so top-level await is allowed.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => unknown;
const workflows: { file: string; wf: Workflow }[] = files.map((f) => ({ file: f, wf: JSON.parse(readFileSync(dir + f, "utf8")) as Workflow }));

test("every workflow has a unique, stable ID", () => {
  const ids = workflows.map(({ wf }) => wf.id);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9]{16,}$/);
  assert.equal(new Set(ids).size, ids.length);
});

test("every published ID has a definition", () => {
  const ids = new Set(workflows.map(({ wf }) => wf.id));
  const published = readFileSync(dir + "published.txt", "utf8").split("\n").filter(Boolean);
  for (const id of published) assert.ok(ids.has(id), `${id} is published but not defined`);
});

for (const { file, wf } of workflows) {
  test(`${file}: Code nodes parse and connections name real nodes`, () => {
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const n of wf.nodes)
      if (typeof n.parameters.jsCode === "string")
        assert.doesNotThrow(() => new AsyncFunction("$", "$json", "$execution", "require", n.parameters.jsCode), `${n.name} does not parse`);
    for (const [from, c] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), `connection from unknown node ${from}`);
      for (const out of c.main) for (const t of out) assert.ok(names.has(t.node), `connection to unknown node ${t.node}`);
    }
  });

  test(`${file}: no secrets or private addresses in the definition`, () => {
    const text = JSON.stringify(wf);
    assert.doesNotMatch(text, /\b(?:100|192\.168|10)\.\d+\.\d+\.\d+\b/);
    assert.doesNotMatch(text, /password"\s*:\s*"[^"]/i);
  });
}
