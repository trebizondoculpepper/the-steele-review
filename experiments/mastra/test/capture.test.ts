import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePost } from "../src/capture/substack.js";
import { VersionStore } from "../src/capture/store.js";
import { sourceVersionId } from "../src/capture/bundle.js";

const HOST = "saveusnow.substack.com";
const SIGNED = "https://substackcdn.com/video_upload/post/42/t/transcription.json?Expires=1&Signature=abc&Key-Pair-Id=k";

function fakeSubstack(state: { transcript: string[]; audience?: string; body?: string; transcribed?: boolean }) {
  return (async (input: URL | string) => {
    const url = new URL(String(input));
    if (url.hostname === HOST && url.pathname === "/api/v1/posts/a-post")
      return Response.json({
        id: 42,
        slug: "a-post",
        title: "A post",
        type: "podcast",
        audience: state.audience ?? "everyone",
        post_date: "2026-11-25T07:27:05.875Z",
        updated_at: null,
        body_html: state.body ?? "<p>Short caption</p>",
        podcastUpload: { id: "up-1", transcription: state.transcribed === false ? null : { status: "transcribed", cdn_url: SIGNED, media_upload_id: "up-1" } },
        publishedBylines: [{ name: "Save Us Now" }],
      });
    if (url.hostname === "substackcdn.com") return Response.json(state.transcript.map((text, i) => ({ start: i, end: i + 1, text })));
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const store = (dir: string) => new VersionStore(`file:${join(dir, "sources.db")}`);
const cfg = (f: typeof fetch) => ({ publicationHost: HOST, fetch: f });

test("captures the supplied transcript as usable text and never retains the signed link", async () => {
  const r = await capturePost(`https://${HOST}/p/a-post`, cfg(fakeSubstack({ transcript: [" Hello. ", "World. "] })));
  assert.equal(r.bundle.item, "substack:saveusnow:42");
  assert.equal(r.bundle.textSource, "supplied-transcript");
  assert.equal(r.bundle.text, "Hello.\nWorld.");
  assert.equal(r.bundle.medium, "audio");
  assert.equal(r.bundle.author, "Save Us Now");
  assert.ok(!r.rawPost.includes("Signature=") && !r.rawPost.includes("Expires="), "signed URL removed");
  assert.ok(r.rawTranscript);
});

test("versions: identical content is reused, changed content adds a version, and the older one reads back exactly after a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sources-"));
  const state = { transcript: ["First version."] };
  let s = store(dir);
  const v1 = await capturePost(`https://${HOST}/p/a-post`, cfg(fakeSubstack(state)));
  const a = await s.save(v1.bundle, { ...v1, captureMeta: {} }, "2026-11-26T00:00:00.000Z");
  const again = await s.save(v1.bundle, { ...v1, captureMeta: {} }, "2026-11-26T00:01:00.000Z");
  assert.deepEqual([a.created, again.created, again.version === a.version], [true, false, true]);
  state.transcript = ["Second version."];
  const v2 = await capturePost(`https://${HOST}/p/a-post`, cfg(fakeSubstack(state)));
  const b = await s.save(v2.bundle, { ...v2, captureMeta: {} }, "2026-11-26T00:02:00.000Z");
  assert.notEqual(b.version, a.version);
  s.close();
  s = store(dir); // restart storage
  const page1 = await s.listVersions("substack:saveusnow:42", 1, 0);
  const page2 = await s.listVersions("substack:saveusnow:42", 1, 1);
  assert.deepEqual([page1.total, page1.versions.length, page2.versions.length], [2, 1, 1]);
  assert.notEqual(page1.versions[0]!.version, page2.versions[0]!.version, "paging reaches every version");
  const older = await s.read(a.version);
  assert.equal(older.bundle.text, "First version.", "the exact earlier content, without refetching");
  assert.equal(sourceVersionId(older.bundle), a.version);
  assert.deepEqual((await s.listItems(10)).map((i) => [i.item, i.versions, i.latestVersion]), [["substack:saveusnow:42", 2, b.version]]);
});

test("export and import move a version between stores with its hash verified; tampering is refused", async () => {
  const src = store(mkdtempSync(join(tmpdir(), "sources-")));
  const dst = store(mkdtempSync(join(tmpdir(), "sources-")));
  const r = await capturePost(`https://${HOST}/p/a-post`, cfg(fakeSubstack({ transcript: ["Pinned."] })));
  const { version } = await src.save(r.bundle, { ...r, captureMeta: {} }, "2026-11-26T00:00:00.000Z");
  const exported = await src.export(version);
  assert.deepEqual(await dst.import(exported, "2026-11-26T01:00:00.000Z"), { version, created: true });
  assert.equal((await dst.read(version)).bundleBytes, exported.bundleBytes);
  const tampered = { ...exported, bundleBytes: exported.bundleBytes.replace("Pinned.", "Changed.") };
  await assert.rejects(dst.import(tampered, "2026-11-26T01:00:00.000Z"), /hash-mismatch/);
});

test("retained versions cannot be modified or deleted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sources-"));
  const s = store(dir);
  const r = await capturePost(`https://${HOST}/p/a-post`, cfg(fakeSubstack({ transcript: ["Keep me."] })));
  const { version } = await s.save(r.bundle, { ...r, captureMeta: {} }, "2026-11-26T00:00:00.000Z");
  assert.deepEqual(await s.verifyImmutable(version), { updateRefused: true, deleteRefused: true });
  assert.equal((await s.read(version)).bundle.text, "Keep me.");
});

test("honest partial content: no transcript falls back to labelled article text; nothing usable is warned; restricted posts are refused", async () => {
  const caption = await capturePost(`https://${HOST}/p/a-post`, cfg(fakeSubstack({ transcript: [], transcribed: false })));
  assert.equal(caption.bundle.textSource, "article-html");
  assert.ok(caption.warnings.includes("text-is-article-description-not-transcript"));
  const empty = await capturePost(`https://${HOST}/p/a-post`, cfg(fakeSubstack({ transcript: [], transcribed: false, body: "" })));
  assert.equal(empty.bundle.text, "");
  assert.ok(empty.warnings.includes("no-usable-text"));
  await assert.rejects(capturePost(`https://${HOST}/p/a-post`, cfg(fakeSubstack({ transcript: ["x"], audience: "only_paid" }))), /restricted/);
  await assert.rejects(capturePost(`https://${HOST}/p/missing`, cfg(fakeSubstack({ transcript: ["x"] }))), /post-not-found/);
  await assert.rejects(capturePost("https://evil.example/p/a-post", cfg(fakeSubstack({ transcript: ["x"] }))), /wrong-publication/);
});

test("a transcript whose segments are all blank falls back to article text with a warning", async () => {
  const r = await capturePost(`https://${HOST}/p/a-post`, cfg(fakeSubstack({ transcript: ["  ", ""], body: "<p>Article body</p>" })));
  assert.equal(r.bundle.textSource, "article-html");
  assert.equal(r.bundle.text, "Article body");
  assert.ok(r.warnings.includes("supplied-transcript-unusable"));
});

test("blank segments are kept in the canonical text; a malformed transcript URL falls back safely", async () => {
  const kept = await capturePost(`https://${HOST}/p/a-post`, cfg(fakeSubstack({ transcript: ["One.", "  ", "Two."] })));
  assert.equal(kept.bundle.text, "One.\n\nTwo.");
  const malformed = (async (input: URL | string) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/posts/a-post")
      return Response.json({ id: 42, slug: "a-post", title: "t", type: "podcast", audience: "everyone", body_html: "<p>Body</p>", podcastUpload: { id: "u", transcription: { status: "transcribed", cdn_url: "/relative/transcription.json" } } });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const r = await capturePost(`https://${HOST}/p/a-post`, cfg(malformed));
  assert.equal(r.bundle.textSource, "article-html");
  assert.ok(r.warnings.includes("supplied-transcript-host-not-allowed"));
});
