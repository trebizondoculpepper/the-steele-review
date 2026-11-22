import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ErrorEvent } from "@sentry/node";
import {
  APPLICATION_ERROR_MESSAGE,
  applicationError,
  sanitizeApplicationError,
} from "../../src/controllers/sentry-logs.js";
import { createDashboardServer, type DashboardView } from "../../src/dashboard/server.js";

// Poison values that must never leave the process (#723).
const POISON = [
  "poison-host.internal",
  "/private/poison/path",
  "poison-api-key-123",
  "poison-user@example.com",
];

afterEach(() => vi.restoreAllMocks());

async function serve(views: DashboardView[]) {
  const reports: unknown[][] = [];
  const server = createDashboardServer(views, undefined, (...args) => reports.push(args));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, reports, close: () => new Promise((r) => server.close(r)) };
}

describe("dashboard render failures (#723)", () => {
  it("returns 503 with the fixed signal and reports only the view and category", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(a.join(" ")));
    const throwing: DashboardView = {
      path: "/articles",
      title: "Articles",
      async render() {
        const e = new Error(`connect ${POISON[0]} ${POISON[1]} key=${POISON[2]}`);
        (e as Error & { meta?: unknown }).meta = { user: POISON[3] };
        throw e;
      },
    };
    const s = await serve([throwing]);
    try {
      const res = await fetch(`${s.base}/articles?q=${encodeURIComponent(POISON[3]!)}`, {
        headers: { authorization: `Bearer ${POISON[2]}` },
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("x-view-status")).toBe("unavailable");
      const body = await res.text();
      expect(body).toContain("This view is unavailable right now.");
      // Exactly the permitted diagnostic, once.
      expect(s.reports).toEqual([["/articles", "render-failed"]]);
      expect(logged).toEqual([
        JSON.stringify({ event: "dashboard.view", view: "/articles", outcome: "render-failed" }),
      ]);
      for (const p of POISON) {
        expect(body).not.toContain(p);
        expect(JSON.stringify(s.reports)).not.toContain(p);
        expect(logged.join("\n")).not.toContain(p);
      }
    } finally {
      await s.close();
    }
  });

  it("reports nothing for a healthy render", async () => {
    const s = await serve([
      { path: "/articles", title: "Articles", render: async () => "<p>ok</p>" },
    ]);
    try {
      const res = await fetch(`${s.base}/articles`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-view-status")).toBeNull();
      expect(s.reports).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("keeps the response when the reporter itself fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = createDashboardServer(
      [
        {
          path: "/articles",
          title: "Articles",
          render: async () => Promise.reject(new Error("x")),
        },
      ],
      undefined,
      () => {
        throw new Error("telemetry down");
      },
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/articles`,
      );
      expect(res.status).toBe(503);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("application error telemetry filter (#723)", () => {
  const base = { event_id: "e1", timestamp: 1, platform: "node" } as ErrorEvent;

  it("accepts the permitted diagnostic and rebuilds it with nothing else", () => {
    const event = {
      ...base,
      type: undefined,
      message: APPLICATION_ERROR_MESSAGE,
      tags: { view: "/articles", category: "render-failed", extra: POISON[0] },
      request: { url: `https://${POISON[0]}/articles?q=${POISON[3]}`, headers: { a: POISON[2] } },
      server_name: POISON[0],
      contexts: { os: { name: POISON[1] } },
      extra: { config: POISON[2] },
      user: { email: POISON[3] },
      breadcrumbs: [{ message: POISON[1] }],
      exception: { values: [{ value: POISON[1] }] },
    } as unknown as ErrorEvent;
    const out = sanitizeApplicationError(event);
    expect(out).toEqual({
      type: undefined,
      event_id: "e1",
      timestamp: 1,
      platform: "node",
      level: "error",
      message: APPLICATION_ERROR_MESSAGE,
      tags: { view: "/articles", category: "render-failed" },
      fingerprint: [APPLICATION_ERROR_MESSAGE, "/articles", "render-failed"],
    });
    for (const p of POISON) expect(JSON.stringify(out)).not.toContain(p);
  });

  it("drops any other event, exception or unpermitted field value", () => {
    const drop = (e: Partial<ErrorEvent>) =>
      expect(sanitizeApplicationError({ ...base, ...e } as ErrorEvent)).toBeNull();
    drop({ message: "anything else", tags: { view: "/articles", category: "render-failed" } });
    drop({ exception: { values: [{ type: "Error", value: POISON[1] }] } });
    drop({ message: APPLICATION_ERROR_MESSAGE, tags: { view: "/articles", category: "boom" } });
    drop({
      message: APPLICATION_ERROR_MESSAGE,
      tags: { view: "/articles?q=x", category: "render-failed" },
    });
    drop({
      message: APPLICATION_ERROR_MESSAGE,
      tags: { view: `/${POISON[0]}`, category: "render-failed" },
    });
    drop({ message: APPLICATION_ERROR_MESSAGE });
  });

  it("allowlists view paths and categories", () => {
    expect(applicationError("/drafts/article", "render-failed")).toEqual({
      view: "/drafts/article",
      category: "render-failed",
    });
    expect(applicationError("https://x/articles", "render-failed")).toBeUndefined();
    expect(applicationError("/Articles", "render-failed")).toBeUndefined();
    expect(applicationError("/articles", "stack")).toBeUndefined();
  });
});
