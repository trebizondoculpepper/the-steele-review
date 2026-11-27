import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigDirectory } from "../src/common/config/index.js";
import { GitRepository } from "../src/common/git/index.js";
import { pollSubstackFeeds, recordPath } from "../src/feed/substack-poller.js";
import { createPollSubstackFeedsStep, PollSubstackFeedsOutput } from "../src/mastra/steps/poll-substack-feeds.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const feedXml = (name: string) => readFileSync(join(fixtures, "feeds", `${name}.xml`), "utf8");

/** A fake network: each feed URL answers with a fixture, an HTTP status, or a failure. */
function network(routes: Record<string, string | number | Error>) {
  const requested: string[] = [];
  const fake = (async (input: string | URL) => {
    const url = String(input);
    requested.push(url);
    const route = routes[url];
    if (route === undefined) throw new Error("unexpected request");
    if (route instanceof Error) throw route;
    if (typeof route === "number") return new Response("", { status: route });
    return new Response(route, { status: 200, headers: { "content-type": "application/rss+xml" } });
  }) as typeof fetch;
  return { fetch: fake, requested, routes };
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "poller-collections-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", root]);
  const repo = new GitRepository(root);
  const config = new ConfigDirectory(join(fixtures, "config", "poller"));
  const net = network({ "https://alpha.example.org/feed": feedXml("alpha"), "https://beta.example.org/feed": feedXml("beta") });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const poll = () => pollSubstackFeeds({ config, repo, fetch: net.fetch });
  return { repo, config, net, git, poll };
}

test("the first poll records every item of both configured feeds in one commit", async () => {
  const h = harness();
  const report = await h.poll();
  assert.equal(report.ok, true);
  assert.deepEqual(report.sources, [
    { sourceId: "alpha", status: "ok", items: 2, new: 2, changed: 0, unchanged: 0 },
    { sourceId: "beta", status: "ok", items: 1, new: 1, changed: 0, unchanged: 0 },
  ]);
  assert.deepEqual(
    report.committed.map((c) => `${c.change} ${c.path}`),
    ["new feeds/alpha/first-post.json", "new feeds/alpha/second-post.json", "new feeds/beta/undated.json"],
  );
  assert.ok(report.committed.every((c) => c.commit === report.commit));
  assert.equal(h.git("rev-list", "--count", "main"), "1");
  assert.deepEqual(h.net.requested.sort(), ["https://alpha.example.org/feed", "https://beta.example.org/feed"], "the disabled source is not polled");

  const first = JSON.parse((await h.repo.readText(report.commit!, recordPath("alpha", "first-post")))!.text);
  assert.deepEqual(first, {
    schemaVersion: 1,
    sourceId: "alpha",
    itemId: "first-post",
    url: "https://alpha.example.org/p/first-post?utm_source=rss",
    canonicalUrl: "https://alpha.example.org/p/first-post",
    title: "First alpha post",
    publishedAt: "2026-11-25T07:27:05.000Z",
    postId: "226395148",
    sourceItem: "substack:alpha:226395148",
    medium: "audio",
    fingerprint: first.fingerprint,
  });
  assert.match(first.fingerprint, /^sha256:[0-9a-f]{64}$/);
  const undated = JSON.parse((await h.repo.readText(report.commit!, recordPath("beta", "undated")))!.text);
  assert.equal("publishedAt" in undated, false, "a missing publication date is omitted, not invented");
  assert.ok(await h.repo.readText(report.commit!, "feeds/collection.json"), "the collection is declared for the indexer");
});

test("repeat polls of unchanged items create no commits and no duplicates", async () => {
  const h = harness();
  const first = await h.poll();
  const again = await h.poll();
  const third = await h.poll();
  for (const report of [again, third]) {
    assert.equal(report.commit, null);
    assert.deepEqual(report.committed, []);
    assert.deepEqual(report.sources.map((s) => [s.sourceId, s.unchanged, s.new, s.changed]), [["alpha", 2, 0, 0], ["beta", 1, 0, 0]]);
  }
  assert.equal(h.git("rev-list", "--count", "main"), "1");
  assert.equal(await h.repo.resolve("main"), first.commit);
  assert.equal((await h.repo.listFiles(first.commit!, "feeds")).length, 4, "three records and the declaration");
});

test("a changed item is committed as changed, and only it", async () => {
  const h = harness();
  const first = await h.poll();
  h.net.routes["https://alpha.example.org/feed"] = feedXml("alpha-edited");
  const report = await h.poll();
  assert.deepEqual(report.sources.find((s) => s.sourceId === "alpha"), { sourceId: "alpha", status: "ok", items: 2, new: 0, changed: 1, unchanged: 1 });
  assert.deepEqual(report.committed.map((c) => `${c.change} ${c.path}`), ["changed feeds/alpha/first-post.json"]);
  assert.deepEqual(await h.repo.compare(first.commit!, report.commit!), [{ path: "feeds/alpha/first-post.json", change: "modified" }]);
  const record = JSON.parse((await h.repo.readText(report.commit!, recordPath("alpha", "first-post")))!.text);
  assert.equal(record.title, "First alpha post (corrected)");
});

test("a failing feed is reported without discarding the other feed's results", async () => {
  for (const failure of [500, new Error("connection reset"), "<rss><channel>"] as const) {
    const h = harness();
    h.net.routes["https://beta.example.org/feed"] = failure;
    const report = await h.poll();
    assert.equal(report.ok, false);
    const beta = report.sources.find((s) => s.sourceId === "beta")!;
    assert.equal(beta.status, "failed");
    assert.equal(beta.error, failure === 500 ? "feed-http-500" : failure instanceof Error ? "feed-unavailable" : "invalid-feed");
    assert.doesNotMatch(JSON.stringify(report), /beta\.example\.org/, "failures never echo the feed URL");
    assert.deepEqual(report.committed.map((c) => c.path), ["feeds/alpha/first-post.json", "feeds/alpha/second-post.json"]);
    assert.equal(await h.repo.resolve("main"), report.commit);
  }
});

test("a lost commit race is retried against the new head", async () => {
  const h = harness();
  const commit = h.repo.commit.bind(h.repo);
  let raced = false;
  h.repo.commit = async (request) => {
    if (!raced) {
      raced = true;
      // Another writer commits first, so this pass's parent is stale.
      await commit({ parent: request.parent, writes: [{ path: "other/note.json", content: "{}" }], message: "other writer" });
    }
    return commit(request);
  };
  const report = await h.poll();
  assert.equal(report.ok, true);
  assert.equal(h.git("rev-list", "--count", "main"), "2");
  assert.ok(await h.repo.readText("main", "other/note.json"), "the other writer's commit is kept");
  assert.equal(report.committed.length, 3);
});

test("the Mastra step returns the per-source summary and committed references", async () => {
  const h = harness();
  const step = createPollSubstackFeedsStep(() => ({ config: h.config, repo: h.repo, fetch: h.net.fetch }));
  assert.equal(step.id, "poll-substack-feeds");
  const output = await (step.execute as (args: unknown) => Promise<unknown>)({ inputData: {} });
  const parsed = PollSubstackFeedsOutput.parse(output);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.committed.length, 3);
  assert.equal(parsed.sources.length, 2);
});

test("the poller step stays out of storage, messaging and indexing (#943)", async () => {
  const { readFileSync: read } = await import("node:fs");
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const seen = new Set<string>();
  const imports: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, spec] of read(file, "utf8").matchAll(/from "([^"]+)"/g)) {
      imports.push(spec!);
      if (spec!.startsWith(".")) visit(join(file, "..", spec!.replace(/\.js$/, ".ts")));
    }
  };
  visit(join(src, "mastra", "steps", "poll-substack-feeds.ts"));
  assert.deepEqual(imports.filter((i) => /libsql|sqlite|nats|elasticsearch|collections\/(index|reconcile|search-index)/.test(i)), []);
});
