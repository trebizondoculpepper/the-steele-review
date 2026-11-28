import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GitRepository } from "../src/common/git/index.js";
import { ModelError, type ChatModel, type ChatRequest } from "../src/common/model/openrouter.js";
import { CLAIMS_DECLARATION, extractClaims, type ClaimUtterance } from "../src/claims/extract.js";
import { createExtractClaimsStep } from "../src/mastra/steps/extract-claims.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/claims/${name}`, import.meta.url)), "utf8");
const REC = "raw_content/substack/fixturepub/pinned-claims";
const WRITTEN = "raw_content/substack/fixturepub/pinned-written";

const RECORDING_CLAIMS = {
  claims: [
    { quote: "The council approved a budget of four million pounds for the new road scheme last March.", claim: "The source says the council approved a four million pound road budget." },
    { quote: "According to the published minutes, construction will start in the spring of next year.", claim: "The source says construction starts next spring." },
  ],
};

function scripted(replies: Array<string | Error>): ChatModel & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    calls,
    async complete(request) {
      calls.push(request);
      const next = replies.shift();
      if (next === undefined) throw new Error("unexpected model call");
      if (next instanceof Error) throw next;
      return { model: request.model, raw: next, provider: "fake", finishReason: "stop", usage: { promptTokens: 500, completionTokens: 200, costUsd: 0.0002 } };
    },
  };
}

async function harness(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "claims-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", root]);
  const repo = new GitRepository(root);
  const { commit } = await repo.commit({ parent: null, writes: Object.entries(files).map(([path, content]) => ({ path, content })), message: "pinned sources" });
  const read = async (path: string) => JSON.parse((await repo.readText("main", path))!.text) as ClaimUtterance;
  return { repo, commit: commit!, read };
}

test("verified quotes from a single-speaker recording carry location, times, speaker and date", async () => {
  const h = await harness({ [`${REC}/article.json`]: fixture("recording-article.json"), [`${REC}/transcript.raw`]: fixture("transcript-single.json") });
  const model = scripted([JSON.stringify(RECORDING_CLAIMS)]);
  const r = await extractClaims({ path: `${REC}/article.json`, commit: h.commit }, { repo: h.repo, model });
  assert.equal(r.outcome, "proposed");
  assert.equal(r.claims.length, 2);
  const first = await h.read(r.claims[0]!.path);
  assert.equal(first.quote, RECORDING_CLAIMS.claims[0]!.quote);
  assert.deepEqual(first.speaker, { name: "Example Author", id: "example-author", basis: "single-speaker-recording", label: "SPEAKER_00" });
  assert.equal(first.date, "2026-11-21T08:00:00.000Z");
  assert.equal(first.location.segmentStart, 1);
  assert.equal(first.location.segmentEnd, 1);
  assert.equal(first.location.startSeconds, 4);
  assert.equal(first.location.endSeconds, 9.5);
  assert.ok(first.location.charEnd > first.location.charStart);
  assert.equal(first.source.textType, "transcript");
  assert.match(first.prompt, /^claim-utterances-v1@sha256:[0-9a-f]{64}$/);
  assert.match(first.claimId, /^[0-9a-f]{16}$/);
  assert.deepEqual(r.usage, { promptTokens: 500, completionTokens: 200, costUsd: 0.0002 });
  assert.ok(r.timings.modelMs !== null);
});

test("in a multi-speaker recording the speaker stays explicitly unknown, with the segment label kept", async () => {
  const h = await harness({ [`${REC}/article.json`]: fixture("recording-article.json"), [`${REC}/transcript.raw`]: fixture("transcript-multi.json") });
  const r = await extractClaims({ path: `${REC}/article.json`, commit: h.commit }, { repo: h.repo, model: scripted([JSON.stringify(RECORDING_CLAIMS)]) });
  const second = await h.read(r.claims[1]!.path);
  assert.deepEqual(second.speaker, { name: null, id: null, basis: "unknown", label: "SPEAKER_01" });
  const first = await h.read(r.claims[0]!.path);
  assert.deepEqual(first.speaker, { name: null, id: null, basis: "unknown", label: "SPEAKER_00" });
});

test("an article's claims take the resolved author and its basis; no transcript times", async () => {
  const h = await harness({ [`${WRITTEN}/article.json`]: fixture("written-article.json") });
  const reply = { claims: [{ quote: "The report says unemployment fell to four point two percent in October, the lowest level this year.", claim: "The source says unemployment fell to 4.2% in October." }] };
  const r = await extractClaims({ path: `${WRITTEN}/article.json`, commit: h.commit }, { repo: h.repo, model: scripted([JSON.stringify(reply)]) });
  const c = await h.read(r.claims[0]!.path);
  assert.deepEqual(c.speaker, { name: "Jane Example", id: null, basis: "post-byline", label: null });
  assert.equal(c.source.textType, "article");
  assert.equal(c.location.startSeconds, undefined);
  assert.equal(c.location.charStart, 0);
});

test("invented, too short, duplicate and malformed candidates are rejected with reasons; valid ones are kept", async () => {
  const h = await harness({ [`${REC}/article.json`]: fixture("recording-article.json"), [`${REC}/transcript.raw`]: fixture("transcript-single.json") });
  const reply = {
    claims: [
      RECORDING_CLAIMS.claims[0],
      { quote: "The council secretly doubled the budget without telling anyone at all last year.", claim: "Invented." },
      { quote: "four million pounds", claim: "Too short." },
      RECORDING_CLAIMS.claims[0],
      { claim: "No quote." },
    ],
  };
  const r = await extractClaims({ path: `${REC}/article.json`, commit: h.commit }, { repo: h.repo, model: scripted([JSON.stringify(reply)]) });
  assert.equal(r.outcome, "partial");
  assert.equal(r.claims.length, 1);
  assert.deepEqual(r.rejected, [
    { rank: 2, reason: "quote-not-in-source" },
    { rank: 3, reason: "quote-length" },
    { rank: 4, reason: "duplicate-quote" },
    { rank: 5, reason: "invalid-fields" },
  ]);
});

test("a retry reuses the completed extraction without another model call; a failed call is recovered once", async () => {
  const h = await harness({ [`${REC}/article.json`]: fixture("recording-article.json"), [`${REC}/transcript.raw`]: fixture("transcript-single.json") });
  const ref = { path: `${REC}/article.json`, commit: h.commit };
  const failed = await extractClaims(ref, { repo: h.repo, model: scripted([new ModelError("provider-error", "500")]) });
  assert.equal(failed.outcome, "model-failed");
  const first = await extractClaims(ref, { repo: h.repo, model: scripted([JSON.stringify(RECORDING_CLAIMS)]) });
  assert.equal(first.outcome, "proposed");
  const model = scripted([]);
  const again = await extractClaims(ref, { repo: h.repo, model });
  assert.equal(model.calls.length, 0);
  assert.equal(again.reused, true);
  assert.deepEqual(again.claims, first.claims, "stable IDs and quotes");
});

test("the step runs on its own, and the claims declaration is valid for the indexer", async () => {
  const { parseDeclaration } = await import("../src/collections/declaration.js");
  assert.equal(parseDeclaration("claims", JSON.stringify(CLAIMS_DECLARATION)).mappingVersion, 1);
  const h = await harness({ [`${REC}/article.json`]: fixture("recording-article.json"), [`${REC}/transcript.raw`]: fixture("transcript-single.json") });
  const step = createExtractClaimsStep(() => ({ repo: h.repo, model: scripted([JSON.stringify(RECORDING_CLAIMS)]) }));
  const out = (await (step.execute as (a: unknown) => Promise<{ outcome: string; claims: { path: string }[] }>)({ inputData: { path: `${REC}/article.json`, commit: h.commit } }));
  assert.equal(out.outcome, "proposed");
  const saved = await h.read(out.claims[0]!.path);
  const declared = Object.keys(CLAIMS_DECLARATION.mapping.properties);
  assert.deepEqual(Object.keys(saved).filter((k) => !declared.includes(k)), []);
});

test("without complete speaker evidence the speaker stays unknown (review on #967)", async () => {
  const segs = JSON.parse(fixture("transcript-single.json"));
  const unlabelled = segs.map((s: { words?: unknown }) => ({ ...s, words: undefined }));
  const partial = segs.map((s: { words: Array<{ speaker?: string }> }, i: number) => (i === 2 ? { ...s, words: s.words.map((w) => ({ ...w, speaker: undefined })) } : s));
  const mixedSegment = segs.map((s: { words: Array<{ speaker?: string }> }, i: number) => (i === 0 ? { ...s, words: s.words.map((w, j) => ({ ...w, speaker: j % 2 ? "SPEAKER_01" : "SPEAKER_00" })) } : s));
  for (const transcript of [unlabelled, partial, mixedSegment]) {
    const h = await harness({ [`${REC}/article.json`]: fixture("recording-article.json"), [`${REC}/transcript.raw`]: JSON.stringify(transcript) });
    const r = await extractClaims({ path: `${REC}/article.json`, commit: h.commit }, { repo: h.repo, model: scripted([JSON.stringify(RECORDING_CLAIMS)]) });
    const c = await h.read(r.claims[0]!.path);
    assert.equal(c.speaker.name, null);
    assert.equal(c.speaker.basis, "unknown");
  }
});

test("theme operations saved before the shared operation are still reused (review on #967)", async () => {
  const { proposeThemes } = await import("../src/themes/propose.js");
  const h = await harness({ [`${REC}/article.json`]: fixture("recording-article.json") });
  const ref = { path: `${REC}/article.json`, commit: h.commit };
  const good = { themes: [{ title: "Road budget decisions", description: "The source discusses a council road budget.", evidence: ["The council approved a budget of four million pounds for the new road scheme last March."] }] };
  const first = await proposeThemes(ref, { repo: h.repo, model: scripted([JSON.stringify(good)]) });
  // Rewrite the saved metadata in the earlier shape (`themes` instead of `items`).
  const metaPath = first.themes[0]!.path.replace(/[^/]+\.json$/, "operation.meta");
  const meta = JSON.parse((await h.repo.readText("main", metaPath))!.text);
  meta.themes = meta.items;
  delete meta.items;
  await h.repo.commit({ writes: [{ path: metaPath, content: JSON.stringify(meta) }], message: "legacy meta" });
  const model = scripted([]);
  const again = await proposeThemes(ref, { repo: h.repo, model });
  assert.equal(model.calls.length, 0);
  assert.deepEqual(again.themes.map((t) => t.themeId), first.themes.map((t) => t.themeId));
});

test("malformed retained word metadata leaves the speaker unknown with a warning, never a failed run (review on #967)", async () => {
  const segs = JSON.parse(fixture("transcript-single.json"));
  for (const bad of [segs.map((s: object, i: number) => (i === 1 ? { ...s, words: "oops" } : s)), segs.map((s: { words: unknown[] }, i: number) => (i === 1 ? { ...s, words: [null, ...s.words] } : s))]) {
    const h = await harness({ [`${REC}/article.json`]: fixture("recording-article.json"), [`${REC}/transcript.raw`]: JSON.stringify(bad) });
    const r = await extractClaims({ path: `${REC}/article.json`, commit: h.commit }, { repo: h.repo, model: scripted([JSON.stringify(RECORDING_CLAIMS)]) });
    assert.equal(r.outcome, "proposed");
    assert.ok(r.warnings.includes("transcript-word-metadata-malformed"));
    const c = await h.read(r.claims[0]!.path);
    assert.equal(c.speaker.basis, "unknown");
    assert.equal(c.location.startSeconds, 4, "timings still come from the well-formed segment fields");
  }
});

test("segment ranges index the retained transcript.raw, blank segments included (review on #967)", async () => {
  const segs = JSON.parse(fixture("transcript-single.json"));
  const withBlank = [{ start: 0, end: 0.1, text: "   ", words: [] }, ...segs];
  const h = await harness({ [`${REC}/article.json`]: fixture("recording-article.json"), [`${REC}/transcript.raw`]: JSON.stringify(withBlank) });
  const r = await extractClaims({ path: `${REC}/article.json`, commit: h.commit }, { repo: h.repo, model: scripted([JSON.stringify(RECORDING_CLAIMS)]) });
  const c = await h.read(r.claims[0]!.path);
  assert.equal(c.location.segmentStart, 2);
  assert.equal(withBlank[c.location.segmentStart!].text.trim(), RECORDING_CLAIMS.claims[0]!.quote);
});

test("a change to the retained transcript metadata alone is a new operation (review on #967)", async () => {
  const h = await harness({ [`${REC}/article.json`]: fixture("recording-article.json"), [`${REC}/transcript.raw`]: fixture("transcript-single.json") });
  const first = await extractClaims({ path: `${REC}/article.json`, commit: h.commit }, { repo: h.repo, model: scripted([JSON.stringify(RECORDING_CLAIMS)]) });
  const segs = JSON.parse(fixture("transcript-single.json"));
  segs[1].start = 40;
  const { commit } = await h.repo.commit({ writes: [{ path: `${REC}/transcript.raw`, content: JSON.stringify(segs) }], message: "corrected timestamps" });
  const second = await extractClaims({ path: `${REC}/article.json`, commit: commit! }, { repo: h.repo, model: scripted([JSON.stringify(RECORDING_CLAIMS)]) });
  assert.notEqual(second.operation, first.operation);
  assert.equal(second.reused, false);
  assert.equal((await h.read(second.claims[0]!.path)).location.startSeconds, 40);
});
