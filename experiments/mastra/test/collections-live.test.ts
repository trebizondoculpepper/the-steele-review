import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@elastic/elasticsearch";

import { memoryCheckpoint } from "../src/collections/checkpoint.js";
import { GitRepository } from "../src/collections/git.js";
import { reconcileCollections } from "../src/collections/reconcile.js";
import { ElasticsearchIndex } from "../src/collections/search-index.js";

/**
 * Live check of the Elasticsearch adapter (#942) against a disposable cluster.
 * Skipped unless STEELE_TEST_ELASTICSEARCH_URL is set. Never point it at a
 * shared cluster: it creates and deletes indexes under a test namespace.
 */
const url = process.env.STEELE_TEST_ELASTICSEARCH_URL;

test("two collections, distinct mappings, a missed notification and a rebuild against real Elasticsearch", { skip: !url }, async () => {
  const namespace = `steele-review-livetest-${process.pid}`;
  const client = new Client({ node: url! });
  const foreign = `${namespace.replace("steele-review", "foreign")}-keep`;
  await client.indices.create({ index: foreign });
  await client.index({ index: foreign, id: "x", document: { keep: true }, refresh: true });

  const root = mkdtempSync(join(tmpdir(), "collections-live-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value));
  };
  const commit = () => (git("add", "-A"), git("commit", "-q", "-m", "c"), git("rev-parse", "HEAD"));
  const run = (checkpoint: ReturnType<typeof memoryCheckpoint>, rebuild?: string[]) =>
    reconcileCollections({ repo: new GitRepository(root), index: new ElasticsearchIndex(client, namespace), checkpoint, namespace, rebuild });
  const search = async (alias: string) => {
    await client.indices.refresh({ index: alias });
    const r = await client.search({ index: alias, size: 100, sort: [{ "provenance.path": "asc" }] });
    return r.hits.hits.map((h) => h._id);
  };

  try {
    write("raw-content/collection.json", { mappingVersion: 1, mapping: { dynamic: "strict", properties: { title: { type: "text" } } } });
    write("research/collection.json", { mappingVersion: 2, mapping: { dynamic: "strict", properties: { claim: { type: "keyword" } } } });
    write("raw-content/a.json", { title: "A" });
    write("research/r.json", { claim: "x" });
    commit();
    const checkpoint = memoryCheckpoint();
    assert.equal((await run(checkpoint)).ok, true);

    const mappings = await client.indices.getMapping({ index: `${namespace}-*` });
    assert.equal((mappings[`${namespace}-raw-content-v1`]!.mappings.properties!.title as { type: string }).type, "text");
    assert.equal((mappings[`${namespace}-research-v2`]!.mappings.properties!.claim as { type: string }).type, "keyword");

    write("raw-content/b.json", { title: "B" });
    commit(); // missed notification
    write("raw-content/c.json", { title: "C" });
    const head = commit();
    const caughtUp = await run(checkpoint);
    assert.equal(caughtUp.ok, true);
    assert.deepEqual(await search(`${namespace}-raw-content`), ["a.json", "b.json", "c.json"]);

    // The strict mapping rejects an undeclared field: reported, checkpoint held.
    write("raw-content/d.json", { title: "D", extra: 1 });
    commit();
    const rejected = await run(checkpoint);
    assert.deepEqual(rejected.collections.find((c) => c.directory === "raw-content")!.failed, [{ path: "raw-content/d.json", reason: "index-failed" }]);
    assert.equal(checkpoint.state!.collections["raw-content"]!.live!.commit, head);

    write("raw-content/d.json", { title: "D" });
    commit();
    const rebuilt = await run(checkpoint, ["raw-content"]);
    assert.equal(rebuilt.ok, true);
    assert.deepEqual(Object.keys(await client.indices.getAlias({ name: `${namespace}-raw-content` })), [`${namespace}-raw-content-v1-r1`]);
    assert.ok(await client.indices.exists({ index: `${namespace}-raw-content-v1` }), "the previous backing index is kept");
    assert.deepEqual(await search(`${namespace}-raw-content`), ["a.json", "b.json", "c.json", "d.json"]);

    assert.equal((await client.get({ index: foreign, id: "x" }))._source !== undefined, true, "indexes outside the namespace are untouched");
  } finally {
    // Elasticsearch 8 refuses wildcard deletes by default: delete by exact name.
    const created = Object.keys(await client.indices.get({ index: `${namespace}-*`, ignore_unavailable: true, allow_no_indices: true }));
    if (created.length) await client.indices.delete({ index: created });
    await client.indices.delete({ index: foreign, ignore_unavailable: true });
    await client.close();
  }
});
