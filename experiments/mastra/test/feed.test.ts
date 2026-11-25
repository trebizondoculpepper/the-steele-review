import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollFeed, type FeedConfig } from "../src/feed/poll.js";
import { FeedStore } from "../src/feed/store.js";
import { canonicalPostUrl, parseFeed } from "../src/feed/rss.js";

const HOST = "saveusnow.substack.com";
const item = (slug: string, title: string, id?: string, date = "Wed, 25 Nov 2026 07:27:05 GMT") => `
  <item><title>${title}</title><link>https://${HOST}/p/${slug}</link>
  <guid isPermaLink="false">https://${HOST}/p/${slug}</guid><pubDate>${date}</pubDate>
  ${id ? `<enclosure url="https://api.substack.com/feed/podcast/${id}/abc.mp3" length="0" type="audio/mpeg"/>` : ""}</item>`;
const feed = (...items: string[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>${items.join("")}</channel></rss>`;

function harness() {
  const store = new FeedStore(`file:${join(mkdtempSync(join(tmpdir(), "feed-")), "feed.db")}`);
  let body = "";
  let status = 200;
  const config: FeedConfig = {
    feedUrl: `https://${HOST}/feed`,
    publicationHost: HOST,
    fetch: (async () => new Response(body, { status })) as unknown as typeof fetch,
  };
  return { store, config, set: (b: string, s = 200) => ((body = b), (status = s)) };
}

test("parsing normalises identity, medium and dates, and reads post IDs from audio enclosures", () => {
  const [audio, text] = parseFeed(feed(item("a-post", "Audio &amp; more", "226395148"), item("b-post", "Text")), HOST);
  assert.equal(audio!.canonicalUrl, `https://${HOST}/p/a-post`);
  assert.equal(audio!.postId, "226395148");
  assert.equal(audio!.sourceItem, "substack:saveusnow:226395148");
  assert.equal(audio!.medium, "audio");
  assert.equal(audio!.title, "Audio & more");
  assert.equal(audio!.publishedAt, "2026-11-25T07:27:05.000Z");
  assert.equal(text!.postId, null);
  assert.equal(text!.medium, "written");
});

test("first poll is a baseline; an unchanged feed reports nothing; new and edited items are reported once", async () => {
  const h = harness();
  h.set(feed(item("one", "One", "1"), item("two", "Two", "2")));
  const first = await pollFeed(h.store, h.config);
  assert.equal(first.outcome, "ok");
  assert.equal(first.baseline, true);
  assert.equal(first.newItems.length, 0, "the backlog is not submitted");
  assert.equal((await h.store.items(10, "baseline")).length, 2);

  const again = await pollFeed(h.store, h.config);
  assert.equal(again.baseline, false);
  assert.deepEqual([again.newItems.length, again.changedItems.length, again.unchangedCount], [0, 0, 2]);

  h.set(feed(item("three", "Three", "3"), item("one", "One (edited)", "1"), item("two", "Two", "2")));
  const third = await pollFeed(h.store, h.config);
  assert.deepEqual(third.newItems.map((i) => i.slug), ["three"]);
  assert.deepEqual(third.changedItems.map((i) => i.slug), ["one"]);
  const fourth = await pollFeed(h.store, h.config);
  assert.deepEqual([fourth.newItems.length, fourth.changedItems.length], [0, 0], "repeated polling reports each change once");
  const polls = await h.store.lastPolls(10);
  assert.equal(polls.length, 4);
  assert.equal(polls[1]!.newCount, 1);
});

test("failures are recorded with a reason and never establish the baseline", async () => {
  const h = harness();
  h.set("<html>not a feed</html>");
  assert.equal((await pollFeed(h.store, h.config)).error, "invalid-feed");
  h.set("", 503);
  assert.equal((await pollFeed(h.store, h.config)).error, "feed-http-503");
  h.set(feed(item("x", "X")));
  const first = await pollFeed(h.store, h.config);
  assert.equal(first.baseline, true, "baseline is the first successful poll");
  const polls = await h.store.lastPolls(10);
  assert.deepEqual(polls.map((p) => p.outcome).sort(), ["failed", "failed", "ok"]);
});

test("items and feeds from other hosts are refused", async () => {
  assert.throws(() => parseFeed(feed(`<item><title>t</title><link>https://evil.example/p/x</link></item>`), HOST), /wrong-publication/);
  assert.throws(() => canonicalPostUrl("http://saveusnow.substack.com/p/x", HOST), /wrong-publication/);
  const h = harness();
  const r = await pollFeed(h.store, { ...h.config, feedUrl: "https://evil.example/feed" });
  assert.equal(r.error, "feed-url-not-allowed");
});

test("manual selection enters an older item separately from discovery", async () => {
  const h = harness();
  h.set(feed(item("one", "One", "1")));
  await pollFeed(h.store, h.config);
  const url = canonicalPostUrl(`https://${HOST}/p/old-post?utm=x`, HOST);
  assert.equal(url.href, `https://${HOST}/p/old-post`);
  assert.deepEqual(await h.store.select({ canonicalUrl: url.href, slug: "old-post" }, new Date().toISOString()), { created: true });
  assert.deepEqual(await h.store.select({ canonicalUrl: `https://${HOST}/p/one`, slug: "one" }, new Date().toISOString()), { created: false });
  assert.deepEqual((await h.store.items(10, "selected")).map((i) => i.slug).sort(), ["old-post", "one"]);
});

test("a body-only edit is detected, and an oversized streamed feed is refused", async () => {
  const h = harness();
  const withBody = (body: string) => feed(item("one", "One", "1").replace("</item>", `<description>${body}</description></item>`));
  h.set(withBody("first"));
  await pollFeed(h.store, h.config);
  h.set(withBody("second"));
  assert.deepEqual((await pollFeed(h.store, h.config)).changedItems.map((i) => i.slug), ["one"]);

  const big = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new Uint8Array(1_000_000));
    },
  });
  const r = await pollFeed(h.store, { ...h.config, fetch: (async () => new Response(big, { status: 200 })) as unknown as typeof fetch });
  assert.equal(r.error, "feed-too-large");
});

test("a truncated HTTP-200 feed is a failure and never establishes the baseline", async () => {
  const h = harness();
  h.set(`<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture`);
  const r = await pollFeed(h.store, h.config);
  assert.equal(r.error, "invalid-feed");
  assert.equal(await h.store.activated(), false);
  h.set(feed(item("one", "One", "1")));
  assert.equal((await pollFeed(h.store, h.config)).baseline, true);
});

test("an item selected before activation is not reported as changed by the baseline", async () => {
  const h = harness();
  await h.store.select({ canonicalUrl: `https://${HOST}/p/one`, slug: "one" }, new Date().toISOString());
  h.set(feed(item("one", "One", "1")));
  const first = await pollFeed(h.store, h.config);
  assert.equal(first.baseline, true);
  assert.equal(first.changedItems.length, 0);
  const [one] = await h.store.items(10, "selected");
  assert.equal(one!.postId, "1", "metadata is filled in, status stays selected");
});

test("an over-long feed is refused instead of truncated", async () => {
  const h = harness();
  h.set(feed(...Array.from({ length: 501 }, (_, i) => item(`p${i}`, `P${i}`))));
  assert.equal((await pollFeed(h.store, h.config)).error, "invalid-feed");
  assert.equal(await h.store.activated(), false);
});

test("store initialisation retries after a failure", async () => {
  const store = new FeedStore("file:/nonexistent-dir-for-test/feed.db");
  await assert.rejects(store.activated());
  await assert.rejects(store.activated(), "a second call retries rather than reusing the rejected promise");
});
