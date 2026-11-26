// Contract tests for the n8n capture code (#915): the Code nodes' own JavaScript, taken from the
// Git-defined workflows, must reproduce the shared source-bundle-v1 fixture byte for byte (#911).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

interface Node { name: string; parameters: { jsCode?: string } }
const nodeCode = (file: string, name: string): string => {
  const wf = JSON.parse(readFileSync(here(`../workflows/${file}`), "utf8")) as { nodes: Node[] };
  const n = wf.nodes.find((x) => x.name === name);
  assert.ok(n?.parameters.jsCode, `${file}: no Code node ${name}`);
  return n.parameters.jsCode;
};
const run = async (js: string, json: unknown, self: unknown = {}) =>
  new AsyncFunction("$json", "$execution", "require", "$", js).call(self, json, { id: "test" }, require, () => {
    throw new Error("$() is not stubbed");
  });

const fixtureBytes = readFileSync(here("../../shared/fixtures/source-bundle-v1.example.json"), "utf8");
const fixtureHash = readFileSync(here("../../shared/fixtures/source-bundle-v1.example.sha256"), "utf8").trim();
const fixture = JSON.parse(fixtureBytes) as { text: string; title: string };

const shared = (js: string) => js.slice(js.indexOf("// ---- shared"), js.indexOf("// ---- end shared ----"));

test("every copy of the shared canonical-form code is identical", () => {
  const copies = [
    nodeCode("sources-capture.json", "Build bundle"),
    nodeCode("sources-import.json", "Verify export"),
    nodeCode("sources-browse.json", "Verify and shape"),
    nodeCode("sources-load.json", "Verify"),
  ].map(shared);
  assert.ok(copies[0].length > 500);
  for (const c of copies) assert.equal(c, copies[0]);
});

test("the shared code verifies the #911 fixture and reproduces its hash", async () => {
  const js = shared(nodeCode("sources-import.json", "Verify export")) + "return verifyBytes($json.bytes, $json.version);";
  const r = (await run(js, { bytes: fixtureBytes, version: `substack:example:1000001@sha256:${fixtureHash}` })) as { sha256: string };
  assert.equal(r.sha256, fixtureHash);
  const tampered = run(js, { bytes: fixtureBytes.replace("café", "cafe"), version: `substack:example:1000001@sha256:${fixtureHash}` });
  await assert.rejects(tampered, /hash-mismatch/);
});

test("fetch (fixture mode) then build reproduce the #911 fixture bytes from a post and its transcript", async () => {
  const post = {
    id: 1000001, slug: "synthetic-fixture-post", title: ` ${fixture.title} `, type: "podcast", audience: "everyone",
    post_date: "2026-11-25T10:00:00Z", updated_at: null, body_html: "<p>Episode notes</p>",
    podcastUpload: { id: "00000000-0000-4000-8000-000000000001",
      transcription: { status: "transcribed", cdn_url: "https://substackcdn.com/t.json?Expires=1&Signature=s", media_upload_id: "00000000-0000-4000-8000-000000000001" } },
    publishedBylines: [{ name: "Example Author" }],
  };
  const segments = fixture.text.split("\n").map((text, i) => ({ start: i, end: i + 1, text: ` ${text} ` }));
  const fetched = (await run(nodeCode("sources-capture.json", "Fetch post"), {
    store: "fixture-test", url: "https://example.substack.com/p/synthetic-fixture-post?utm=x", publicationHost: "example.substack.com",
    fixturePost: post, fixtureTranscript: segments,
  })) as { json: { rawPost: string } };
  assert.doesNotMatch(JSON.stringify(fetched), /Signature=|substackcdn\.com\/t\.json/, "the signed link must not leave the fetch node");
  const built = (await run(nodeCode("sources-capture.json", "Build bundle"), fetched.json)) as { json: { bundleBytes: string; sha256: string; warnings: string[] } };
  assert.equal(built.json.bundleBytes, fixtureBytes);
  assert.equal(built.json.sha256, fixtureHash);
  assert.deepEqual(built.json.warnings, []);
});

test("a post without a transcript keeps its article text and says so", async () => {
  const post = { id: 7, slug: "notes", title: "Notes", type: "podcast", audience: "everyone", podcastUpload: { id: "u1" },
    body_html: "<p>Caption &amp; notes</p><figure><img src=x></figure><p>Second</p>" };
  const fetched = (await run(nodeCode("sources-capture.json", "Fetch post"), {
    store: "fixture-test", url: "https://example.substack.com/p/notes", publicationHost: "example.substack.com", fixturePost: post,
  })) as { json: unknown };
  const built = (await run(nodeCode("sources-capture.json", "Build bundle"), fetched.json)) as { json: { bundleBytes: string; warnings: string[] } };
  const b = JSON.parse(built.json.bundleBytes) as { text: string; textSource: string; medium: string };
  assert.equal(b.textSource, "article-html");
  assert.equal(b.medium, "audio");
  assert.equal(b.text, "Caption & notes\n\nSecond");
  assert.deepEqual(built.json.warnings, ["text-is-article-description-not-transcript"]);
});

test("restricted and foreign posts come out of the fetch node as failures, and build passes them through", async () => {
  const fetch = nodeCode("sources-capture.json", "Fetch post");
  const restricted = (await run(fetch, { store: "fixture-test", url: "https://example.substack.com/p/x", publicationHost: "example.substack.com",
    fixturePost: { id: 1, slug: "x", audience: "only_paid" } })) as { json: { failed: { code: string; permanent: boolean; httpStatus: number } } };
  assert.deepEqual([restricted.json.failed.code, restricted.json.failed.permanent, restricted.json.failed.httpStatus], ["restricted", true, 422]);
  const foreign = (await run(fetch, { store: "fixture-test", url: "https://evil.example.com/p/x", publicationHost: "example.substack.com",
    fixturePost: { id: 1, slug: "x" } })) as { json: { failed: { code: string } } };
  assert.equal(foreign.json.failed.code, "wrong-publication");
  const built = (await run(nodeCode("sources-capture.json", "Build bundle"), restricted.json)) as { json: unknown };
  assert.deepEqual(built.json, restricted.json, "a failure reaches the end of the one path unchanged");
});

test("an invalid numeric character reference keeps the article text and adds a warning", async () => {
  const post = { id: 8, slug: "entities", title: "E", type: "newsletter", audience: "everyone", body_html: "<p>Before &#x110000; caf&#233; after</p>" };
  const fetched = (await run(nodeCode("sources-capture.json", "Fetch post"), {
    store: "fixture-test", url: "https://example.substack.com/p/entities", publicationHost: "example.substack.com", fixturePost: post,
  })) as { json: unknown };
  const built = (await run(nodeCode("sources-capture.json", "Build bundle"), fetched.json)) as { json: { bundleBytes: string; warnings: string[] } };
  assert.equal((JSON.parse(built.json.bundleBytes) as { text: string }).text, "Before &#x110000; café after");
  assert.deepEqual(built.json.warnings, ["article-html-invalid-character-reference"]);
});
