import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { FakeDraftDestination, SubstackDraftDestination, type DraftDestination } from "./destination.ts";
import { DeliveryStore } from "./store.ts";
import { DraftService } from "./service.ts";

/**
 * Shared draft service HTTP entry point (#912).
 *
 * The private deployment supplies configuration through the environment. The
 * files below are canonical private configuration, mounted read-only and re-read
 * on every request, so an edit applies to the next request:
 * - STEELE_DRAFT_DB: path of the SQLite delivery store (persistent volume).
 * - STEELE_DRAFT_CLIENTS_FILE: JSON {"tokenSha256": {"n8n": "<hex>", "mastra": "<hex>"}}:
 *   SHA-256 of each platform's bearer token. Only the platform holds its token.
 * - STEELE_DRAFT_DESTINATION: "substack" or "fake".
 * - STEELE_DRAFT_SUBSTACK_ORIGIN: bare https origin of the destination publication (substack).
 * - STEELE_DRAFT_SUBSTACK_SESSION_FILE: file holding the Substack session cookie value (substack).
 * - STEELE_DRAFT_FAKE_FILE: state file of the fake destination (fake).
 * - HOST / PORT: listen address (default 127.0.0.1:4200).
 *
 * Responses never contain credentials, configuration paths or request bodies
 * of upstream errors.
 */

const env = process.env;
const store = new DeliveryStore(env.STEELE_DRAFT_DB ?? "./.data/deliveries.sqlite");

function destination(): DraftDestination {
  const kind = env.STEELE_DRAFT_DESTINATION;
  if (kind === "fake") return new FakeDraftDestination(env.STEELE_DRAFT_FAKE_FILE ?? "./.data/fake-destination.json");
  if (kind === "substack") {
    const origin = env.STEELE_DRAFT_SUBSTACK_ORIGIN;
    const sessionFile = env.STEELE_DRAFT_SUBSTACK_SESSION_FILE;
    if (!origin || !sessionFile) throw new Error("substack destination is not configured");
    return new SubstackDraftDestination({ origin, session: () => readFile(sessionFile, "utf8") });
  }
  throw new Error("STEELE_DRAFT_DESTINATION must be substack or fake");
}

const ClientsSchema = z.object({ tokenSha256: z.partialRecord(z.enum(["n8n", "mastra"]), z.string().regex(/^[0-9a-f]{64}$/)) });

/** Returns the platform whose token matches the bearer token, if any. */
function authenticate(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? "";
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{32,256})$/.exec(header);
  if (!m) return undefined;
  const file = env.STEELE_DRAFT_CLIENTS_FILE;
  if (!file) return undefined;
  const clients = ClientsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!clients.success) return undefined;
  const presented = createHash("sha256").update(m[1]!).digest();
  for (const [platform, hex] of Object.entries(clients.data.tokenSha256)) {
    if (hex && timingSafeEqual(presented, Buffer.from(hex, "hex"))) return platform;
  }
  return undefined;
}

const service = new DraftService(store, destination);

async function readJson(req: IncomingMessage, limit = 200_000): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new RangeError("body-too-large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function log(event: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url ?? "/", "http://service.invalid");
  let platform: string | undefined;
  let status = 500;
  let outcome: string | undefined;
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      status = 200;
      return send(res, 200, { status: "ok" });
    }
    if (req.method === "GET" && url.pathname === "/ready") {
      let ready = store.ping();
      let reason: string | undefined;
      try {
        destination();
        ClientsSchema.parse(JSON.parse(readFileSync(env.STEELE_DRAFT_CLIENTS_FILE ?? "", "utf8")));
      } catch {
        ready = false;
        reason = "configuration-unavailable";
      }
      status = ready ? 200 : 503;
      return send(res, status, { status: ready ? "ready" : "not-ready", ...(reason ? { reason } : {}) });
    }
    platform = authenticate(req);
    if (!platform) {
      status = 401;
      return send(res, 401, { status: "unauthorised" });
    }
    let r;
    if (req.method === "POST" && url.pathname === "/v1/drafts") {
      r = await service.deliver(platform, await readJson(req));
    } else if (req.method === "GET" && url.pathname === "/v1/preflight") {
      // Read-only destination access check; never creates anything.
      const dest = destination();
      try {
        await dest.preflight();
        status = 200;
        return send(res, 200, { status: "ok", destination: dest.identity });
      } catch (e) {
        const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "unavailable";
        status = 503;
        return send(res, 503, { status: "not-ready", destination: dest.identity, error: `destination-${code}` });
      }
    } else if (req.method === "GET" && url.pathname === "/v1/deliveries") {
      status = 200;
      return send(res, 200, { deliveries: service.list(platform, Number(url.searchParams.get("limit") ?? 20)) });
    } else {
      const m = /^\/v1\/deliveries\/([A-Za-z0-9:%._-]{1,200})(\/reconcile|\/allow-recreate)?$/.exec(url.pathname);
      if (m) {
        m[1] = decodeURIComponent(m[1]!);
        if (!/^[A-Za-z0-9:._-]{1,120}$/.test(m[1])) {
          status = 400;
          return send(res, 400, { status: "invalid" });
        }
      }
      if (m && req.method === "GET" && !m[2]) r = await service.status(platform, m[1]!, url.searchParams.get("refresh") === "1");
      else if (m && req.method === "POST" && m[2] === "/reconcile") r = await service.status(platform, m[1]!, true);
      else if (m && req.method === "POST" && m[2] === "/allow-recreate") r = await service.allowRecreate(platform, m[1]!);
      else {
        status = 404;
        return send(res, 404, { status: "not-found" });
      }
    }
    status = r.httpStatus;
    outcome = r.body.status;
    return send(res, r.httpStatus, r.body);
  } catch (e) {
    status = e instanceof RangeError ? 413 : e instanceof SyntaxError ? 400 : 500;
    outcome = status === 500 ? "internal-error" : "invalid";
    return send(res, status, { status: outcome });
  } finally {
    log({ method: req.method, path: url.pathname, platform, status, outcome, ms: Date.now() - started });
  }
});

const port = Number(env.PORT ?? 4200);
server.listen(port, env.HOST ?? "127.0.0.1", () => log({ event: "listening", port }));
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
