import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigDirectory } from "../src/common/config/index.js";
import { GitRepository } from "../src/common/git/index.js";
import { ModelError, type ChatModel, type ChatRequest } from "../src/common/model/openrouter.js";
import { fetchCommittedItems, itemFolder, type CommittedFeedRef } from "../src/content/raw-content.js";
import type { ArticleRecord } from "../src/content/substack-article.js";
import { recordPath, type FeedRecord } from "../src/feed/substack-poller.js";
import { createFetchSubstackContentStep } from "../src/mastra/steps/fetch-substack-content.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const HOST = "fixturepub.example.org";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPG = Buffer.from("ffd8ffe000104a46494600", "hex");

/** Fake network: the post endpoint, the transcripts and the images. */
function network(overrides: Record<string, Response | (() => Response)> = {}) {
  const requested: string[] = [];
  const fake = (async (input: string | URL) => {
    const url = String(input);
    requested.push(url);
    if (overrides[url]) {
      const o = overrides[url]!;
      return typeof o === "function" ? o() : o;
    }
    const post = /^https:\/\/fixturepub\.example\.org\/api\/v1\/posts\/([a-z0-9-]+)$/.exec(url)?.[1];
    if (post) {
      try {
        return new Response(readFileSync(join(fixtures, "content", "posts", `${post}.json`)), { status: 200 });
      } catch {
        return new Response("", { status: 404 });
      }
    }
    const transcript = /^https:\/\/substackcdn\.com\/transcripts\/([a-z]+)\.json\?/.exec(url)?.[1];
    if (transcript) return new Response(readFileSync(join(fixtures, "content", "transcripts", `${transcript}.json`)), { status: 200 });
    if (url.startsWith("https://substackcdn.com/image/")) return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    if (url.startsWith("https://substack-post-media.s3.amazonaws.com/")) return new Response(JPG, { status: 200, headers: { "content-type": "image/jpeg" } });
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;
  return { fetch: fake, requested };
}

/** A fake model that judges the sample by its words, and counts its calls. */
function fakeModel(fail = false): ChatModel & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    calls,
    async complete(request) {
      calls.push(request);
      if (fail) throw new ModelError("provider-error", "provider returned 500");
      const sample = request.user;
      const verdict = /garble|flarp|onk/.test(sample) ? "garbled" : /Hola|normas/.test(sample) ? "not-english" : "intelligible-english";
      return {
        model: request.model,
        raw: JSON.stringify({ verdict, reason: "fixture" }),
        provider: "fake",
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 10, costUsd: 0.00001 },
      };
    },
  };
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "content-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", root]);
  const repo = new GitRepository(root);
  const config = new ConfigDirectory(join(fixtures, "config", "content"));
  /** Commit feed records as the poller would, and return their references. */
  const commitFeed = async (slugs: string[]): Promise<CommittedFeedRef[]> => {
    const records: FeedRecord[] = slugs.map((slug) => ({
      schemaVersion: 1,
      sourceId: "fixturepub",
      itemId: slug,
      url: `https://${HOST}/p/${slug}?utm_source=rss`,
      canonicalUrl: `https://${HOST}/p/${slug}`,
      title: `Feed title of ${slug}`,
      medium: "written",
      fingerprint: `sha256:${"0".repeat(64)}`,
    }));
    const { commit } = await repo.commit({
      writes: records.map((r) => ({ path: recordPath("fixturepub", r.itemId), content: `${JSON.stringify(r, null, 2)}\n` })),
      message: "poll",
    });
    return records.map((r) => ({ sourceId: "fixturepub", itemId: r.itemId, path: recordPath("fixturepub", r.itemId), change: "new", commit: commit! }));
  };
  const read = async (slug: string): Promise<ArticleRecord> =>
    JSON.parse((await repo.readText("main", `${itemFolder("substack", "fixturepub", slug)}/article.json`))!.text);
  return { repo, config, commitFeed, read };
}

test("a written post: article text, original URL, dates, byline, cover and body images committed together", async () => {
  const h = harness();
  const net = network();
  const model = fakeModel();
  const refs = await h.commitFeed(["written-post"]);
  const [summary] = await fetchCommittedItems(refs, { config: h.config, repo: h.repo, model, fetch: net.fetch });
  assert.equal(summary!.status, "captured");
  const r = await h.read("written-post");
  assert.equal(r.text.role, "article");
  assert.equal(r.text.content, "This is the article text.\n\nIt continues here.");
  assert.equal(r.url, `https://${HOST}/p/written-post?utm_source=rss`);
  assert.equal(r.canonicalUrl, `https://${HOST}/p/written-post`);
  assert.equal(r.publishedAt, "2026-11-20T10:00:00.000Z");
  assert.equal(r.representation, "article");
  assert.deepEqual(r.analysis, { use: "article" });
  assert.deepEqual(r.attribution, { author: "Jane Example", authorId: null, basis: "post-byline", observedBylines: ["Jane Example"] });
  assert.equal(r.transcript.status, "missing");
  assert.equal(model.calls.length, 0, "no model call without a transcript");
  assert.equal(r.thumbnail!.file, "thumbnail.jpg");
  assert.equal(r.thumbnail!.source, "https://substack-post-media.s3.amazonaws.com/public/images/cover.jpg");
  assert.equal(r.images.length, 1);
  assert.ok(r.warnings.includes("asset-host-not-allowed"), "an image from another host is refused");
  assert.ok(!net.requested.some((u) => u.includes("evil.example.com")));

  const folder = itemFolder("substack", "fixturepub", "written-post");
  const files = (await h.repo.listFiles("main", folder)).map((e) => e.path.slice(folder.length + 1)).sort();
  assert.deepEqual(files, ["article.json", r.images[0]!.file, "post.raw", "thumbnail.jpg"].sort());
  assert.deepEqual((await h.repo.readFile("main", `${folder}/thumbnail.jpg`))!.content, JPG);
  const changed = await h.repo.compare(refs[0]!.commit, summary!.commit!);
  assert.ok(changed.every((c) => c.path.startsWith(folder) || c.path === "raw_content/collection.json"), "one commit holds the record and its assets");
  assert.ok(await h.repo.readText("main", "raw_content/collection.json"), "the collection is declared for the indexer");
});

test("an intelligible transcript is used for analysis; the description is kept separately; configured authorship applies", async () => {
  const h = harness();
  const model = fakeModel();
  await fetchCommittedItems(await h.commitFeed(["audio-intelligible"]), { config: h.config, repo: h.repo, model, fetch: network().fetch });
  const r = await h.read("audio-intelligible");
  assert.equal(r.representation, "recording");
  assert.deepEqual(r.text, { role: "description", content: "Show notes describing the recording." });
  assert.equal(r.transcript.status, "usable");
  assert.match(r.transcript.content!, /^Welcome back to the programme\./);
  assert.equal(r.transcript.original, "transcript.raw");
  assert.equal(r.transcript.check!.verdict, "intelligible-english");
  assert.match(r.transcript.check!.prompt, /^transcript-intelligibility-v1@sha256:[0-9a-f]{64}$/);
  assert.deepEqual(r.analysis, { use: "transcript" });
  assert.deepEqual(r.attribution, { author: "Example Author", authorId: "example-author", basis: "source-configured", observedBylines: ["Fixture Publication"] });
  assert.equal(model.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(r), /Signature=|Expires=/, "the signed transcript link is never stored");
});

test("a mislabelled transcript is judged on its text: usable, with the label mismatch recorded", async () => {
  const h = harness();
  await fetchCommittedItems(await h.commitFeed(["audio-mislabelled"]), { config: h.config, repo: h.repo, model: fakeModel(), fetch: network().fetch });
  const r = await h.read("audio-mislabelled");
  assert.equal(r.transcript.languageLabel, "es");
  assert.equal(r.transcript.status, "usable");
  assert.equal(r.transcript.check!.labelMismatch, true);
  assert.ok(r.warnings.includes("transcript-language-label-mismatch"));
  assert.deepEqual(r.analysis, { use: "transcript" });
  assert.equal(r.attribution.basis, "source-configured", "no byline falls back to the configured author");
});

test("garbled, non-English and missing transcripts are preserved and skipped for analysis", async () => {
  const h = harness();
  await fetchCommittedItems(await h.commitFeed(["audio-garbled", "video-not-english", "video-missing"]), {
    config: h.config,
    repo: h.repo,
    model: fakeModel(),
    fetch: network().fetch,
  });
  const garbled = await h.read("audio-garbled");
  assert.equal(garbled.transcript.status, "unusable");
  assert.equal(garbled.transcript.check!.verdict, "garbled");
  assert.deepEqual(garbled.analysis, { use: "skip", reason: "transcript-garbled" });
  assert.ok((await h.repo.readText("main", `${itemFolder("substack", "fixturepub", "audio-garbled")}/transcript.raw`))!.text.includes("flarp"), "the unusable original is kept");
  assert.equal(garbled.attribution.basis, "unknown", "several bylines leave the author unknown");
  assert.deepEqual(garbled.attribution.observedBylines, ["Jane Example", "John Example"]);

  const spanish = await h.read("video-not-english");
  assert.equal(spanish.transcript.status, "unusable");
  assert.equal(spanish.transcript.languageLabel, "en");
  assert.deepEqual(spanish.analysis, { use: "skip", reason: "transcript-not-english" });

  const missing = await h.read("video-missing");
  assert.equal(missing.transcript.status, "missing");
  assert.deepEqual(missing.analysis, { use: "skip", reason: "transcript-missing" });
  assert.deepEqual(missing.text, { role: "description", content: "Only a description." });
});

test("a provider error keeps the fetched content and is distinct from an unusable transcript; a retry then checks it", async () => {
  const h = harness();
  const refs = await h.commitFeed(["audio-intelligible"]);
  const [failed] = await fetchCommittedItems(refs, { config: h.config, repo: h.repo, model: fakeModel(true), fetch: network().fetch });
  assert.equal(failed!.status, "captured", "the fetch output is committed");
  let r = await h.read("audio-intelligible");
  assert.equal(r.transcript.status, "check-failed");
  assert.equal(r.transcript.check!.error, "provider-error");
  assert.match(r.transcript.content!, /Welcome back/);
  assert.deepEqual(r.analysis, { use: "skip", reason: "transcript-check-failed" });

  const model = fakeModel();
  await fetchCommittedItems(refs, { config: h.config, repo: h.repo, model, fetch: network().fetch });
  r = await h.read("audio-intelligible");
  assert.equal(r.transcript.status, "usable");
  assert.equal(model.calls.length, 1);
});

test("refetching an unchanged item reuses the saved check: no model call and no new commit", async () => {
  const h = harness();
  const refs = await h.commitFeed(["audio-intelligible"]);
  await fetchCommittedItems(refs, { config: h.config, repo: h.repo, model: fakeModel(), fetch: network().fetch });
  const head = await h.repo.resolve("main");
  const model = fakeModel();
  const [again] = await fetchCommittedItems(refs, { config: h.config, repo: h.repo, model, fetch: network().fetch });
  assert.equal(model.calls.length, 0);
  assert.equal(again!.status, "unchanged");
  assert.equal(await h.repo.resolve("main"), head);
});

test("one item's failure is reported without stopping the others", async () => {
  const h = harness();
  const refs = await h.commitFeed(["no-such-post", "written-post"]);
  const summaries = await fetchCommittedItems(refs, { config: h.config, repo: h.repo, model: fakeModel(), fetch: network().fetch });
  assert.deepEqual(summaries.map((s) => [s.itemId, s.status, s.error ?? ""]), [["no-such-post", "failed", "post-not-found"], ["written-post", "captured", ""]]);
});

test("the fetch step takes the poller's output and returns both summaries", async () => {
  const h = harness();
  const refs = await h.commitFeed(["written-post"]);
  const step = createFetchSubstackContentStep(() => ({ config: h.config, repo: h.repo, model: fakeModel(), fetch: network().fetch }));
  const poll = { ok: true, commit: refs[0]!.commit, sources: [], committed: refs };
  const out = (await (step.execute as (a: unknown) => Promise<unknown>)({ inputData: poll })) as { fetched: { status: string }[]; poll: unknown };
  assert.deepEqual(out.poll, poll);
  assert.deepEqual(out.fetched.map((f) => f.status), ["captured"]);
});

test("the raw-content declaration is accepted by the collection indexer, and records avoid its reserved field", async () => {
  const { parseDeclaration } = await import("../src/collections/declaration.js");
  const { RAW_CONTENT_DECLARATION } = await import("../src/content/raw-content.js");
  const parsed = parseDeclaration("raw_content", JSON.stringify(RAW_CONTENT_DECLARATION));
  assert.equal(parsed.mappingVersion, 1);
  const h = harness();
  await fetchCommittedItems(await h.commitFeed(["written-post"]), { config: h.config, repo: h.repo, model: fakeModel(), fetch: network().fetch });
  const r = await h.read("written-post");
  assert.ok(!Object.keys(r).some((k) => k === "provenance" || k.startsWith("provenance.")));
  const declared = Object.keys(RAW_CONTENT_DECLARATION.mapping.properties);
  assert.deepEqual(Object.keys(r).filter((k) => !declared.includes(k)), [], "every record field is declared in the strict mapping");
});

test("a failed capture leaves a retry marker, and a later run with nothing new captures it (review on #965)", async () => {
  const { PENDING_FILE } = await import("../src/content/raw-content.js");
  const h = harness();
  const refs = await h.commitFeed(["written-post"]);
  const down = network({ [`https://${HOST}/api/v1/posts/written-post`]: () => new Response("", { status: 503 }) });
  const [failed] = await fetchCommittedItems(refs, { config: h.config, repo: h.repo, model: fakeModel(), fetch: down.fetch });
  assert.equal(failed!.status, "failed");
  assert.deepEqual(failed!.pending, { attempts: 1, exhausted: false });
  const folder = itemFolder("substack", "fixturepub", "written-post");
  assert.ok(await h.repo.readText("main", `${folder}/${PENDING_FILE}`));

  // The next poll commits nothing new; the pending item is still retried.
  const [retried] = await fetchCommittedItems([], { config: h.config, repo: h.repo, model: fakeModel(), fetch: network().fetch });
  assert.equal(retried!.status, "captured");
  assert.equal(retried!.retried, true);
  assert.equal(await h.repo.readText("main", `${folder}/${PENDING_FILE}`), null, "the marker is removed once captured");
  assert.equal((await h.read("written-post")).text.role, "article");
});

test("a failed transcript check is retried by later runs until it succeeds (review on #965)", async () => {
  const { PENDING_FILE } = await import("../src/content/raw-content.js");
  const h = harness();
  await fetchCommittedItems(await h.commitFeed(["audio-intelligible"]), { config: h.config, repo: h.repo, model: fakeModel(true), fetch: network().fetch });
  const folder = itemFolder("substack", "fixturepub", "audio-intelligible");
  assert.ok(await h.repo.readText("main", `${folder}/${PENDING_FILE}`));
  const model = fakeModel();
  const [again] = await fetchCommittedItems([], { config: h.config, repo: h.repo, model, fetch: network().fetch });
  assert.equal(again!.status, "captured");
  assert.equal((await h.read("audio-intelligible")).transcript.status, "usable");
  assert.equal(model.calls.length, 1);
  assert.equal(await h.repo.readText("main", `${folder}/${PENDING_FILE}`), null);
});

test("retries stop after the attempt limit and are then left for inspection (review on #965)", async () => {
  const { MAX_ATTEMPTS } = await import("../src/content/raw-content.js");
  const h = harness();
  const down = network({ [`https://${HOST}/api/v1/posts/written-post`]: () => new Response("", { status: 503 }) });
  let last;
  [last] = await fetchCommittedItems(await h.commitFeed(["written-post"]), { config: h.config, repo: h.repo, model: fakeModel(), fetch: down.fetch });
  for (let i = 1; i < MAX_ATTEMPTS; i++) [last] = await fetchCommittedItems([], { config: h.config, repo: h.repo, model: fakeModel(), fetch: down.fetch });
  assert.deepEqual(last!.pending, { attempts: MAX_ATTEMPTS, exhausted: true });
  assert.deepEqual(await fetchCommittedItems([], { config: h.config, repo: h.repo, model: fakeModel(), fetch: down.fetch }), [], "an exhausted item is not retried");
});

test("a run that loses a race to a newer capture of the same item never replaces it (review on #965)", async () => {
  const h = harness();
  const refs = await h.commitFeed(["written-post"]);
  const folder = itemFolder("substack", "fixturepub", "written-post");
  const commit = h.repo.commit.bind(h.repo);
  let raced = false;
  h.repo.commit = async (request) => {
    if (!raced) {
      raced = true;
      // A newer capture of the same item lands first.
      await commit({ writes: [{ path: `${folder}/article.json`, content: '{"newer":true}\n' }], message: "newer capture" });
    }
    return commit(request);
  };
  const [summary] = await fetchCommittedItems(refs, { config: h.config, repo: h.repo, model: fakeModel(), fetch: network().fetch });
  assert.equal(summary!.status, "superseded");
  assert.equal((await h.repo.readText("main", `${folder}/article.json`))!.text, '{"newer":true}\n');
});
