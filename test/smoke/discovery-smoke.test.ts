/**
 * Container discovery smoke test (#12). Opt-in: set STEELE_SMOKE=1 and have
 * Docker available. Builds the application image and runs it against a
 * fixture HTTPS source and a disposable JetStream server, all synthetic.
 *
 * Covers: repeated live polling, overlapping backfills, broker outage while
 * live discovery keeps running, recovery after the broker restarts, CloudEvent
 * envelope/payload validation and expected post IDs and reasons. Removes only
 * the containers, network, image and files it created.
 */
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { NatsController } from "../../src/controllers/nats.js";
import { provisionDiscoveryStream } from "../../src/controllers/nats-provision.js";
import { parseDiscoveryEvent, type DiscoveryEvent } from "../../src/events/discovery-event.js";

const run = promisify(execFile);
const enabled = process.env.STEELE_SMOKE === "1";
const id = `steele-smoke-${Date.now().toString(36)}`;
const names = {
  image: `${id}:latest`,
  network: id,
  nats: `${id}-nats`,
  live: `${id}-live`,
};
const STREAM = "STEELE_SMOKE";
const SUBJECT = "steele.v1.source.detected";
const PUBLICATION = "example-pub";

const docker = (...args: string[]) =>
  run("docker", args, { maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout.trim());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(probe: () => Promise<T | undefined>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

// Synthetic fixture content.
const post = (n: number) => ({
  slug: `post-${n}`,
  title: `Synthetic post ${n}`,
  date: new Date(Date.UTC(2026, 0, 20 - n)).toISOString(),
});
const POSTS = Array.from({ length: 5 }, (_, i) => post(i));

let dir: string;
let fixture: Server;
let base: string;
let natsHostUrl: string;

function fixtureHandler(origin: string) {
  return (request: { url?: string }, response: import("node:http").ServerResponse) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/feed") {
      const items = POSTS.slice(0, 3)
        .map(
          (p) => `<item><title>${p.title}</title><link>${origin}/p/${p.slug}</link>
<guid isPermaLink="false">${origin}/p/${p.slug}</guid><pubDate>${new Date(p.date).toUTCString()}</pubDate></item>`,
        )
        .join("");
      response.writeHead(200, { "content-type": "application/rss+xml" });
      response.end(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>${items}</channel></rss>`,
      );
      return;
    }
    if (url.pathname === "/api/v1/archive") {
      const page = Number(url.searchParams.get("cursor") ?? "0");
      const slice = POSTS.slice(page * 2, page * 2 + 2);
      const next = page * 2 + 2 < POSTS.length ? String(page + 1) : null;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          posts: slice.map((p) => ({
            slug: p.slug,
            canonical_url: `${origin}/p/${p.slug}`,
            title: p.title,
            post_date: p.date,
          })),
          nextCursor: next,
        }),
      );
      return;
    }
    response.writeHead(404).end();
  };
}

async function streamEvents(): Promise<DiscoveryEvent[]> {
  const nats = new NatsController(natsHostUrl);
  await nats.connect("steele-smoke-reader");
  try {
    const jsm = await nats.manager();
    const info = await jsm.streams.info(STREAM);
    const events: DiscoveryEvent[] = [];
    for (let seq = info.state.first_seq; seq <= info.state.last_seq; seq++) {
      const msg = await jsm.streams.getMessage(STREAM, { seq });
      if (msg) events.push(parseDiscoveryEvent(new TextDecoder().decode(msg.data)));
    }
    return events;
  } finally {
    await nats.close();
  }
}

const appEnv = (port: number) => [
  "--network",
  names.network,
  "--add-host",
  "host.docker.internal:host-gateway",
  // Mount only the public certificate, world-readable, so the image's
  // unprivileged user can read it on any host UID; the key stays on the host.
  "-v",
  `${join(dir, "cert.pem")}:/certs/cert.pem:ro`,
  "-e",
  "NODE_EXTRA_CA_CERTS=/certs/cert.pem",
  "-e",
  `NATS_URL=nats://${names.nats}:4222`,
  "-e",
  `STEELE_DISCOVERY_STREAM=${STREAM}`,
  "-e",
  `STEELE_DISCOVERY_SUBJECT=${SUBJECT}`,
  "-e",
  `STEELE_FEED_URL=https://host.docker.internal:${port}/feed`,
  "-e",
  `STEELE_PUBLICATION_ID=${PUBLICATION}`,
];

async function backfill(port: number, maxItems: number, stream = STREAM) {
  try {
    const stdout = await docker(
      "run",
      "--rm",
      ...appEnv(port),
      "-e",
      `STEELE_DISCOVERY_STREAM=${stream}`,
      names.image,
      "node",
      "dist/cli/backfill.js",
      "--publication-url",
      `https://host.docker.internal:${port}/`,
      "--publication-id",
      PUBLICATION,
      "--max-items",
      String(maxItems),
    );
    return { code: 0, report: JSON.parse(stdout.split("\n").pop()!) };
  } catch (error) {
    const e = error as { code?: number; stdout?: string };
    return {
      code: e.code ?? 1,
      report: JSON.parse(
        String(e.stdout ?? "{}")
          .trim()
          .split("\n")
          .pop() || "{}",
      ),
    };
  }
}

describe.skipIf(!enabled)("container discovery smoke test", () => {
  let port = 0;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "steele-smoke-"));
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=host.docker.internal",
      "-addext",
      "subjectAltName=DNS:host.docker.internal,DNS:localhost",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ]);
    await chmod(join(dir, "cert.pem"), 0o644);
    fixture = createServer({
      key: await readFile(join(dir, "key.pem")),
      cert: await readFile(join(dir, "cert.pem")),
    });
    await new Promise<void>((r) => fixture.listen(0, "0.0.0.0", r));
    port = (fixture.address() as { port: number }).port;
    base = `https://host.docker.internal:${port}`;
    fixture.on("request", fixtureHandler(base));

    await docker("build", "-q", "-t", names.image, ".");
    await docker("network", "create", names.network);
    await docker(
      "run",
      "-d",
      "--name",
      names.nats,
      "--network",
      names.network,
      "-p",
      "127.0.0.1::4222",
      "nats:2",
      "-js",
      "-sd",
      "/data",
    );
    const mapped = await docker("port", names.nats, "4222/tcp");
    natsHostUrl = `nats://127.0.0.1:${mapped.split("\n")[0]!.split(":").pop()}`;
    const admin = new NatsController(natsHostUrl);
    await until(() => admin.connect("steele-smoke-admin").then(() => true), 20_000, "NATS");
    expect(await provisionDiscoveryStream(admin, { name: STREAM, subjects: [SUBJECT] })).toBe(
      "created",
    );
    await admin.close();
  }, 600_000);

  afterAll(async () => {
    for (const container of [names.live, names.nats]) {
      await docker("rm", "-f", container).catch(() => undefined);
    }
    await docker("network", "rm", names.network).catch(() => undefined);
    await docker("image", "rm", "-f", names.image).catch(() => undefined);
    await new Promise((r) => fixture?.close(r));
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it("polls repeatedly, survives a broker outage and recovers after restart", async () => {
    await docker(
      "run",
      "-d",
      "--name",
      names.live,
      ...appEnv(port),
      "-e",
      "STEELE_POLL_INTERVAL_MS=1000",
      "-e",
      "STEELE_MAX_BACKOFF_MS=2000",
      names.image,
      "node",
      "dist/cli/discover.js",
    );
    // Repeat polling: the same three posts are announced at least twice.
    const beforeOutage = await until(
      async () => {
        const events = await streamEvents();
        return events.length >= 6 ? events : undefined;
      },
      60_000,
      "two live polls",
    );
    for (const event of beforeOutage) {
      expect(event.type).toBe("org.steele.source.detected.v1");
      expect(event.data?.ingestionReason).toBe("live");
      expect(event.data?.publicationId).toBe(PUBLICATION);
    }
    expect(new Set(beforeOutage.map((e) => e.data?.postId))).toEqual(
      new Set(POSTS.slice(0, 3).map((p) => p.slug)),
    );
    expect(new Set(beforeOutage.map((e) => e.id)).size).toBe(beforeOutage.length);

    // Broker failure: discovery keeps running and backs off.
    await docker("stop", names.nats);
    await sleep(4_000);
    expect(await docker("inspect", "-f", "{{.State.Running}}", names.live)).toBe("true");

    // Restart recovery: stored events survive and polling resumes.
    await docker("start", names.nats);
    const mapped = await docker("port", names.nats, "4222/tcp");
    natsHostUrl = `nats://127.0.0.1:${mapped.split("\n")[0]!.split(":").pop()}`;
    const afterRestart = await until(
      async () => {
        const events = await streamEvents();
        return events.length >= beforeOutage.length + 3 ? events : undefined;
      },
      90_000,
      "polling after broker restart",
    );
    expect(afterRestart.slice(0, beforeOutage.length).map((e) => e.id)).toEqual(
      beforeOutage.map((e) => e.id),
    );
    const logs = await docker("logs", names.live);
    expect(logs).not.toContain("host.docker.internal");
    expect(logs).not.toMatch(/nats:\/\//);
    await docker("stop", "-t", "10", names.live);
  }, 240_000);

  it("runs overlapping backfills with stable content identity and honest exit codes", async () => {
    const before = (await streamEvents()).length;
    const first = await backfill(port, 3);
    const second = await backfill(port, 5);
    expect(first).toMatchObject({ code: 0, report: { ok: true, published: 3 } });
    expect(second).toMatchObject({
      code: 0,
      report: { ok: true, published: 5, enumeration: "count-limit" },
    });

    const events = (await streamEvents()).slice(before);
    expect(events.every((e) => e.data?.ingestionReason === "backfill")).toBe(true);
    expect(events.map((e) => e.data?.postId)).toEqual([
      ...POSTS.slice(0, 3).map((p) => p.slug),
      ...POSTS.map((p) => p.slug),
    ]);
    // Overlapping posts keep the same content subject with distinct event IDs.
    const overlap = events.filter((e) => e.data?.postId === "post-1");
    expect(overlap).toHaveLength(2);
    expect(overlap[0]!.subject).toBe(overlap[1]!.subject);
    expect(overlap[0]!.id).not.toBe(overlap[1]!.id);

    // A misconfigured stream fails with a nonzero exit and no partial success.
    const failed = await backfill(port, 2, "STEELE_SMOKE_MISSING");
    expect(failed.code).not.toBe(0);
    expect(failed.report).toMatchObject({ ok: false, failureStage: "publish" });
  }, 240_000);
});
