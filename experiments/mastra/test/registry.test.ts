import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the reset pilot registers exactly one workflow, Poll Substack Feeds: the poller, then the content fetcher (#944, #953)", async () => {
  process.env.STEELE_EXP_MASTRA_DB = `file:${join(mkdtempSync(join(tmpdir(), "registry-")), "mastra.db")}`;
  const { mastra } = await import("../src/mastra/index.js");
  const workflows = mastra.listWorkflows();
  assert.deepEqual(Object.keys(workflows), ["pollSubstackFeeds", "proposeThemes", "extractClaims"]);
  const workflow = workflows.pollSubstackFeeds!;
  assert.equal(workflow.id, "Poll Substack Feeds");
  assert.deepEqual(
    workflow.stepGraph.map((entry) => (entry.type === "step" ? entry.step.id : entry.type)),
    ["poll-substack-feeds", "fetch-substack-content"],
  );
  assert.equal(workflows.proposeThemes!.id, "Propose Themes");
  assert.deepEqual(workflows.proposeThemes!.stepGraph.map((e) => (e.type === "step" ? e.step.id : e.type)), ["propose-themes"]);
  assert.equal(workflows.extractClaims!.id, "Extract Claims");
  assert.deepEqual(workflows.extractClaims!.stepGraph.map((e) => (e.type === "step" ? e.step.id : e.type)), ["extract-claims"]);
});
