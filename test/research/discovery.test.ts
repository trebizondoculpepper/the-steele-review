import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { OpenRouterSonarClient } from "../../src/research/sonar.js";
import { selectDiscoveryData } from "../../src/controllers/sonar-discovery-replay.js";
import { ModelProviderError } from "../../src/controllers/openrouter.js";
import {
  captureResearchDiscovery,
  discoveryIdentity,
  readResearchDiscovery,
  readLengthLimitedResearchDiscovery,
  ResearchDiscoveryError,
  type DiscoveryData,
  type DiscoveryCapture,
} from "../../src/research/discovery.js";
let dir: string, artifacts: GitArtifactStore, operations: OperationStore, clock: number;
const request = {
  schemaVersion: 1,
  origin: "manual",
  pass: 1,
  subject: "Synthetic public subject",
  claims: [],
  corpusRefs: [],
};
const processor = {
  version: "research-discovery-v1" as const,
  model: "fixture/research",
  promptVersion: "prompt-sha256:synthetic",
  parameters: { maxOutputTokens: 4000, timeoutMs: 1000 },
};
const data: DiscoveryData = {
  report: "  Original report.  ",
  citations: ["not a URL", "https://source.example/x#anchor", "https://source.example/x#anchor"],
  annotationUrls: [],
  searchResultUrls: [],
  model: "fixture/resolved",
  citationProvenance: "provider-original",
  usage: { costUsd: 0.2, totalTokens: 300 },
};
const body = (finish_reason = "stop") =>
  JSON.stringify({
    model: data.model,
    choices: [{ message: { content: data.report }, finish_reason }],
    citations: data.citations,
    usage: { cost: 0.2, total_tokens: 300 },
  });
const options = () => ({
  artifacts,
  operations,
  request,
  processor,
  owner: "synthetic-owner",
  leaseMs: 1000,
  now: () => new Date(clock),
});
const path = () => {
  const x = discoveryIdentity(request, processor);
  return `research-discovery/${x.requestId}/${x.discoveryId}`;
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "research-discovery-"));
  await mkdir(join(dir, "content"));
  artifacts = new GitArtifactStore({
    repoPath: join(dir, "content"),
    repository: "private-content",
  });
  await artifacts.initialise();
  clock = Date.parse("2026-01-01T00:00:00Z");
  operations = new OperationStore({ path: join(dir, "state.sqlite"), now: () => clock });
});
afterEach(async () => {
  operations?.close();
  await rm(dir, { recursive: true, force: true });
});
describe("durable research discovery", { timeout: 60000 }, () => {
  it("commits original response before interpretation and reuses after a downstream crash", async () => {
    let calls = 0;
    const invoke = async (capture: DiscoveryCapture) => {
      calls++;
      await capture(body());
      const raw = await artifacts.lookup(`${path()}/response.txt`);
      expect(await artifacts.read(raw!)).toBe(body());
      return data;
    };
    const first = await captureResearchDiscovery({ ...options(), invoke });
    expect(first.data).toEqual(data);
    expect((await readResearchDiscovery(artifacts, first.ref, operations)).data).toEqual(data); // Invalid URLs, duplicates and whitespace have not been interpreted away.
    const second = await captureResearchDiscovery({ ...options(), invoke });
    expect(second.reused).toBe(true);
    expect(second.ref).toEqual(first.ref);
    expect(calls).toBe(1);
    const changed = discoveryIdentity(request, { ...processor, promptVersion: "different-prompt" });
    expect(changed.requestId).toBe(first.requestId);
    expect(changed.discoveryId).not.toBe(first.discoveryId);
  });
  it.each([
    ['{"choices":[', "invalid-json"],
    [JSON.stringify({ choices: [{ message: { content: { wrong: "shape" } } }] }), "invalid-schema"],
    [body("length"), "length-limit"],
  ])("retains invalid returned data without rediscovery: %s", async (raw, validation) => {
    let calls = 0;
    const invoke = async (capture: DiscoveryCapture) => {
      calls++;
      await capture(raw);
      throw new ModelProviderError("bad-response");
    };
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "invalid-report",
    });
    const saved = await artifacts.lookup(`${path()}/response.txt`);
    expect(await artifacts.read(saved!)).toBe(raw);
    const result = await artifacts.lookup(`${path()}/result.json`);
    expect(JSON.parse(await artifacts.read(result!))).toMatchObject({
      outcome: "invalid",
      validation,
    });
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "invalid-report",
    });
    expect(calls).toBe(1);
  });
  it("warning policy accepts only readable complete-transport length limits without altering retained discovery", async () => {
    const invoke = vi.fn(async (capture: DiscoveryCapture) => {
      await capture(body("length"));
      throw new ModelProviderError("bad-response");
    });
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "invalid-report",
    });
    const original = (await artifacts.lookup(`${path()}/result.json`))!;
    const bytes = await artifacts.read(original);
    const partial = await captureResearchDiscovery({
      ...options(),
      invoke,
      partialReport: "warning-v1",
    });
    expect(partial.partial).toBe(true);
    expect(partial.ref).toEqual(original);
    expect(partial.data.report).toBe(data.report);
    expect(await artifacts.read(original)).toBe(bytes);
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(readResearchDiscovery(artifacts, original, operations)).rejects.toMatchObject({
      code: "invalid-report",
    });
  });
  it.each([
    ["{", "complete"],
    [
      JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }),
      "complete",
    ],
    [body("length"), "incomplete"],
    [body("length"), "resource-limit"],
  ] as const)(
    "warning policy never accepts unreadable or technically truncated responses %s/%s",
    async (raw, transport) => {
      const invoke = vi.fn(async (capture: DiscoveryCapture) => {
        await capture({
          representation: "provider-json",
          body: Buffer.from(raw).toString("base64"),
          encoding: "base64",
          transport,
        });
        throw new ModelProviderError("bad-response");
      });
      await expect(
        captureResearchDiscovery({ ...options(), invoke, partialReport: "warning-v1" }),
      ).rejects.toMatchObject({ code: "invalid-report" });
      await expect(
        captureResearchDiscovery({ ...options(), invoke, partialReport: "warning-v1" }),
      ).rejects.toMatchObject({ code: "invalid-report" });
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );
  it("never treats empty historical length-limited data as a recoverable partial report", async () => {
    const invoke = async (capture: DiscoveryCapture) => {
      await capture(
        JSON.stringify({
          model: data.model,
          choices: [{ message: { content: "  " }, finish_reason: "length" }],
        }),
      );
      throw new ModelProviderError("bad-response");
    };
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "invalid-report",
    });
    const result = (await artifacts.lookup(`${path()}/result.json`))!;
    await expect(
      readLengthLimitedResearchDiscovery(artifacts, result, operations),
    ).rejects.toMatchObject({ code: "invalid-report" });
  });
  it("live-token dispatch selects an exact saved response before reading changed configuration", async () => {
    const appliedTokens = {
      maxOutputTokens: 4000,
      source: "file",
      revision: `config-sha256:${"a".repeat(32)}`,
    };
    const invoke = vi.fn(async (capture: DiscoveryCapture) => {
      await capture({
        representation: "provider-json",
        body: Buffer.from(body()).toString("base64"),
        encoding: "base64",
        transport: "complete",
        appliedTokens,
      });
      return data;
    });
    const first = await captureResearchDiscovery({ ...options(), invoke });
    const bytes = await artifacts.read(first.returned);
    expect(JSON.parse(bytes).appliedTokens).toEqual(appliedTokens);
    const forbidden = vi.fn(async () => {
      throw new Error("no settings read or dispatch on replay");
    });
    const changed = {
      ...processor,
      parameters: { ...processor.parameters, maxOutputTokens: 12000 },
    };
    const replay = await captureResearchDiscovery({
      ...options(),
      processor: changed,
      reuseSavedAttempt: true,
      invoke: forbidden,
    });
    expect(replay.ref).toEqual(first.ref);
    expect(replay.reused).toBe(true);
    expect(forbidden).not.toHaveBeenCalled();
    expect(await artifacts.read(first.returned)).toBe(bytes);
    // The preexisting fixed-client contract still uses its unchanged processor identity.
    expect(discoveryIdentity(request, processor)).toMatchObject({ discoveryId: first.discoveryId });
    expect(discoveryIdentity(request, changed).discoveryId).not.toBe(first.discoveryId);
  });
  it("refuses ambiguous saved attempts or an incomplete scan instead of buying another response", async () => {
    const invoke = vi.fn(async (capture: DiscoveryCapture) => {
      await capture(body());
      return data;
    });
    await captureResearchDiscovery({ ...options(), invoke });
    await captureResearchDiscovery({
      ...options(),
      processor: { ...processor, parameters: { ...processor.parameters, maxOutputTokens: 12000 } },
      invoke,
    });
    invoke.mockClear();
    await expect(
      captureResearchDiscovery({ ...options(), reuseSavedAttempt: true, invoke }),
    ).rejects.toMatchObject({ code: "archive-failed" });
    expect(invoke).not.toHaveBeenCalled();
    vi.spyOn(artifacts, "list").mockResolvedValue(
      Array.from({ length: 201 }, (_, i) => `synthetic/${i}`),
    );
    await expect(
      captureResearchDiscovery({ ...options(), reuseSavedAttempt: true, invoke }),
    ).rejects.toMatchObject({ code: "archive-failed" });
    expect(invoke).not.toHaveBeenCalled();
  });
  it("never recalls after an ambiguous no-response failure", async () => {
    let calls = 0;
    const invoke = async () => {
      calls++;
      throw new ModelProviderError("timeout");
    };
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "timeout",
    });
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "uncertain",
    });
    expect(calls).toBe(1);
  });
  it("allows confirmed pre-response credit rejection to recover, then fences any ambiguity", async () => {
    let calls = 0;
    const invoke = async () => {
      calls++;
      throw new ModelProviderError(calls === 1 ? "credit-exhausted" : "unavailable");
    };
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "credit-exhausted",
    });
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "uncertain",
    });
    expect(calls).toBe(2);
  });
  it("retains late responses without automatically accepting them", async () => {
    let calls = 0;
    const invoke = async (capture: DiscoveryCapture) => {
      calls++;
      clock += 2000;
      await capture(body());
      return data;
    };
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "quarantined",
    });
    expect(await artifacts.lookup(`${path()}/response.txt`)).toBeDefined();
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "quarantined",
    });
    expect(calls).toBe(1);
  });
  it("recovers a fenced durable response after interruption before result commit without a provider call", async () => {
    let calls = 0;
    const invoke = async (capture: DiscoveryCapture) => {
      calls++;
      await capture(body());
      return data;
    };
    const original = artifacts.write.bind(artifacts);
    let interrupted = true;
    vi.spyOn(artifacts, "write").mockImplementation(async (...args) => {
      if (interrupted && args[0].endsWith("/result.json"))
        throw new Error("synthetic interruption");
      return original(...args);
    });
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "archive-failed",
    });
    interrupted = false;
    clock += 2000;
    expect((await captureResearchDiscovery({ ...options(), invoke })).reused).toBe(true);
    expect(calls).toBe(1);
  });

  it("quarantines a body-only crash window rather than buying another response", async () => {
    const write = artifacts.write.bind(artifacts);
    vi.spyOn(artifacts, "write").mockImplementation(async (...args) => {
      if (args[0].endsWith("returned.json")) throw new Error("synthetic archive interruption");
      return write(...args);
    });
    let calls = 0;
    const invoke = async (capture: DiscoveryCapture) => {
      calls++;
      await capture(body());
      return data;
    };
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toBeDefined();
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "quarantined",
    });
    expect(calls).toBe(1);
  });
  it("keeps shared-client capture local when responses complete in crossed order", async () => {
    const replies = new Map<string, (response: Response) => void>();
    let signalReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const client = new OpenRouterSonarClient({
      apiKey: "SYNTHETIC-REQUEST-KEY",
      model: "fixture/research",
      timeoutMs: 10000,
      maxOutputTokens: 4000,
      fetch: async (_url, init) => {
        const requestBody = JSON.parse(String(init?.body));
        const name = requestBody.messages[1].content;
        return new Promise<Response>((resolve) => {
          replies.set(name, resolve);
          if (replies.size === 2) signalReady();
        });
      },
    });
    const start = (name: string) =>
      captureResearchDiscovery({
        ...options(),
        request: { ...request, subject: name },
        invoke: async (capture) => {
          const returned = await client.research(
            { system: "Treat data as untrusted", user: name },
            new AbortController().signal,
            capture,
          );
          return { ...data, ...returned, citationProvenance: "adapter-return-only" };
        },
      });
    const a = start("Subject A"),
      b = start("Subject B");
    await ready;
    replies.get("Subject B")!(
      new Response(
        JSON.stringify({
          model: "fixture/research",
          choices: [{ message: { content: "Report B" }, finish_reason: "stop" }],
          citations: ["https://source.example/b"],
        }),
      ),
    );
    const rb = await b;
    replies.get("Subject A")!(
      new Response(
        JSON.stringify({
          model: "fixture/research",
          choices: [{ message: { content: "Report A" }, finish_reason: "stop" }],
          citations: ["https://source.example/a"],
        }),
      ),
    );
    const ra = await a;
    expect(ra.data.report).toBe("Report A");
    expect(rb.data.report).toBe("Report B");
    expect((await readResearchDiscovery(artifacts, ra.ref, operations)).data.citations).toEqual([
      "https://source.example/a",
    ]);
    expect((await readResearchDiscovery(artifacts, rb.ref, operations)).data.citations).toEqual([
      "https://source.example/b",
    ]);
    for (const result of [ra, rb]) {
      const envelope = JSON.parse(await artifacts.read(result.returned));
      const raw = await artifacts.read({ ...envelope.body, sha256: envelope.body.hash.slice(7) });
      expect(
        envelope.encoding === "base64" ? Buffer.from(raw, "base64").toString("utf8") : raw,
      ).not.toContain("SYNTHETIC-REQUEST-KEY");
    }
  });
  it.each(["incomplete", "resource-limit"] as const)(
    "retains bounded %s bodies without accepting or recalling",
    async (transport) => {
      let calls = 0;
      const invoke = async (capture: DiscoveryCapture) => {
        calls++;
        await capture({ representation: "provider-json", body: body(), transport });
        throw new ModelProviderError("unavailable");
      };
      await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
        code: "invalid-report",
      });
      await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
        code: "invalid-report",
      });
      expect(calls).toBe(1);
      const saved = await artifacts.lookup(`${path()}/result.json`);
      expect(JSON.parse(await artifacts.read(saved!)).validation).toBe(
        transport === "incomplete" ? "transport-truncated" : "resource-limit",
      );
    },
  );
  it("rejects a misbound result and never copies request headers into selected provider metadata", async () => {
    const first = await captureResearchDiscovery({
      ...options(),
      invoke: async (capture) => {
        await capture(body());
        return data;
      },
    });
    const result = JSON.parse(await artifacts.read(first.ref));
    const forged = await artifacts.write(
      "fixtures/misbound-discovery.json",
      JSON.stringify({ ...result, requestId: "research-" + "0".repeat(32) }),
    );
    await expect(readResearchDiscovery(artifacts, forged, operations)).rejects.toMatchObject({
      code: "quarantined",
    });
    const selected = selectDiscoveryData(
      {
        choices: [{ message: { content: "Report" } }],
        headers: { authorization: "SENTINEL-HEADER" },
        request: { key: "SENTINEL-KEY" },
      },
      "fixture/model",
    );
    expect(JSON.stringify(selected)).not.toContain("SENTINEL");
    expect(() =>
      discoveryIdentity(request, { ...processor, headers: { authorization: "SENTINEL-HEADER" } }),
    ).toThrow();
  });
  it("retains a real adapter partial stream as invalid transport, not no-response", async () => {
    let calls = 0;
    const client = new OpenRouterSonarClient({
      apiKey: "SYNTHETIC-KEY",
      model: "fixture/research",
      timeoutMs: 10000,
      maxOutputTokens: 4000,
      fetch: async () => {
        calls++;
        let first = true;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (first) {
                first = false;
                controller.enqueue(new TextEncoder().encode('{"choices":['));
              } else controller.error(new Error("synthetic stream interruption"));
            },
          }),
        );
      },
    });
    const invoke = async (capture: DiscoveryCapture) => {
      await client.research(
        { system: "Research public facts", user: "fixture" },
        new AbortController().signal,
        capture,
      );
      return data;
    };
    try {
      await captureResearchDiscovery({ ...options(), invoke });
      throw new Error("expected invalid response");
    } catch (error) {
      expect(error).toBeInstanceOf(ResearchDiscoveryError);
      const failed = error as ResearchDiscoveryError;
      expect(failed.code).toBe("invalid-report");
      const result = JSON.parse(await artifacts.read(failed.artifacts!.result));
      expect(result.validation).toBe("transport-truncated");
      const envelope = JSON.parse(await artifacts.read(failed.artifacts!.returned));
      const stored = await artifacts.read({
        ...envelope.body,
        sha256: envelope.body.hash.slice(7),
      });
      expect(
        envelope.encoding === "base64" ? Buffer.from(stored, "base64").toString("utf8") : stored,
      ).toBe('{"choices":[');
    }
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "invalid-report",
    });
    expect(calls).toBe(1);
  });
  it("records adapter rejection after a valid raw body instead of silently accepting it", async () => {
    let calls = 0;
    const invoke = async (capture: DiscoveryCapture) => {
      calls++;
      await capture(body());
      throw new ModelProviderError("bad-response");
    };
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "invalid-report",
    });
    const saved = await artifacts.lookup(`${path()}/result.json`);
    expect(JSON.parse(await artifacts.read(saved!)).validation).toBe("adapter-rejected");
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "invalid-report",
    });
    expect(calls).toBe(1);
  });
  it("retains an exact multibyte prefix at the four-MiB byte limit without UTF-8 expansion", async () => {
    const limit = 4 * 1024 * 1024,
      wire = Buffer.concat([Buffer.alloc(limit - 1, 0x61), Buffer.from("€")]);
    let calls = 0;
    const client = new OpenRouterSonarClient({
      apiKey: "SYNTHETIC-KEY",
      model: "fixture/research",
      timeoutMs: 10000,
      maxOutputTokens: 4000,
      fetch: async () => {
        calls++;
        return new Response(wire);
      },
    });
    const invoke = async (capture: DiscoveryCapture) => {
      await client.research(
        { system: "public facts", user: "fixture" },
        new AbortController().signal,
        capture,
      );
      return data;
    };
    let resultRef;
    try {
      await captureResearchDiscovery({ ...options(), invoke });
      throw new Error("expected bounded invalid response");
    } catch (error) {
      const failed = error as ResearchDiscoveryError;
      expect(failed.code).toBe("invalid-report");
      resultRef = failed.artifacts!.result;
      const envelope = JSON.parse(await artifacts.read(failed.artifacts!.returned));
      expect(envelope).toMatchObject({
        encoding: "base64",
        byteLength: limit,
        transport: "resource-limit",
      });
      const encoded = await artifacts.read({
        ...envelope.body,
        sha256: envelope.body.hash.slice(7),
      });
      expect(Buffer.from(encoded, "base64").equals(wire.subarray(0, limit))).toBe(true);
    }
    expect(JSON.parse(await artifacts.read(resultRef!)).validation).toBe("resource-limit");
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "invalid-report",
    });
    expect(calls).toBe(1);
  });
  it("does not accept or revive a response after completion loses its active lease", async () => {
    let calls = 0;
    const invoke = async (capture: DiscoveryCapture) => {
      calls++;
      await capture(body());
      clock += 2000;
      return data;
    };
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "quarantined",
    });
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "quarantined",
    });
    expect(calls).toBe(1);
    const result = await artifacts.lookup(`${path()}/result.json`);
    await expect(readResearchDiscovery(artifacts, result!, operations)).rejects.toMatchObject({
      code: "quarantined",
    });
  });
  it("recovers a committed result after a transient state-completion interruption", async () => {
    let calls = 0;
    const invoke = async (capture: DiscoveryCapture) => {
      calls++;
      await capture(body());
      return data;
    };
    vi.spyOn(operations, "completeResearchDiscovery").mockImplementationOnce(() => {
      throw new Error("synthetic unavailable state");
    });
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "archive-failed",
    });
    clock += 2000;
    expect((await captureResearchDiscovery({ ...options(), invoke })).reused).toBe(true);
    expect(calls).toBe(1);
  });
  it("cannot accept after a crash between state rejection and the Git quarantine marker", async () => {
    const write = artifacts.write.bind(artifacts);
    vi.spyOn(artifacts, "write").mockImplementation(async (...args) => {
      if (args[0].endsWith("/quarantined.json")) throw new Error("synthetic marker interruption");
      return write(...args);
    });
    let calls = 0;
    const invoke = async (capture: DiscoveryCapture) => {
      calls++;
      await capture(body());
      clock += 2000;
      return data;
    };
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "archive-failed",
    });
    expect(await artifacts.lookup(`${path()}/quarantined.json`)).toBeUndefined();
    await expect(captureResearchDiscovery({ ...options(), invoke })).rejects.toMatchObject({
      code: "quarantined",
    });
    const result = await artifacts.lookup(`${path()}/result.json`);
    await expect(readResearchDiscovery(artifacts, result!, operations)).rejects.toMatchObject({
      code: "quarantined",
    });
    expect(calls).toBe(1);
  });
});
