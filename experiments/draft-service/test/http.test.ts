import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";

const attempt = "mastra-20261126T101500Z-0a1b";
const body = {
  requestId: `exp-911:mastra:${attempt}`,
  experiment: "exp-911",
  platform: "mastra",
  attempt,
  title: `[exp-911 mastra ${attempt}] A review`,
  bodyMarkdown: "One paragraph.",
  source: {
    item: "substack:saveusnow:1",
    version: `substack:saveusnow:1@sha256:${"c".repeat(64)}`,
    url: "https://saveusnow.substack.com/p/x",
  },
  article: `${attempt}/article@sha256:${"d".repeat(64)}`,
};

async function start(dir: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["src/main.ts"], {
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
    child.stdout!.on("data", (chunk) => {
      seen += String(chunk);
      if (seen.includes('"listening"')) resolve();
    });
    child.once("exit", (code) => reject(new Error(`server exited early (${code})`)));
  });
  return child;
}

test("HTTP: authentication, readiness and delivery across a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "draft-http-"));
  const mastraToken = "m".repeat(40);
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");
  writeFileSync(join(dir, "clients.json"), JSON.stringify({ tokenSha256: { mastra: sha(mastraToken), n8n: sha("n".repeat(40)) } }));
  const port = 4300 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  const post = (token?: string) =>
    fetch(`${base}/v1/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  let child = await start(dir, port);
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/ready`)).status, 200);
    assert.equal((await post()).status, 401);
    assert.equal((await post("x".repeat(40))).status, 401);
    assert.equal((await post("n".repeat(40))).status, 403, "the n8n token cannot deliver a Mastra request");
    const { connect } = await import("node:net");
    const raw = await new Promise<string>((resolve) => {
      const sock = connect(port, "127.0.0.1", () => sock.write("GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n"));
      let data = "";
      sock.on("data", (d) => ((data += String(d)), sock.end()));
      sock.on("close", () => resolve(data));
    });
    assert.match(raw, /^HTTP\/1\.1 400/, "a malformed request target is rejected, not fatal");
    assert.equal((await fetch(`${base}/health`)).status, 200, "the service is still running");
    const created = await post(mastraToken);
    assert.equal(created.status, 201);
    const c = (await created.json()) as { draftId: string; receiptId: string };

    child.kill("SIGTERM");
    await once(child, "exit");
    child = await start(dir, port);

    const again = await post(mastraToken);
    assert.equal(again.status, 200);
    const a = (await again.json()) as { status: string; draftId: string; receiptId: string };
    assert.equal(a.status, "existing");
    assert.equal(a.draftId, c.draftId);
    const status = await fetch(`${base}/v1/deliveries/${encodeURIComponent(body.requestId)}`, {
      headers: { authorization: `Bearer ${mastraToken}` },
    });
    assert.equal(status.status, 200);
    const list = (await (await fetch(`${base}/v1/deliveries`, { headers: { authorization: `Bearer ${mastraToken}` } })).json()) as {
      deliveries: unknown[];
    };
    assert.equal(list.deliveries.length, 1);
    const text = JSON.stringify(list);
    assert.ok(!text.includes(mastraToken) && !text.includes(dir), "no secrets or paths in responses");
  } finally {
    child.kill("SIGTERM");
  }
});
