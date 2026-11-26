import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { VersionStore } from "../src/capture/store.js";
import type { SourceBundle } from "../src/capture/bundle.js";
import { FakeModel } from "../src/writing/model.js";
import { AttemptStore } from "../src/writing/store.js";
import { createAttempt, modelPhase, pinPhase, savePhase, type WritingDeps } from "../src/writing/run.js";
import { DraftServiceClient } from "../src/delivery/client.js";
import { buildRequest, deliverArticle } from "../src/delivery/deliver.js";

/**
 * Integration with the real shared draft service (experiments/draft-service)
 * running locally against its file-backed fake destination. No Substack.
 */

const SERVICE = fileURLToPath(new URL("../../draft-service/", import.meta.url));
const TOKEN = "t".repeat(48);

async function startService(dir: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/main.ts"], {
    cwd: SERVICE,
    env: {
      ...process.env,
      PORT: String(port),
      STEELE_DRAFT_DB: join(dir, "deliveries.sqlite"),
      STEELE_DRAFT_DESTINATION: "fake",
      STEELE_DRAFT_FAKE_FILE: join(dir, "fake.json"),
      STEELE_DRAFT_CLIENTS_FILE: join(dir, "clients.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    let seen = "";
    child.stdout!.on("data", (c) => ((seen += String(c)), seen.includes('"listening"') && resolve()));
    child.once("exit", (code) => reject(new Error(`service exited (${code})`)));
  });
  return child;
}

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "delivery-"));
  writeFileSync(join(dir, "clients.json"), JSON.stringify({ tokenSha256: { mastra: createHash("sha256").update(TOKEN).digest("hex") } }));
  writeFileSync(join(dir, "token"), TOKEN);
  const port = 4600 + Math.floor(Math.random() * 300);
  const service = await startService(dir, port);
  const versions = new VersionStore(`file:${join(dir, "sources.db")}`);
  const attempts = new AttemptStore(`file:${join(dir, "articles.db")}`);
  const bundle: SourceBundle = {
    schema: "source-bundle-v1", item: "substack:saveusnow:42", postId: "42", slug: "a-post", url: "https://saveusnow.substack.com/p/a-post",
    title: "A post", publishedAt: null, updatedAt: null, author: null, medium: "video", audience: "everyone", mediaUploadId: null,
    textSource: "supplied-transcript", text: "Some text.",
  };
  const { version } = await versions.save(bundle, { rawPost: null, rawTranscript: null, warnings: [], captureMeta: {} }, "2026-11-26T00:00:00.000Z");
  const wd: WritingDeps = { attempts, versions, model: () => new FakeModel(), limits: { liveEnabled: false, maxLiveCalls: 0, liveBudgetUsd: 0, estimatedLiveCallUsd: 0 } };
  const write = async () => {
    const attempt = await createAttempt(wd, version, "fake");
    await pinPhase(wd, attempt);
    await modelPhase(wd, attempt);
    return (await savePhase(wd, attempt)).articleId;
  };
  const drafts = () => Object.keys(JSON.parse(readFileSync(join(dir, "fake.json"), "utf8")).drafts).length;
  const url = `http://127.0.0.1:${port}`;
  return { dir, port, url, service, versions, attempts, write, drafts, client: (f?: typeof fetch) => new DraftServiceClient(url, join(dir, "token"), f) };
}

const noSleep = async () => undefined;

test("delivers the exact saved article once; repeating returns the same draft and receipt", async () => {
  const h = await harness();
  try {
    const article = await h.write();
    const d = { attempts: h.attempts, versions: h.versions, client: h.client(), sleep: noSleep };
    const first = await deliverArticle(d, article);
    assert.equal(first.status, "created");
    assert.deepEqual(first.readback, { titleMatches: true, published: false, emailSent: false });
    const { request } = await buildRequest(h.attempts, h.versions, article);
    assert.ok(request.title.startsWith(`[exp-911 mastra ${request.attempt}] `));
    assert.equal(request.bodyMarkdown, (await h.attempts.article(article))!.markdown, "the exact retained article");
    const again = await deliverArticle(d, article);
    assert.deepEqual([again.status, again.draftId, again.receiptId], ["existing", first.draftId, first.receiptId]);
    assert.equal(h.drafts(), 1);
    const [record] = await h.attempts.deliveries(10);
    assert.equal(record!.tries, 2);
  } finally {
    h.service.kill("SIGTERM");
  }
});

test("a lost response after creation and a service restart never create a second draft", async () => {
  const h = await harness();
  try {
    const article = await h.write();
    // The service handles the request, but the response never reaches Mastra.
    let dropped = false;
    const lossy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetch(input, init);
      if (!dropped && init?.method === "POST" && String(input).endsWith("/v1/drafts")) {
        dropped = true;
        throw new TypeError("connection reset");
      }
      return res;
    }) as typeof fetch;
    const out = await deliverArticle({ attempts: h.attempts, versions: h.versions, client: h.client(lossy), sleep: noSleep }, article);
    assert.deepEqual(out.history.map((x) => [x.action, x.status]), [["deliver", "unreachable"], ["reconcile", "existing"]]);
    assert.equal(h.drafts(), 1);

    h.service.kill("SIGTERM");
    await once(h.service, "exit");
    const restarted = await startService(h.dir, h.port);
    try {
      const after = await deliverArticle({ attempts: h.attempts, versions: h.versions, client: h.client(), sleep: noSleep }, article);
      assert.deepEqual([after.status, after.draftId], ["existing", out.draftId]);
      assert.equal(h.drafts(), 1);
    } finally {
      restarted.kill("SIGTERM");
    }
  } finally {
    h.service.kill("SIGTERM");
  }
});

test("a changed payload under the same ID is a conflict and is not retried; separate attempts are separate drafts", async () => {
  const h = await harness();
  try {
    const a1 = await h.write();
    const a2 = await h.write();
    const d = { attempts: h.attempts, versions: h.versions, client: h.client(), sleep: noSleep };
    await deliverArticle(d, a1);
    const { request } = await buildRequest(h.attempts, h.versions, a1);
    const conflict = await h.client().deliver({ ...request, subtitle: "Changed" });
    assert.equal(conflict.status, "conflict");
    const second = await deliverArticle(d, a2);
    assert.equal(second.status, "created", "a fresh attempt is deliberately a new labelled draft");
    assert.equal(h.drafts(), 2);
  } finally {
    h.service.kill("SIGTERM");
  }
});

test("a definite destination failure is retried with the same ID and creates exactly one draft", async () => {
  const h = await harness();
  try {
    const article = await h.write();
    writeFileSync(join(h.dir, "fake.json"), JSON.stringify({ next: 1000, drafts: {}, faults: ["failNextCreate"] }));
    const out = await deliverArticle({ attempts: h.attempts, versions: h.versions, client: h.client(), sleep: noSleep }, article);
    assert.deepEqual(out.history.map((x) => x.status), ["failed", "created"]);
    assert.equal(h.drafts(), 1);
  } finally {
    h.service.kill("SIGTERM");
  }
});

/** A scripted client: each call returns the next scripted response, or throws to simulate an unreachable service. */
function scripted(steps: (Partial<import("../src/delivery/client.js").DraftResponse> | "unreachable")[]) {
  const { DraftServiceUnreachable } = require_client();
  const calls: string[] = [];
  const next = (kind: string) => {
    calls.push(kind);
    const s = steps.shift();
    if (s === undefined) throw new Error("script exhausted");
    if (s === "unreachable") throw new DraftServiceUnreachable();
    return Promise.resolve({ httpStatus: 200, status: "?", ...s });
  };
  return { calls, client: { deliver: () => next("deliver"), reconcile: () => next("reconcile"), status: () => next("status") } as unknown as DraftServiceClient };
}
let clientModule: typeof import("../src/delivery/client.js");
const require_client = () => clientModule;

async function scriptedHarness() {
  clientModule = await import("../src/delivery/client.js");
  const h = await harness();
  h.service.kill("SIGTERM");
  return h;
}
const okReadback = { titleMatches: true, published: false, emailSent: false };

test("success without explicit safe readback is reported as unverified", async () => {
  const h = await scriptedHarness();
  const article = await h.write();
  const s = scripted([{ status: "existing", draftId: "7", readback: undefined }, { status: "existing", draftId: "7" }]);
  const out = await deliverArticle({ attempts: h.attempts, versions: h.versions, client: s.client, sleep: noSleep }, article);
  assert.equal(out.status, "unverified");
  assert.deepEqual(s.calls, ["deliver", "status"]);
  const s2 = scripted([{ status: "existing", draftId: "7", readback: { ...okReadback, published: true } }, { status: "existing", readback: { ...okReadback, published: true } }]);
  assert.equal((await deliverArticle({ attempts: h.attempts, versions: h.versions, client: s2.client, sleep: noSleep }, article)).status, "unverified");
});

test("reconciliation not-found leads to a safe create rather than stopping", async () => {
  const h = await scriptedHarness();
  const article = await h.write();
  const s = scripted(["unreachable", { status: "not-found", httpStatus: 404 }, { status: "created", httpStatus: 201, draftId: "9", readback: okReadback }]);
  const out = await deliverArticle({ attempts: h.attempts, versions: h.versions, client: s.client, sleep: noSleep }, article);
  assert.deepEqual(s.calls, ["deliver", "reconcile", "deliver"]);
  assert.equal(out.status, "created");
});

test("after an earlier definite failure, a later lost response is recorded as uncertain", async () => {
  const h = await scriptedHarness();
  const article = await h.write();
  const s = scripted([{ status: "failed", httpStatus: 502 }, "unreachable", "unreachable"]);
  const out = await deliverArticle({ attempts: h.attempts, versions: h.versions, client: s.client, sleep: noSleep }, article);
  assert.equal(out.status, "uncertain");
  const [record] = await h.attempts.deliveries(10);
  assert.equal(record!.status, "uncertain");
});

test("a partial readback is not evidence of an unpublished, no-email draft", async () => {
  const h = await scriptedHarness();
  const article = await h.write();
  const partial = { titleMatches: true } as unknown as typeof okReadback;
  const s = scripted([{ status: "created", draftId: "7", readback: partial }, { status: "existing", readback: partial }]);
  assert.equal((await deliverArticle({ attempts: h.attempts, versions: h.versions, client: s.client, sleep: noSleep }, article)).status, "unverified");
});

test("an unreadable response body is treated as no answer and reconciled", async () => {
  const h = await harness();
  try {
    const article = await h.write();
    let truncated = false;
    const truncating = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetch(input, init);
      if (!truncated && init?.method === "POST" && String(input).endsWith("/v1/drafts")) {
        truncated = true;
        return new Response('{"status":"crea', { status: res.status, headers: { "content-type": "application/json" } });
      }
      return res;
    }) as typeof fetch;
    const out = await deliverArticle({ attempts: h.attempts, versions: h.versions, client: h.client(truncating), sleep: noSleep }, article);
    assert.deepEqual(out.history.map((x) => [x.action, x.status]), [["deliver", "unreachable"], ["reconcile", "existing"]]);
    assert.equal(out.status, "existing");
    assert.equal(h.drafts(), 1);
  } finally {
    h.service.kill("SIGTERM");
  }
});
