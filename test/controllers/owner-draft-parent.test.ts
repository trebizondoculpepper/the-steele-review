import { createServer } from "node:http";
import { describe, expect, it, vi } from "vite-plus/test";
import { restateJudgeRecoveryCompletion } from "../../src/controllers/editorial-recovery-ingress.js";

describe("owner draft authoritative parent read (fast synthetic transport)", () => {
  it("only reads output and validates exact result shape without invoking or submitting", async () => {
    const run = vi.fn(() => {
        throw new Error("must never run");
      }),
      submit = vi.fn(() => {
        throw new Error("must never submit");
      });
    const output = vi.fn().mockResolvedValue({ ready: false });
    const connect = vi.fn(() => ({
      workflowClient: () => ({ run, workflowSubmit: submit, workflowOutput: output }),
    }));
    const port = restateJudgeRecoveryCompletion("https://example.invalid", connect as never);
    expect(await port.read("selected-parent")).toEqual({ state: "not-complete" });
    const ref = {
      repository: "content",
      commit: "a".repeat(40),
      path: "summary.json",
      sha256: "b".repeat(64),
    };
    output.mockResolvedValue({
      ready: true,
      result: {
        version: "editorial-judge-recovery-result-v1",
        outcome: "rejected",
        summary: ref,
        draft: ref,
        metadata: ref,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(await port.read("selected-parent")).toMatchObject({
      state: "completed",
      result: { outcome: "rejected", summary: ref },
    });
    output.mockResolvedValue({
      ready: true,
      result: { secretExtra: "SYNTHETIC-REJECTED-MATERIAL" },
    });
    await expect(port.read("selected-parent")).rejects.toThrow("invalid-response");
    expect(run).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(() => restateJudgeRecoveryCompletion("SYNTHETIC-private-invalid")).toThrow(
      "unconfigured",
    );
  });
  it("bounds stalled-body reads and never cancels or starts the parent", async () => {
    let closed = false,
      mutation = false;
    const server = createServer((request, response) => {
      if (
        request.method !== "GET" ||
        request.url?.includes("send") ||
        request.url?.includes("cancel")
      )
        mutation = true;
      response.on("close", () => {
        closed = true;
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    try {
      await expect(
        restateJudgeRecoveryCompletion(`http://127.0.0.1:${address.port}`, undefined, 80).read(
          "selected-parent",
        ),
      ).rejects.toMatchObject({ code: "timeout" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(true);
      expect(mutation).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
