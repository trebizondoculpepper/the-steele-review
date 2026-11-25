import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDraftDestination } from "../src/destination.ts";
import { DeliveryStore } from "../src/store.ts";
import { DraftService } from "../src/service.ts";
import { markdownToProseMirror } from "../src/substack/prosemirror.ts";

const attempt = "n8n-20261126T101500Z-3f2a";
const hash = "a".repeat(64);

function request(overrides: Record<string, unknown> = {}) {
  return {
    requestId: `exp-911:n8n:${attempt}`,
    experiment: "exp-911",
    platform: "n8n",
    attempt,
    title: `[exp-911 n8n ${attempt}] What the patents do and do not show`,
    subtitle: "A summary and critique",
    bodyMarkdown: [
      "The speaker argues that patents prove a plan.",
      "",
      "## Problems with the argument",
      "",
      "- **Asserted by the author:** a patent shows intent to deploy. Why it matters: a patent is not evidence of use.",
      "- **Not checked:** the named standard exists.",
      "",
      "The argument rests on assertion rather than shown evidence.",
    ].join("\n"),
    source: {
      item: "substack:saveusnow:226395148",
      version: `substack:saveusnow:226395148@sha256:${hash}`,
      url: "https://saveusnow.substack.com/p/if-you-go-to-the-patents-and-the",
    },
    article: `${attempt}/article@sha256:${"b".repeat(64)}`,
    ...overrides,
  };
}

function setup(dir = mkdtempSync(join(tmpdir(), "draft-service-"))) {
  const fake = new FakeDraftDestination(join(dir, "fake.json"));
  const store = new DeliveryStore(join(dir, "deliveries.sqlite"));
  const service = new DraftService(store, () => fake);
  return { dir, fake, store, service };
}

test("the contract's article layout converts to a ProseMirror document", () => {
  const doc = markdownToProseMirror(request().bodyMarkdown);
  assert.deepEqual(
    doc.content.map((n) => n.type),
    ["paragraph", "heading", "bullet_list", "paragraph"],
  );
  assert.match(JSON.stringify(doc), /"type":"strong"/);
});

test("invalid requests are rejected with field-level issues and create nothing", async () => {
  const { service, fake } = setup();
  const r1 = await service.deliver("n8n", request({ title: "No label" }));
  assert.equal(r1.httpStatus, 400);
  assert.ok(r1.body.issues?.some((i) => i.path === "title"));
  const r2 = await service.deliver("n8n", request({ requestId: "exp-911:mastra:other" }));
  assert.equal(r2.httpStatus, 400);
  const r3 = await service.deliver("n8n", request({ bodyMarkdown: "<script>alert(1)</script>" }));
  assert.equal(r3.httpStatus, 400);
  const r4 = await service.deliver("n8n", { ...request(), publish: true });
  assert.equal(r4.httpStatus, 400, "unknown fields such as publish are refused");
  assert.equal(fake.count(), 0);
});

test("a platform cannot deliver or read another platform's request", async () => {
  const { service } = setup();
  assert.equal((await service.deliver("mastra", request())).httpStatus, 403);
  await service.deliver("n8n", request());
  assert.equal((await service.status("mastra", request().requestId, false)).httpStatus, 403);
});

test("repeated delivery returns the same draft; a changed payload conflicts", async () => {
  const { service, fake } = setup();
  const first = await service.deliver("n8n", request());
  assert.equal(first.httpStatus, 201);
  assert.equal(first.body.status, "created");
  assert.deepEqual(first.body.readback, { titleMatches: true, published: false, emailSent: false });
  assert.ok(first.body.receiptId);
  const again = await service.deliver("n8n", request());
  assert.equal(again.body.status, "existing");
  assert.equal(again.body.draftId, first.body.draftId);
  assert.equal(again.body.receiptId, first.body.receiptId);
  const changed = await service.deliver("n8n", request({ subtitle: "Different" }));
  assert.equal(changed.httpStatus, 409);
  assert.equal(changed.body.status, "conflict");
  assert.equal(fake.count(), 1);
});

test("concurrent identical requests create one draft", async () => {
  const { service, fake } = setup();
  const results = await Promise.all([1, 2, 3].map(() => service.deliver("n8n", request())));
  assert.deepEqual(results.map((r) => r.body.status).sort(), ["created", "existing", "existing"]);
  assert.equal(fake.count(), 1);
});

test("a lost response after creation is reconciled to the existing draft", async () => {
  const { service, fake } = setup();
  fake.inject("loseNextCreateResponse");
  const r = await service.deliver("n8n", request());
  assert.equal(r.body.status, "created");
  assert.ok(r.body.draftId);
  const again = await service.deliver("n8n", request());
  assert.equal(again.body.status, "existing");
  assert.equal(fake.count(), 1);
});

test("a definite failure is retryable and creates exactly one draft", async () => {
  const { service, fake } = setup();
  fake.inject("failNextCreate");
  const r = await service.deliver("n8n", request());
  assert.equal(r.httpStatus, 502);
  assert.equal(r.body.error, "destination-rate-limited");
  const retry = await service.deliver("n8n", request());
  assert.equal(retry.body.status, "created");
  assert.equal(retry.body.createAttempts, 2);
  assert.equal(fake.count(), 1);
});

test("interruption after external creation: a restarted service reconciles instead of creating again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "draft-service-"));
  const x = setup(dir);
  const ok = await x.service.deliver("n8n", request());
  assert.equal(ok.body.status, "created");
  // Crash window: the create reached the destination, but the process died
  // before the receipt was saved, so the durable record is still "pending".
  x.store.beginCreate(request().requestId, new Date().toISOString());
  x.store.close();
  const y = setup(dir); // restart over the same files
  const recovered = await y.service.deliver("n8n", request());
  assert.equal(recovered.body.status, "existing");
  assert.equal(recovered.body.draftId, ok.body.draftId);
  assert.equal(y.fake.count(), 1);
});

test("an uncertain delivery with no matching draft needs explicit recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "draft-service-"));
  const x = setup(dir);
  const req = request();
  await x.service.deliver("n8n", req);
  // The destination does not have the draft (lost request), but our record
  // says a create was in flight when the process stopped.
  const state = JSON.parse(readFileSync(join(dir, "fake.json"), "utf8"));
  state.drafts = {};
  writeFileSync(join(dir, "fake.json"), JSON.stringify(state));
  x.store.beginCreate(req.requestId, new Date().toISOString());
  x.store.close();
  const y = setup(dir);
  const blocked = await y.service.deliver("n8n", req);
  assert.equal(blocked.httpStatus, 503);
  assert.equal(blocked.body.status, "uncertain");
  assert.equal(blocked.body.error, "no-matching-draft-found");
  assert.equal(y.fake.count(), 0, "no blind second create");
  const stillBlocked = await y.service.deliver("n8n", req);
  assert.equal(stillBlocked.body.status, "uncertain");
  assert.equal(y.fake.count(), 0);
  const allowed = await y.service.allowRecreate("n8n", req.requestId);
  assert.equal(allowed.body.status, "failed");
  const recreated = await y.service.deliver("n8n", req);
  assert.equal(recreated.body.status, "created");
  assert.equal(y.fake.count(), 1);
});

test("a readback showing a published or emailed draft is never reported as delivered", async () => {
  const { service, fake, dir } = setup();
  const r = await service.deliver("n8n", request());
  const state = JSON.parse(readFileSync(join(dir, "fake.json"), "utf8"));
  state.drafts[r.body.draftId!].published = true;
  writeFileSync(join(dir, "fake.json"), JSON.stringify(state));
  // Force a fresh confirmation through reconcile.
  const store = (service as unknown as { store: DeliveryStore }).store;
  store.mark(request().requestId, "uncertain", "simulated", new Date().toISOString());
  const again = await service.deliver("n8n", request());
  assert.equal(again.body.status, "uncertain");
  assert.match(again.body.error ?? "", /readback-mismatch/);
  assert.equal(fake.count(), 1);
});

test("an incomplete listing never allows another create", async () => {
  const dir = mkdtempSync(join(tmpdir(), "draft-service-"));
  const x = setup(dir);
  const req = request();
  await x.service.deliver("n8n", req);
  const state = JSON.parse(readFileSync(join(dir, "fake.json"), "utf8"));
  state.drafts = {};
  writeFileSync(join(dir, "fake.json"), JSON.stringify(state));
  x.fake.inject("incompleteListing");
  x.store.beginCreate(req.requestId, new Date().toISOString());
  const blocked = await x.service.deliver("n8n", req);
  assert.equal(blocked.body.status, "uncertain");
  assert.match(blocked.body.error ?? "", /reconcile-incomplete/);
  const refused = await x.service.allowRecreate("n8n", req.requestId);
  assert.equal(refused.body.status, "uncertain", "operator recovery is refused while coverage is incomplete");
  assert.equal(x.fake.count(), 0);
});

test("status and recovery refuse a request recorded against a different destination", async () => {
  const dir = mkdtempSync(join(tmpdir(), "draft-service-"));
  const x = setup(dir);
  await x.service.deliver("n8n", request());
  const other = new FakeDraftDestination(join(dir, "other.json"));
  Object.defineProperty(other, "identity", { value: "other-destination" });
  const moved = new DraftService(x.store, () => other);
  assert.equal((await moved.status("n8n", request().requestId, true)).httpStatus, 409);
  assert.equal((await moved.allowRecreate("n8n", request().requestId)).httpStatus, 409);
  assert.equal(other.count(), 0);
});

test("Substack readback without explicit published and email fields is not evidence", async () => {
  const { SubstackDraftDestination } = await import("../src/destination.ts");
  const fetchStub = (async (url: URL) => {
    const body = String(url).includes("/api/v1/drafts/") ? { id: 7, draft_title: "t" } : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const dest = new SubstackDraftDestination({ origin: "https://example.substack.com", session: async () => "s", fetch: fetchStub });
  await assert.rejects(dest.read("7"), /invalid-response/);
});
