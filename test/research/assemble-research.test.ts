import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { WebAdapterError } from "../../src/controllers/research-web.js";
import { RESEARCH_COMPLETED_SUBJECT } from "../../src/events/research-completed-event.js";
import { assembleResearch } from "../../src/research/assemble-research.js";
import { retrieveCitations, saveCitationInventory } from "../../src/research/citation-inventory.js";
import type { DiscoveryData } from "../../src/research/discovery-data.js";
import { researchJobId } from "../../src/research/job.js";

let dir: string;
let artifacts: GitArtifactStore;
let operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-assemble-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await artifacts.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

const request = {
  schemaVersion: 1 as const,
  origin: "manual" as const,
  subject: "Mast safety",
  pass: 1,
  claims: [],
  corpusRefs: [],
};
const data = (over: Partial<DiscoveryData> = {}): DiscoveryData => ({
  report: "# Report\n\nFindings with https://ok.example/a.",
  citations: [
    "https://ok.example/a",
    "https://gone.example/x",
    "https://moved.example/m",
    "https://slow.example/s",
    "ftp://files.example/f",
  ],
  annotationUrls: [],
  searchResultUrls: [],
  model: "fake/sonar",
  citationProvenance: "provider-original",
  ...over,
});
const fetcher = (behaviour: Record<string, WebAdapterError[]>) => ({
  async fetch(url: string) {
    const next = behaviour[url]?.shift();
    if (next) throw next;
    return { url, title: url, text: `Text of ${url}` };
  },
});
const limits = {
  maxSources: 10,
  maxAttempts: 1,
  timeoutMs: 1_000,
  maxSourceChars: 10_000,
  backoffMs: 1,
};

async function stages(d: DiscoveryData, behaviour: Record<string, WebAdapterError[]>) {
  const discovery = await artifacts.write("research-discovery/req-1/disc-1/result.json", "{}");
  const { ref: inventory } = await saveCitationInventory({
    artifacts,
    discovery,
    readDiscovery: async () => d,
  });
  await retrieveCitations({ artifacts, inventory, fetcher: fetcher(behaviour), limits });
  return { discovery, inventory };
}
const events = () =>
  operations
    .duePendingEvents(50, RESEARCH_COMPLETED_SUBJECT)
    .map((e) => JSON.parse(e.payload).data);

describe("assemble research from saved stages (#592)", { timeout: 60_000 }, () => {
  it("records mixed outcomes with explicit gaps and never treats retrieval as support", async () => {
    const { discovery, inventory } = await stages(data(), {
      "https://gone.example/x": [new WebAdapterError("not-found", 404)],
      "https://moved.example/m": [new WebAdapterError("redirected")],
      "https://slow.example/s": [new WebAdapterError("rate-limited", 429)],
    });
    const out = await assembleResearch({
      artifacts,
      operations,
      discovery,
      inventory,
      read: async () => ({ data: data(), request }),
      owner: "test",
    });
    expect(out).toMatchObject({
      jobId: researchJobId(request),
      outcome: "complete-with-gaps",
      reused: false,
      pending: 1,
    });
    const manifest = JSON.parse(await artifacts.read(out.manifest));
    const byUrl = new Map(manifest.citations.map((c: { url: string }) => [c.url, c]));
    expect(byUrl.get("https://ok.example/a")).toMatchObject({
      retrieval: "archived",
      support: "not-checked",
    });
    expect(byUrl.get("https://gone.example/x")).toMatchObject({
      retrieval: "inaccessible",
      retrievalReason: "not-found",
    });
    expect(byUrl.get("https://moved.example/m")).toMatchObject({ retrieval: "unsupported" });
    expect(byUrl.get("https://slow.example/s")).toMatchObject({
      retrieval: "not-attempted",
      retrievalReason: "retrieval-pending",
    });
    expect(manifest.citations.every((c: { support: string }) => c.support === "not-checked")).toBe(
      true,
    );
    expect(manifest.gaps.join(" ")).toMatch(/not yet assessed as support/);
    expect(manifest.gaps.join(" ")).toMatch(/could not be fetched/);
    // One completion event, recorded with the result.
    expect(events()).toEqual([
      expect.objectContaining({ jobId: out.jobId, outcome: "complete-with-gaps" }),
    ]);
  });

  it("replays identically without rebuilding or emitting again", async () => {
    const { discovery, inventory } = await stages(data(), {});
    const first = await assembleResearch({
      artifacts,
      operations,
      discovery,
      inventory,
      read: async () => ({ data: data(), request }),
      owner: "test",
    });
    const again = await assembleResearch({
      artifacts,
      operations,
      discovery,
      inventory,
      read: async () => ({ data: data(), request }),
      owner: "test",
    });
    expect(again).toMatchObject({ reused: true });
    expect(again.result.sha256).toBe(first.result.sha256);
    expect(again.manifest.sha256).toBe(first.manifest.sha256);
    expect(events()).toHaveLength(1);
  });

  it("recovers a crash before completion without duplicating artifacts or events", async () => {
    const { discovery, inventory } = await stages(data(), {});
    const crashing = new Proxy(operations, {
      get(target, prop, receiver) {
        if (prop === "complete") {
          return () => {
            throw new Error("crash");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(
      assembleResearch({
        artifacts,
        operations: crashing,
        discovery,
        inventory,
        read: async () => ({ data: data(), request }),
        owner: "test",
      }),
    ).rejects.toThrow("crash");
    expect(events()).toHaveLength(0);
    // The crashed attempt released its claim: a retry completes once.
    const retry = await assembleResearch({
      artifacts,
      operations,
      discovery,
      inventory,
      read: async () => ({ data: data(), request }),
      owner: "test",
    });
    expect(retry.outcome).toBe("complete-with-gaps");
    expect(events()).toHaveLength(1);
  });

  it("reports complete only when every cited source was retrieved from provider-original data", async () => {
    const clean = data({ citations: ["https://ok.example/a"], report: "# Report" });
    const { discovery, inventory } = await stages(clean, {});
    const out = await assembleResearch({
      artifacts,
      operations,
      discovery,
      inventory,
      read: async () => ({ data: clean, request }),
      owner: "test",
    });
    expect(out.outcome).toBe("complete");
  });
});

describe("assembly review regressions (#592)", { timeout: 60_000 }, () => {
  it("announces the retained result when a pending retrieval finishes before a retry", async () => {
    const d = data({
      citations: ["https://ok.example/a", "https://slow.example/s"],
      report: "# R",
    });
    const { discovery, inventory } = await stages(d, {
      "https://slow.example/s": [new WebAdapterError("rate-limited", 429)],
    });
    const crashing = new Proxy(operations, {
      get(target, prop, receiver) {
        if (prop === "complete")
          return () => {
            throw new Error("crash");
          };
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(
      assembleResearch({
        artifacts,
        operations: crashing,
        discovery,
        inventory,
        read: async () => ({ data: d, request }),
        owner: "t",
      }),
    ).rejects.toThrow("crash");
    // The pending source is retrieved before the retry.
    await retrieveCitations({ artifacts, inventory, fetcher: fetcher({}), limits });
    const out = await assembleResearch({
      artifacts,
      operations,
      discovery,
      inventory,
      read: async () => ({ data: d, request }),
      owner: "t",
    });
    // The event and the result agree with what was first saved.
    const saved = JSON.parse(await artifacts.read(out.result));
    expect(events()).toEqual([expect.objectContaining({ outcome: saved.outcome })]);
    expect(saved.outcome).toBe("complete-with-gaps");
  });

  it("keeps completion events of two discoveries of one request apart", async () => {
    const d = data({ citations: ["https://ok.example/a"], report: "# R" });
    const one = await artifacts.write("research-discovery/req-1/disc-1/result.json", "{}");
    const two = await artifacts.write("research-discovery/req-1/disc-2/result.json", "{}");
    for (const discovery of [one, two]) {
      const { ref: inventory } = await saveCitationInventory({
        artifacts,
        discovery,
        readDiscovery: async () => d,
      });
      await retrieveCitations({ artifacts, inventory, fetcher: fetcher({}), limits });
      await assembleResearch({
        artifacts,
        operations,
        discovery,
        inventory,
        read: async () => ({ data: d, request }),
        owner: "t",
      });
    }
    expect(events()).toHaveLength(2);
  });

  it("never reports success for an exhausted assembly", async () => {
    const d = data({ citations: ["https://ok.example/a"], report: "# R" });
    const { discovery, inventory } = await stages(d, {});
    const exhausted = new Proxy(operations, {
      get(target, prop, receiver) {
        if (prop === "claim") return () => ({ kind: "exhausted" });
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(
      assembleResearch({
        artifacts,
        operations: exhausted,
        discovery,
        inventory,
        read: async () => ({ data: d, request }),
        owner: "t",
      }),
    ).rejects.toThrow("assembly-exhausted");
  });
});
