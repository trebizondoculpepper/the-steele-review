import { describe, expect, it } from "vite-plus/test";
import { statusView, type StatusSnapshot, type StatusSource } from "../../src/dashboard/status.js";

const snapshot = (over: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  observedAt: "2026-01-01T10:00:00.000Z",
  services: [
    { name: "state", state: "healthy" },
    { name: "nats", state: "unavailable" },
    { name: "elasticsearch", state: "not-configured" },
  ],
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
  const html = await statusView(source(value)).render(new URL("http://dashboard.test/status"));
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

  it("reports a truncated archive scan", async () => {
    const html = await render(snapshot({ archive: { state: "ok", captured: 2000, truncated: true } }));
    expect(html).toContain("scan truncated");
  });

  it("renders an unavailable page instead of throwing when the source fails", async () => {
    const html = await render(new Error("boom"));
    expect(html).toContain("System status is unavailable");
    expect(html).not.toContain("boom");
  });

  it("registers under /status with a navigation title", () => {
    const view = statusView(source(snapshot()));
    expect(view.path).toBe("/status");
    expect(view.title).toBe("Status");
  });
});
