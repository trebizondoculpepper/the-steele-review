import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { memoryCheckpoint } from "../src/collections/checkpoint.js";
import { GitRepository } from "../src/common/git/index.js";
import { nameCollections, normaliseCollectionName } from "../src/collections/names.js";
import { reconcileCollections } from "../src/collections/reconcile.js";
import { guardNamespace, SearchIndexError, type IndexDocument, type SearchIndexPort } from "../src/collections/search-index.js";

const NS = "steele-review";

/** In-memory search index that enforces the namespace like the real one. */
class FakeIndex implements SearchIndexPort {
  indexes = new Map<string, { mapping: Record<string, unknown>; docs: Map<string, Record<string, unknown>> }>();
  aliases = new Map<string, string[]>();
  failIds = new Set<string>();
  writes = 0;
  constructor(readonly namespace = NS) {}
  private guard(name: string) {
    return guardNamespace(this.namespace, name);
  }
  async indexExists(index: string) {
    return this.indexes.has(this.guard(index));
  }
  async createIndex(index: string, mapping: Record<string, unknown>) {
    if (this.indexes.has(this.guard(index))) throw new Error("exists");
    this.indexes.set(index, { mapping, docs: new Map() });
  }
  async aliasTargets(alias: string) {
    return this.aliases.get(this.guard(alias)) ?? [];
  }
  async pointAlias(alias: string, index: string) {
    this.aliases.set(this.guard(alias), [this.guard(index)]);
  }
  async indexDocuments(index: string, documents: readonly IndexDocument[]) {
    const target = this.indexes.get(this.guard(index))!;
    const failed: string[] = [];
    for (const d of documents) {
      if (this.failIds.has(d.id)) failed.push(d.id);
      else (target.docs.set(d.id, d.body), this.writes++);
    }
    return failed;
  }
  async deleteDocument(index: string, id: string) {
    this.indexes.get(this.guard(index))!.docs.delete(id);
    this.writes++;
  }
  refreshed: string[] = [];
  async refresh(index: string) {
    this.refreshed.push(this.guard(index));
  }
  /** Documents readers see through an alias. */
  read(alias: string) {
    const [backing] = this.aliases.get(alias) ?? [];
    return backing ? this.indexes.get(backing)!.docs : undefined;
  }
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), "collections-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const remove = (path: string) => rmSync(join(root, path));
  const commit = (message = "change") => (git("add", "-A"), git("commit", "-q", "--allow-empty", "-m", message), git("rev-parse", "HEAD"));
  const declare = (dir: string, version: number, properties: Record<string, unknown>) =>
    write(`${dir}/collection.json`, { mappingVersion: version, mapping: { dynamic: "strict", properties } });
  return { root, write, remove, commit, declare, git };
}

function harness() {
  const r = repo();
  const index = new FakeIndex();
  const checkpoint = memoryCheckpoint();
  const run = (rebuild?: readonly string[] | "all") =>
    reconcileCollections({ repo: new GitRepository(r.root), index, checkpoint, namespace: NS, rebuild });
  return { ...r, index, checkpoint, run };
}

test("each collection gets its own alias and backing index with its declared mapping, including an empty one", async () => {
  const h = harness();
  h.declare("raw-content", 1, { title: { type: "text" } });
  h.declare("research", 3, { claim: { type: "keyword" } });
  h.declare("empty", 1, {});
  h.write("raw-content/saveusnow/1.json", { title: "One" });
  h.write("raw-content/saveusnow/nested/2.json", { title: "Two" });
  h.write("research/a.json", { claim: "x" });
  h.write("research/notes.txt", "not a document");
  const head = h.commit();

  const report = await h.run();
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.collections.map((c) => [c.alias, c.backing, c.action, c.indexed]),
    [
      ["steele-review-empty", "steele-review-empty-v1", "built", 0],
      ["steele-review-raw-content", "steele-review-raw-content-v1", "built", 2],
      ["steele-review-research", "steele-review-research-v3", "built", 1],
    ],
  );
  const raw = h.index.indexes.get("steele-review-raw-content-v1")!;
  const research = h.index.indexes.get("steele-review-research-v3")!;
  assert.deepEqual(Object.keys(raw.mapping.properties as object), ["title", "provenance"]);
  assert.deepEqual(Object.keys(research.mapping.properties as object), ["claim", "provenance"]);
  assert.deepEqual([...h.index.read("steele-review-raw-content")!.keys()].sort(), ["saveusnow/1.json", "saveusnow/nested/2.json"]);
  assert.deepEqual(h.index.read("steele-review-raw-content")!.get("saveusnow/1.json")!.provenance, {
    collection: "raw-content",
    path: "saveusnow/1.json",
    revision: head,
    blob: h.git("rev-parse", `${head}:raw-content/saveusnow/1.json`),
  });
  assert.equal(h.index.read("steele-review-empty")!.size, 0);
  assert.equal(h.checkpoint.state!.collections["research"]!.live!.commit, head);
});

test("a missed notification is caught up: one pass applies every commit since the checkpoint", async () => {
  const h = harness();
  h.declare("feeds", 1, { title: { type: "text" } });
  h.write("feeds/a.json", { title: "A" });
  h.write("feeds/b.json", { title: "B" });
  h.commit();
  await h.run();

  h.write("feeds/a.json", { title: "A, edited" });
  h.commit("edit a"); // its notification is lost
  h.remove("feeds/b.json");
  h.write("feeds/c.json", { title: "C" });
  const head = h.commit("remove b, add c");

  const report = await h.run();
  assert.equal(report.ok, true);
  assert.deepEqual(report.collections.map((c) => [c.action, c.indexed, c.deleted]), [["updated", 2, 1]]);
  const docs = h.index.read("steele-review-feeds")!;
  assert.deepEqual([...docs.keys()].sort(), ["a.json", "c.json"]);
  assert.equal(docs.get("a.json")!.title, "A, edited");
  assert.equal((docs.get("a.json")!.provenance as { revision: string }).revision, head);

  const writes = h.index.writes;
  const again = await h.run();
  assert.deepEqual(again.collections.map((c) => c.action), ["unchanged"]);
  assert.equal(h.index.writes, writes, "an unchanged repository makes no writes");
});

test("a new mapping version builds a new backing index and switches the alias; the old index is kept", async () => {
  const h = harness();
  h.declare("feeds", 1, { title: { type: "text" } });
  h.write("feeds/a.json", { title: "A" });
  h.commit();
  await h.run();

  h.declare("feeds", 2, { title: { type: "keyword" } });
  h.commit("remap");
  const report = await h.run();
  assert.deepEqual(report.collections.map((c) => [c.action, c.backing, c.indexed]), [["rebuilt", "steele-review-feeds-v2", 1]]);
  assert.deepEqual(h.index.aliases.get("steele-review-feeds"), ["steele-review-feeds-v2"]);
  assert.ok(h.index.indexes.has("steele-review-feeds-v1"), "the previous backing index stays intact");
  assert.equal(h.index.indexes.get("steele-review-feeds-v1")!.docs.size, 1);
});

test("an explicit rebuild at the same version uses a fresh backing index", async () => {
  const h = harness();
  h.declare("feeds", 1, { title: { type: "text" } });
  h.write("feeds/a.json", { title: "A" });
  h.commit();
  await h.run();
  const report = await h.run(["feeds"]);
  assert.deepEqual(report.collections.map((c) => [c.action, c.backing]), [["rebuilt", "steele-review-feeds-v1-r1"]]);
  assert.deepEqual(h.index.aliases.get("steele-review-feeds"), ["steele-review-feeds-v1-r1"]);
  assert.equal(h.index.read("steele-review-feeds")!.size, 1);
});

test("a lost index or a rewritten history triggers a rebuild from the current tree", async () => {
  const h = harness();
  h.declare("feeds", 1, { title: { type: "text" } });
  h.write("feeds/a.json", { title: "A" });
  h.commit();
  await h.run();
  h.index.indexes.delete("steele-review-feeds-v1");
  h.index.aliases.delete("steele-review-feeds");
  assert.deepEqual((await h.run()).collections.map((c) => [c.action, c.backing]), [["rebuilt", "steele-review-feeds-v1-r1"]]);

  h.write("feeds/b.json", { title: "B" });
  h.git("add", "-A");
  h.git("commit", "-q", "--amend", "-m", "rewritten");
  h.git("reflog", "expire", "--expire=now", "--all");
  h.git("gc", "-q", "--prune=now");
  const report = await h.run();
  assert.deepEqual(report.collections.map((c) => c.action), ["rebuilt"]);
  assert.deepEqual([...h.index.read("steele-review-feeds")!.keys()].sort(), ["a.json", "b.json"]);
});

test("a new collection directory is picked up by the next pass", async () => {
  const h = harness();
  h.declare("feeds", 1, {});
  h.commit();
  await h.run();
  h.declare("research", 1, { claim: { type: "keyword" } });
  h.write("research/a.json", { claim: "x" });
  h.commit();
  const report = await h.run();
  assert.deepEqual(report.collections.map((c) => [c.directory, c.action]), [["feeds", "unchanged"], ["research", "built"]]);
});

test("invalid names, collisions and undeclared collections are rejected before any index is made", async () => {
  const h = harness();
  h.declare("Raw Content", 1, {});
  h.declare("raw-content", 1, {});
  h.declare("___", 1, {});
  h.write("undeclared/a.json", { a: 1 });
  h.write("badly-declared/collection.json", { mappingVersion: 1, mapping: { properties: { provenance: { type: "keyword" } } } });
  h.commit();
  const report = await h.run();
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.rejected.map((r) => `${r.directory}:${r.reason}`).sort(),
    ["Raw Content:name-collision", "___:invalid-name", "badly-declared:invalid-declaration", "raw-content:name-collision", "undeclared:missing-declaration"],
  );
  assert.equal(h.index.indexes.size, 0);
  assert.equal(normaliseCollectionName("Raw Content"), "raw-content");
  assert.deepEqual(nameCollections(NS, [".github", "ok"]).collections.map((c) => c.name), ["ok"]);
});

test("a failed write keeps the checkpoint, and the next pass retries it", async () => {
  const h = harness();
  h.declare("feeds", 1, { title: { type: "text" } });
  h.write("feeds/a.json", { title: "A" });
  const first = h.commit();
  await h.run();
  h.write("feeds/b.json", { title: "B" });
  h.write("feeds/c.json", "not json");
  h.commit();
  h.index.failIds.add("b.json");
  const failed = await h.run();
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.collections[0]!.failed.map((f) => `${f.path}:${f.reason}`).sort(), ["feeds/b.json:index-failed", "feeds/c.json:not-json-object"]);
  assert.equal(h.checkpoint.state!.collections["feeds"]!.live!.commit, first);

  h.index.failIds.clear();
  h.write("feeds/c.json", { title: "C" });
  const head = h.commit();
  const retried = await h.run();
  assert.equal(retried.ok, true);
  assert.deepEqual([...h.index.read("steele-review-feeds")!.keys()].sort(), ["a.json", "b.json", "c.json"]);
  assert.equal(h.checkpoint.state!.collections["feeds"]!.live!.commit, head);
});

test("a failed build leaves readers on the previous index", async () => {
  const h = harness();
  h.declare("feeds", 1, { title: { type: "text" } });
  h.write("feeds/a.json", { title: "A" });
  h.commit();
  await h.run();
  h.declare("feeds", 2, { title: { type: "keyword" } });
  h.commit();
  h.index.failIds.add("a.json");
  const report = await h.run();
  assert.deepEqual(report.collections.map((c) => c.action), ["failed"]);
  assert.deepEqual(h.index.aliases.get("steele-review-feeds"), ["steele-review-feeds-v1"]);
  assert.equal(h.checkpoint.state!.collections["feeds"]!.live!.backing, "steele-review-feeds-v1");
});

test("reconciliation never touches indexes outside its namespace", async () => {
  const h = harness();
  h.index.indexes.set("steele-source-text-v1", { mapping: {}, docs: new Map([["x", { keep: true }]]) });
  h.index.aliases.set("steele-source-text", ["steele-source-text-v1"]);
  h.declare("feeds", 1, {});
  h.write("feeds/a.json", { a: 1 });
  h.commit();
  await h.run();
  await h.run("all");
  assert.deepEqual([...h.index.indexes.get("steele-source-text-v1")!.docs.keys()], ["x"]);
  assert.deepEqual(h.index.aliases.get("steele-source-text"), ["steele-source-text-v1"]);
  assert.ok([...h.index.indexes.keys()].filter((k) => k !== "steele-source-text-v1").every((k) => k.startsWith(`${NS}-`)));
  assert.throws(() => guardNamespace(NS, "steele-source-text-v1"), SearchIndexError);
  await assert.rejects(h.index.createIndex("other-index", {}), SearchIndexError);
});

test("a removed collection keeps its index and is reported", async () => {
  const h = harness();
  h.declare("feeds", 1, {});
  h.write("feeds/a.json", { a: 1 });
  h.commit();
  await h.run();
  h.remove("feeds/a.json");
  h.remove("feeds/collection.json");
  h.commit();
  const report = await h.run();
  assert.deepEqual(report.removed, ["feeds"]);
  assert.equal(h.index.read("steele-review-feeds")!.size, 1);
});

test("an empty repository is a no-op, and a checkpoint from another namespace is refused", async () => {
  const h = harness();
  assert.deepEqual(await h.run(), { ok: true, collections: [], rejected: [], removed: [] });
  const other = memoryCheckpoint({ schemaVersion: 1, namespace: "elsewhere", collections: {} });
  await assert.rejects(reconcileCollections({ repo: new GitRepository(h.root), index: h.index, checkpoint: other, namespace: NS }), /different namespace/);
});

test("paths from consecutive failed passes are never forgotten (review on #947)", async () => {
  const h = harness();
  h.declare("feeds", 1, { title: { type: "text" } });
  h.write("feeds/a.json", { title: "A" });
  h.commit();
  await h.run();

  // Pass 1: x is indexed, y fails.
  h.write("feeds/x.json", { title: "X" });
  h.write("feeds/y.json", { title: "Y" });
  h.commit();
  h.index.failIds.add("y.json");
  assert.equal((await h.run()).ok, false);
  assert.ok(h.index.read("steele-review-feeds")!.has("x.json"));

  // Pass 2: x is removed from Git, but its deletion fails.
  h.remove("feeds/x.json");
  h.commit();
  const deleteDocument = h.index.deleteDocument.bind(h.index);
  h.index.deleteDocument = async () => {
    throw new Error("unavailable");
  };
  assert.equal((await h.run()).ok, false);

  // Pass 3: everything works again. x must not survive.
  h.index.deleteDocument = deleteDocument;
  h.index.failIds.clear();
  const report = await h.run();
  assert.equal(report.ok, true);
  assert.deepEqual([...h.index.read("steele-review-feeds")!.keys()].sort(), ["a.json", "y.json"]);
  assert.equal(h.checkpoint.state!.collections["feeds"]!.live!.touched, undefined);
});

test("documents written by a partial pass are removed when that revision is reset away (review on #947)", async () => {
  const h = harness();
  h.declare("feeds", 1, { title: { type: "text" } });
  h.write("feeds/a.json", { title: "A" });
  const good = h.commit();
  await h.run();

  h.write("feeds/x.json", { title: "X" });
  h.write("feeds/y.json", { title: "Y" });
  h.commit();
  h.index.failIds.add("y.json");
  assert.equal((await h.run()).ok, false);
  assert.ok(h.index.read("steele-review-feeds")!.has("x.json"));

  h.git("reset", "-q", "--hard", good);
  h.index.failIds.clear();
  const report = await h.run();
  assert.equal(report.ok, true);
  assert.deepEqual([...h.index.read("steele-review-feeds")!.keys()], ["a.json"]);
});

test("a build that keeps failing reuses one staging index instead of making one per pass (review on #947)", async () => {
  const h = harness();
  h.declare("feeds", 1, { title: { type: "text" } });
  h.write("feeds/a.json", { title: "A" });
  h.write("feeds/bad.json", "not json");
  h.commit();
  for (let i = 0; i < 3; i++) assert.deepEqual((await h.run()).collections.map((c) => c.action), ["failed"]);
  assert.deepEqual([...h.index.indexes.keys()], ["steele-review-feeds-v1"]);
  assert.equal(h.index.aliases.get("steele-review-feeds"), undefined, "readers never see an incomplete index");

  // The fix lands in a later commit, and a document is removed meanwhile.
  h.remove("feeds/bad.json");
  h.remove("feeds/a.json");
  h.write("feeds/b.json", { title: "B" });
  h.commit();
  const report = await h.run();
  assert.deepEqual(report.collections.map((c) => [c.action, c.backing]), [["built", "steele-review-feeds-v1"]]);
  assert.deepEqual([...h.index.read("steele-review-feeds")!.keys()], ["b.json"], "documents gone from Git do not survive in the reused index");
  assert.equal(h.checkpoint.state!.collections["feeds"]!.staging, undefined);
});

test("the Elasticsearch connection is read from the configuration directory on each pass (review on #947)", async () => {
  const { createServer } = await import("node:http");
  const { ConfigDirectory, ConfigError } = await import("../src/common/config/index.js");
  const { elasticsearchClient } = await import("../src/collections/index.js");
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "application/json", "x-elastic-product": "Elasticsearch" });
    res.end(JSON.stringify({ name: "stub", cluster_name: "stub", cluster_uuid: "x", version: { number: "8.19.2" }, tagline: "" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const root = mkdtempSync(join(tmpdir(), "es-config-"));
  mkdirSync(join(root, "elasticsearch"));
  const config = new ConfigDirectory(root);
  const writeConfig = (connection: unknown, key?: string) => {
    writeFileSync(join(root, "elasticsearch/connection.json"), JSON.stringify(connection));
    if (key !== undefined) writeFileSync(join(root, "elasticsearch/api.key"), key);
  };
  try {
    writeConfig({ url: `http://127.0.0.1:${port}`, apiKeyFile: "elasticsearch/api.key" }, "fixture-key-one\n");
    let client = await elasticsearchClient(config);
    await client.info();
    await client.close();
    writeConfig({ url: `http://127.0.0.1:${port}`, apiKeyFile: "elasticsearch/api.key" }, "fixture-key-two");
    client = await elasticsearchClient(config);
    await client.info();
    await client.close();
    assert.deepEqual(seen, ["ApiKey fixture-key-one", "ApiKey fixture-key-two"]);

    rmSync(join(root, "elasticsearch/api.key"));
    await assert.rejects(elasticsearchClient(config), (e: unknown) => e instanceof ConfigError && e.code === "missing" && !/fixture/.test(e.message));
    writeConfig({ url: "http://user:fixture-secret@127.0.0.1:1" });
    await assert.rejects(elasticsearchClient(config), (e: unknown) => e instanceof ConfigError && e.code === "invalid" && !/fixture-secret/.test(e.message));
  } finally {
    server.close();
  }
});

test("a staging deletion that fails is retried until the build is promoted (review on #947)", async () => {
  const h = harness();
  h.declare("feeds", 1, { title: { type: "text" } });
  h.write("feeds/x.json", { title: "X" });
  h.write("feeds/bad.json", "not json");
  h.commit();
  assert.deepEqual((await h.run()).collections.map((c) => c.action), ["failed"]);
  assert.ok(h.index.indexes.get("steele-review-feeds-v1")!.docs.has("x.json"));

  h.remove("feeds/x.json");
  h.commit();
  const deleteDocument = h.index.deleteDocument.bind(h.index);
  h.index.deleteDocument = async () => {
    throw new Error("unavailable");
  };
  assert.deepEqual((await h.run()).collections.map((c) => c.action), ["failed"]);
  assert.deepEqual(h.checkpoint.state!.collections["feeds"]!.staging!.touched, ["feeds/x.json"]);

  h.index.deleteDocument = deleteDocument;
  h.remove("feeds/bad.json");
  h.commit();
  const report = await h.run();
  assert.deepEqual(report.collections.map((c) => [c.action, c.backing]), [["built", "steele-review-feeds-v1"]]);
  assert.equal(h.index.read("steele-review-feeds")!.has("x.json"), false);
});

test("collection names that look like backing indexes are rejected (review on #947)", async () => {
  const h = harness();
  h.declare("feeds", 1, {});
  h.declare("feeds-v1", 1, {});
  h.declare("feeds-v2-r3", 1, {});
  h.declare("v1", 1, {});
  h.commit();
  const report = await h.run();
  assert.deepEqual(report.rejected.map((r) => `${r.directory}:${r.reason}`).sort(), ["feeds-v1:reserved-suffix", "feeds-v2-r3:reserved-suffix"]);
  assert.deepEqual(report.collections.map((c) => c.alias), ["steele-review-feeds", "steele-review-v1"]);
});

test("an unfinished explicit rebuild is resumed by later passes without being requested again (review on #947)", async () => {
  const h = harness();
  h.declare("feeds", 1, { title: { type: "text" } });
  h.write("feeds/a.json", { title: "A" });
  h.commit();
  await h.run();
  h.index.failIds.add("a.json");
  assert.deepEqual((await h.run(["feeds"])).collections.map((c) => c.action), ["failed"]);
  h.index.failIds.clear();
  const report = await h.run();
  assert.deepEqual(report.collections.map((c) => [c.action, c.backing]), [["rebuilt", "steele-review-feeds-v1-r1"]]);
  assert.deepEqual(h.index.aliases.get("steele-review-feeds"), ["steele-review-feeds-v1-r1"]);
  assert.deepEqual((await h.run()).collections.map((c) => c.action), ["unchanged"]);
});

test("directory names that cannot be checkpoint keys are rejected (review on #947)", async () => {
  const h = harness();
  h.declare("__proto__", 1, {});
  h.declare("_drafts", 1, {});
  h.declare("feeds", 1, {});
  h.commit();
  const report = await h.run();
  assert.deepEqual(report.rejected.map((r) => `${r.directory}:${r.reason}`).sort(), ["__proto__:invalid-name", "_drafts:invalid-name"]);
  assert.deepEqual(Object.keys(h.checkpoint.state!.collections), ["feeds"]);
  assert.deepEqual((await h.run()).collections.map((c) => c.action), ["unchanged"]);
});

test("a build promoted just before an interrupted save is recognised as live (review on #947)", async () => {
  const h = harness();
  h.declare("feeds", 1, { title: { type: "text" } });
  h.write("feeds/a.json", { title: "A" });
  const first = h.commit();
  // Interrupt the pass straight after the alias switch, before the checkpoint records it.
  const pointAlias = h.index.pointAlias.bind(h.index);
  h.index.pointAlias = async (alias, index) => {
    await pointAlias(alias, index);
    throw new Error("interrupted");
  };
  assert.deepEqual((await h.run()).collections.map((c) => c.action), ["failed"]);
  h.index.pointAlias = pointAlias;
  assert.equal(h.checkpoint.state!.collections["feeds"]!.staging!.backing, "steele-review-feeds-v1");

  h.write("feeds/a.json", { title: "A2" });
  h.write("feeds/b.json", { title: "B" });
  h.commit();
  h.index.failIds.add("b.json");
  const report = await h.run();
  assert.deepEqual(report.collections.map((c) => c.action), ["updated"]);
  const state = h.checkpoint.state!.collections["feeds"]!;
  assert.equal(state.staging, undefined);
  assert.equal(state.live!.commit, first, "the failed update does not advance the checkpoint");
  assert.deepEqual(state.live!.touched, ["feeds/a.json", "feeds/b.json"]);
  h.index.failIds.clear();
  assert.equal((await h.run()).ok, true);
  assert.deepEqual([...h.index.read("steele-review-feeds")!.keys()].sort(), ["a.json", "b.json"]);
});

test("a missing or broken repository is a failure, not an empty pass (review on #947)", async () => {
  const index = new FakeIndex();
  const missing = join(tmpdir(), `no-such-collections-${process.pid}`);
  await assert.rejects(
    reconcileCollections({ repo: new GitRepository(missing), index, checkpoint: memoryCheckpoint(), namespace: NS }),
    (e: unknown) => e instanceof Error && e.name === "GitError" && !e.message.includes(missing),
  );
  const notRepo = mkdtempSync(join(tmpdir(), "not-a-repo-"));
  await assert.rejects(reconcileCollections({ repo: new GitRepository(notRepo), index, checkpoint: memoryCheckpoint(), namespace: NS }));
});

test("one collection's technical failure does not stop the others (review on #947)", async () => {
  const h = harness();
  h.declare("alpha", 1, {});
  h.declare("beta", 1, {});
  h.write("alpha/a.json", { a: 1 });
  h.write("beta/b.json", { b: 1 });
  h.commit();
  const createIndex = h.index.createIndex.bind(h.index);
  h.index.createIndex = async (index, mapping) => {
    if (index.includes("alpha")) throw new Error("cluster unavailable");
    return createIndex(index, mapping);
  };
  const report = await h.run();
  assert.equal(report.ok, false);
  assert.deepEqual(report.collections.map((c) => [c.directory, c.action]), [["alpha", "failed"], ["beta", "built"]]);
  assert.deepEqual(report.collections[0]!.failed, [{ path: "alpha", reason: "index-failed" }]);
  h.index.createIndex = createIndex;
  assert.equal((await h.run()).ok, true);
  assert.equal(h.index.read("steele-review-alpha")!.size, 1);
});

test("a new index is refreshed before readers are switched to it, and declarations need object field mappings (review on #947)", async () => {
  const h = harness();
  h.declare("feeds", 1, { title: { type: "text" } });
  h.write("feeds/a.json", { title: "A" });
  h.write("bad/collection.json", { mappingVersion: 1, mapping: { properties: { title: "text" } } });
  h.commit();
  const report = await h.run();
  assert.deepEqual(h.index.refreshed, ["steele-review-feeds-v1"]);
  assert.deepEqual(report.rejected, [{ directory: "bad", reason: "invalid-declaration" }]);
});

test("the file checkpoint is written atomically and leaves no temporary file behind (review on #947)", async () => {
  const { fileCheckpoint } = await import("../src/collections/checkpoint.js");
  const { readdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "checkpoint-"));
  const store = fileCheckpoint(join(dir, "state", "collection-index.json"));
  assert.equal(await store.load(), undefined);
  await store.save({ schemaVersion: 1, namespace: NS, collections: {} });
  assert.deepEqual(await store.load(), { schemaVersion: 1, namespace: NS, collections: {} });
  assert.deepEqual(readdirSync(join(dir, "state")), ["collection-index.json"]);
  const blocked = fileCheckpoint(join(dir, "state", "collection-index.json", "nested.json"));
  await assert.rejects(blocked.save({ schemaVersion: 1, namespace: NS, collections: {} }));
  assert.deepEqual(readdirSync(join(dir, "state")), ["collection-index.json"]);
});
