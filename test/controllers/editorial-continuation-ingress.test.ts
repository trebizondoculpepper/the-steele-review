import { createServer } from "node:http";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  restateParentCompletion,
  restateEditorialContinuation,
} from "../../src/controllers/editorial-continuation-ingress.js";

describe("editorial continuation ingress boundary", () => {
  it("keeps missing or invalid continuation configuration from constructing a client", async () => {
    const connect = vi.fn();
    for (const value of [
      undefined,
      "not a URL",
      "file:///synthetic",
      "https://user:secret@example.invalid",
    ]) {
      await expect(
        restateParentCompletion(value, connect).read("synthetic-parent"),
      ).rejects.toMatchObject({ code: "unconfigured" });
    }
    expect(connect).not.toHaveBeenCalled();
    expect(() => restateEditorialContinuation("not a URL")).toThrow("unconfigured");
  });
  it("reads parent output only, without invoking a missing workflow", async () => {
    const run = vi.fn(() => {
      throw new Error("must not invoke");
    });
    const workflowOutput = vi.fn().mockResolvedValue({ ready: false });
    const connect = vi.fn(() => ({ workflowClient: () => ({ run, workflowOutput }) }));
    const port = restateParentCompletion("http://example.invalid", connect as never);
    expect(await port.read("synthetic-parent")).toEqual({ state: "not-complete" });
    expect(run).not.toHaveBeenCalled();
    workflowOutput.mockResolvedValue({
      ready: true,
      result: { outcome: "unexpected", secret: "synthetic-marker" },
    });
    await expect(port.read("synthetic-parent")).rejects.toMatchObject({ code: "invalid-response" });
  });
  it("bounds a stalled response body and sanitizes transport errors", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"outcome":');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    try {
      const port = restateParentCompletion(`http://127.0.0.1:${address.port}`, undefined, 50);
      await expect(port.read("synthetic-parent")).rejects.toMatchObject({ code: "timeout" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("times out attach without cancelling its accepted invocation and closes the observer request", async () => {
    let accepted = false,
      observerClosed = false,
      cancelRequests = 0;
    const server = createServer((request, response) => {
      if (request.url?.endsWith("/send")) {
        accepted = true;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ invocationId: "inv_synthetic", status: "Accepted" }));
      } else {
        if (request.url?.includes("cancel")) cancelRequests++;
        response.on("close", () => {
          observerClosed = true;
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.write("{");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    try {
      const port = restateEditorialContinuation(`http://127.0.0.1:${address.port}`);
      const input = {
        version: "editorial-continuation-run-v1",
        requestId: "synthetic",
        intent: {
          repository: "content",
          commit: "a".repeat(40),
          path: "intent.json",
          hash: "sha256:" + "b".repeat(64),
        },
      } as const;
      expect(await port.submit("synthetic", input)).toEqual({
        invocationId: "inv_synthetic",
        repeated: false,
      });
      await expect(port.attach("synthetic", 50)).rejects.toMatchObject({ code: "timeout" });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(accepted).toBe(true);
      expect(cancelRequests).toBe(0);
      expect(observerClosed).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
