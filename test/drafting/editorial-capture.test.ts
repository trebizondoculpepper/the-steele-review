import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { ModelProviderError } from "../../src/controllers/openrouter.js";
import { captureWriterAttempt } from "../../src/drafting/writer-attempts.js";
import { durableEditorialProvider } from "../../src/drafting/editorial-provider.js";
let dir: string, content: GitArtifactStore, operations: OperationStore, clock: number;
const ref = {
  repository: "content",
  commit: "a".repeat(40),
  path: "fixtures/package.json",
  sha256: "b".repeat(64),
};
const source = {
  repository: "archive",
  commit: "c".repeat(40),
  path: "substack/fixture/post/collected.json",
  hash: `sha256:${"d".repeat(64)}`,
};
const request = {
  system: "A synthetic fixed prompt",
  user: "Synthetic private article",
  maxOutputChars: 1000,
};
const signal = () => AbortSignal.timeout(5000);
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "editorial-capture-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  clock = 0;
  operations = new OperationStore({ path: join(dir, "state.sqlite"), now: () => clock });
});
afterEach(async () => {
  vi.restoreAllMocks();
  operations.close();
  await rm(dir, { recursive: true, force: true });
});
const wrapped = (complete: (r: any, signal: AbortSignal) => Promise<string>, recoveryId?: string) =>
  durableEditorialProvider({
    content,
    operations,
    provider: { modelVersion: "fixture/model", complete },
    purpose: "assessor",
    package: ref,
    source,
    context: [],
    promptVersion: "fixture-prompt-v1",
    recoveryId,
  });
describe("durable editorial calls", { timeout: 60000 }, () => {
  it("retains even malformed output before handing it to classification and reuses it", async () => {
    const call = vi.fn(async () => "Incomplete findings: {");
    const provider = wrapped(call);
    expect(await provider.complete(request, signal())).toBe("Incomplete findings: {");
    const manifest = JSON.parse(
      await content.read({
        ...provider.retainedAttempts()[0],
        sha256: provider.retainedAttempts()[0].hash.slice(7),
      }),
    );
    expect(manifest.purpose).toBe("assessor");
    expect(manifest.raw.path).toMatch(/^editorial-attempts\//);
    expect(await provider.complete(request, signal())).toBe("Incomplete findings: {");
    expect(call).toHaveBeenCalledTimes(1);
    expect(provider.retainedAttemptReuses()).toEqual([false, true]);
  });
  it("recovers response-before-manifest failure without another paid call", async () => {
    const original = content.write.bind(content);
    let failed = false;
    vi.spyOn(content, "write").mockImplementation(async (...args) => {
      if (args[0].endsWith("/manifest.json") && !failed) {
        failed = true;
        throw new Error("synthetic storage interruption");
      }
      return original(...args);
    });
    const call = vi.fn(async () => "No faults found.\nEND OF ASSESSMENT");
    await expect(wrapped(call).complete(request, signal())).rejects.toThrow();
    expect(await wrapped(call).complete(request, signal())).toContain("No faults found");
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("retains but never accepts an expired response or recalls its model", async () => {
    const call = vi.fn(async () => {
      clock = 600001;
      return "Late response";
    });
    const provider = wrapped(call);
    await expect(provider.complete(request, signal())).rejects.toThrow();
    expect(provider.retainedAttempts()).toHaveLength(1);
    await expect(wrapped(call).complete(request, signal())).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(1);
    expect(
      (await content.list("editorial-attempts", 100)).some((p) => p.endsWith("/response.txt")),
    ).toBe(true);
  });
  it("keeps a durable quarantine after completion refusal, including retry", async () => {
    const original = operations.completeEditorialCapture.bind(operations);
    vi.spyOn(operations, "completeEditorialCapture").mockImplementation((claim, artifact) => {
      clock += 600001;
      return original(claim, artifact);
    });
    const call = vi.fn(async () => "Retained response");
    await expect(wrapped(call).complete(request, signal())).rejects.toThrow();
    await expect(wrapped(call).complete(request, signal())).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("permits explicit recovery only for a definite rejection, never an ambiguous timeout", async () => {
    let reject = true;
    const call = vi.fn(async () => {
      if (reject) throw new ModelProviderError("credit-exhausted", 402);
      return "Recovered response";
    });
    await expect(wrapped(call).complete(request, signal())).rejects.toMatchObject({
      code: "credit-exhausted",
    });
    reject = false;
    expect(await wrapped(call, "owner-request").complete(request, signal())).toBe(
      "Recovered response",
    );
    expect(call).toHaveBeenCalledTimes(2);
    const timeout = vi.fn(async () => {
      throw new ModelProviderError("timeout");
    });
    const different = { ...request, user: "Another exact article" };
    await expect(wrapped(timeout).complete(different, signal())).rejects.toThrow();
    await expect(
      wrapped(timeout, "new-owner-request").complete(different, signal()),
    ).rejects.toThrow();
    expect(timeout).toHaveBeenCalledTimes(1);
  });
  it("preserves the legacy writer descriptor and identity when purpose is absent", async () => {
    const provider = {
      modelVersion: "fixture/model",
      complete: vi.fn(async () => "Writer output"),
    };
    const value = await captureWriterAttempt({
      content,
      operations,
      provider,
      request,
      package: ref,
      source,
      context: [],
      kind: "initial",
      number: 1,
      promptVersion: "fixture-prompt-v1",
      signal: signal(),
    });
    const descriptor = JSON.parse(
      await content.read({ ...value.manifest.input, sha256: value.manifest.input.hash.slice(7) }),
    );
    expect(descriptor).not.toHaveProperty("purpose");
    expect(value.manifest.attemptId).toBe(
      `writer-attempt-${createHash("sha256").update(JSON.stringify(descriptor)).digest("hex").slice(0, 32)}`,
    );
    expect(value.ref.path).toMatch(/^writer-attempts\//);
  });
});
