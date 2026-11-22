import { createServer } from "node:http";
import { describe, it, expect, vi } from "vite-plus/test";
import {
  restateRecoveryParentCompletion,
  restateJudgeRecovery,
} from "../../src/controllers/editorial-recovery-ingress.js";
describe("judge recovery ingress", () => {
  it("fails private configuration safely and reads parent output without invoking it", async () => {
    const run = vi.fn(() => {
        throw new Error("must not invoke");
      }),
      output = vi.fn().mockResolvedValue({ ready: false });
    const connect = vi.fn(() => ({ workflowClient: () => ({ run, workflowOutput: output }) }));
    expect(
      await restateRecoveryParentCompletion("http://example.invalid", connect as never).read(
        "parent",
      ),
    ).toEqual({ state: "not-complete" });
    expect(run).not.toHaveBeenCalled();
    output.mockResolvedValue({
      ready: true,
      result: { outcome: "failed", secretExtra: "synthetic-marker" },
    });
    await expect(
      restateRecoveryParentCompletion("http://example.invalid", connect as never).read("parent"),
    ).rejects.toMatchObject({ code: "invalid-response" });
    const fail = vi.fn(() => {
      throw new Error("synthetic-private-configuration-marker");
    });
    await expect(
      restateRecoveryParentCompletion("http://example.invalid", fail).read("parent"),
    ).rejects.toThrow("unconfigured");
    await expect(
      restateRecoveryParentCompletion(undefined, connect as never).read("parent"),
    ).rejects.toThrow("unconfigured");
    expect(() => restateJudgeRecovery("invalid-private-configuration-marker")).toThrow(
      "unconfigured",
    );
  });
  it("validates receipt and releases a stalled attach without cancelling the accepted workflow", async () => {
    let invalid = true,
      accepted = false,
      closed = false,
      cancelled = false;
    const server = createServer((request, response) => {
      if (request.url?.endsWith("/send")) {
        response.writeHead(200, { "content-type": "application/json" });
        if (invalid)
          response.end(
            JSON.stringify({
              invocationId: "not-valid",
              status: "Unexpected",
              privateValue: "synthetic-marker",
            }),
          );
        else {
          accepted = true;
          response.end(JSON.stringify({ invocationId: "inv_synthetic", status: "Accepted" }));
        }
      } else {
        if (request.url?.includes("cancel")) cancelled = true;
        response.on("close", () => {
          closed = true;
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.write("{");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing synthetic listener");
    try {
      const adapter = restateJudgeRecovery(`http://127.0.0.1:${address.port}`),
        input = {
          version: "editorial-judge-recovery-run-v1" as const,
          requestId: "synthetic",
          generation: 1,
          intent: {
            repository: "content",
            commit: "a".repeat(40),
            path: "intent.json",
            hash: `sha256:${"b".repeat(64)}`,
          },
        };
      await expect(adapter.submit("synthetic", input)).rejects.toMatchObject({
        code: "invalid-response",
      });
      invalid = false;
      expect((await adapter.submit("synthetic", input)).invocationId).toBe("inv_synthetic");
      await expect(adapter.attach("synthetic", 50)).rejects.toMatchObject({ code: "timeout" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(accepted).toBe(true);
      expect(cancelled).toBe(false);
      expect(closed).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
