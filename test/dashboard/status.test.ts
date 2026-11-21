import type { AddressInfo } from "node:net";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { describe, expect, it } from "vite-plus/test";
import { statusView, type StatusSnapshot, type StatusSource } from "../../src/dashboard/status.js";

const snapshot = (over: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  observedAt: "2026-01-01T10:00:00.000Z",
  services: [
    { name: "state", state: "healthy" },
    { name: "nats", state: "unavailable" },
    { name: "elasticsearch", state: "not-configured" },
  ],
  pipelineState: "healthy",
  operations: [{ status: "completed", count: 3 }],
  feedPoll: { state: "current", at: "2026-01-01T09:59:00.000Z" },
  archive: { state: "ok", captured: 12, truncated: false },
  indexCatchUp: { state: "behind", pendingChanges: 2 },
  ...over,
});

const source = (value: StatusSnapshot | Error): StatusSource => ({
  async read() {
    if (value instanceof Error) throw value;
    return value;
  },
});

const render = async (value: StatusSnapshot | Error) => {
  const html = await statusView(source(value)).render(new URL("http://dashboard.test/overview"));
  return html;
};

describe("statusView", () => {
  it("shows every check with its state and the observation time", async () => {
    const html = await render(snapshot());
    expect(html).toContain("Observed at");
    expect(html).toContain("2026-01-01T10:00:00.000Z");
    expect(html).toContain(">state<");
    expect(html).toContain(">unavailable<");
    expect(html).toContain(">not-configured<");
    expect(html).toContain(">completed<");
    expect(html).toContain(">12 captured<");
    expect(html).toContain("2 change(s) pending");
    expect(html).toContain("last poll");
  });

  it("labels stale polls, pending index work and unconfigured sources", async () => {
    const html = await render(
      snapshot({
        feedPoll: { state: "stale", at: "2026-01-01T08:00:00.000Z" },
        archive: { state: "not-configured" },
        indexCatchUp: { state: "pending" },
      }),
    );
    expect(html).toContain(">stale<");
    expect(html).toContain(">pending<");
    expect(html).toContain(">not-configured<");
    expect(html).not.toContain("captured");
  });

  it("distinguishes unreadable pipeline counts from an empty pipeline", async () => {
    const unavailable = await render(snapshot({ pipelineState: "unavailable", operations: [] }));
    expect(unavailable).toContain(">unavailable<");
    expect(unavailable).not.toContain("No operations recorded yet.");

    const empty = await render(snapshot({ pipelineState: "healthy", operations: [] }));
    expect(empty).toContain("No operations recorded yet.");
  });

  it("labels incomplete index coverage", async () => {
    const html = await render(snapshot({ indexCatchUp: { state: "incomplete" } }));
    expect(html).toContain(">incomplete<");
  });

  it("reports a truncated archive scan", async () => {
    const html = await render(
      snapshot({ archive: { state: "ok", captured: 2000, truncated: true } }),
    );
    expect(html).toContain("scan truncated");
  });

  it("renders an unavailable page instead of throwing when the source fails", async () => {
    const html = await render(new Error("boom"));
    expect(html).toContain("System status is unavailable");
    expect(html).not.toContain("boom");
  });

  it("registers the actual status page as Overview", () => {
    const view = statusView(source(snapshot()));
    expect(view.path).toBe("/overview");
    expect(view.title).toBe("Overview");
  });
  it("serves real diagnostics through the default Overview landing route", async () => {
    const server = createDashboardServer([statusView(source(snapshot()))]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const root = await fetch(base, { redirect: "manual" });
      expect(root.headers.get("location")).toBe("/overview");
      const response = await fetch(`${base}/overview`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("12 captured");
      expect(html).toContain("2 change(s) pending");
      expect(html).toContain("Feed poll");
      expect(html).toContain('aria-current="page">Overview');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
