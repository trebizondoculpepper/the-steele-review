import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { WebAdapterError } from "../../src/controllers/research-web.js";
import {
  buildCitationInventory,
  retrieveCitations,
  saveCitationInventory,
  urlsInReport,
} from "../../src/research/citation-inventory.js";
import type { DiscoveryData } from "../../src/research/discovery-data.js";

let dir: string;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-citations-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await artifacts.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const data = (over: Partial<DiscoveryData> = {}): DiscoveryData => ({
  report:
    "See https://ok.example/a. Also https://ok.example/a#section-2, and https://gone.example/x).",
  citations: ["https://ok.example/a", "https://gone.example/x", "ftp://files.example/f"],
  annotationUrls: ["https://ok.example/a"],
  searchResultUrls: ["https://slow.example/s", "https://moved.example/m"],
  model: "fake/sonar",
  citationProvenance: "provider-original",
  ...over,
});

async function discoveryRef() {
  return artifacts.write("research-discovery/req-1/disc-1/result.json", "{}");
}

/** A synthetic fetcher: behaviour per URL, counting calls. */
function fetcher(behaviour: Record<string, Array<"ok" | WebAdapterError>>) {
  const calls: string[] = [];
  return {
    calls,
    async fetch(url: string) {
      calls.push(url);
      const next = behaviour[url]?.shift() ?? "ok";
      if (next !== "ok") throw next;
      return { url, title: `Title of ${url}`, text: `Text of ${url}` };
    },
  };
}

const limits = { maxSources: 10, maxAttempts: 2, timeoutMs: 1_000, maxSourceChars: 10_000 };

describe("citation inventory (#591)", () => {
  it("keeps every original URL and its origins, deduplicating only the fetch", () => {
    const entries = buildCitationInventory(data());
    const byUrl = new Map(entries.map((e) => [e.originalUrl, e]));
    // The same URL from citations, annotations and report text is one entry.
    expect(byUrl.get("https://ok.example/a")?.origins.map((o) => o.kind)).toEqual([
      "provider-citation",
      "annotation",
      "report-text",
    ]);
    // A cited anchor is its own citation, but shares the fetch with its page.
    const anchored = byUrl.get("https://ok.example/a#section-2")!;
    expect(anchored.id).not.toBe(byUrl.get("https://ok.example/a")!.id);
    expect(anchored.retrievalId).toBe(byUrl.get("https://ok.example/a")!.retrievalId);
    // Unfetchable URLs stay in the inventory with a reason.
    expect(byUrl.get("ftp://files.example/f")).toMatchObject({
      invalidReason: "unsupported-scheme",
    });
    expect(urlsInReport("Read https://x.example/p). Then https://y.example/q,")).toEqual([
      "https://x.example/p",
      "https://y.example/q",
    ]);
  });

  it("saves the inventory once and reuses it, never rebuilding from new data", async () => {
    const discovery = await discoveryRef();
    const first = await saveCitationInventory({ artifacts, discovery, data: data() });
    const second = await saveCitationInventory({
      artifacts,
      discovery,
      data: data({ citations: ["https://different.example/"] }),
    });
    expect(second.ref.sha256).toBe(first.ref.sha256);
    expect(second.inventory.entries.map((e) => e.originalUrl)).not.toContain(
      "https://different.example/",
    );
  });
});

describe("independent per-URL retrieval (#591)", { timeout: 60_000 }, () => {
  it("records each URL's own outcome without losing successful downloads", async () => {
    const discovery = await discoveryRef();
    const { ref } = await saveCitationInventory({ artifacts, discovery, data: data() });
    const f = fetcher({
      "https://gone.example/x": [new WebAdapterError("not-found", 404)],
      "https://slow.example/s": [
        new WebAdapterError("rate-limited", 429),
        new WebAdapterError("rate-limited", 429),
      ],
      "https://moved.example/m": [new WebAdapterError("redirected")],
    });
    const out = await retrieveCitations({ artifacts, inventory: ref, fetcher: f, limits });
    const status = new Map(out.outcomes.map((o) => [o.retrievalKey, o]));
    expect(status.get("https://ok.example/a")).toMatchObject({ status: "archived", attempts: 1 });
    expect(status.get("https://gone.example/x")).toMatchObject({
      status: "unavailable",
      reason: "not-found",
      httpStatus: 404,
    });
    expect(status.get("https://moved.example/m")).toMatchObject({
      status: "unsupported",
      reason: "redirected",
    });
    // Transient failures used their bounded attempts and are reported, not recorded.
    expect(status.has("https://slow.example/s")).toBe(false);
    expect(out.retryable).toEqual([expect.objectContaining({ reason: "rate-limited" })]);
    expect(f.calls.filter((u) => u === "https://slow.example/s")).toHaveLength(2);
    // The page behind a cited anchor was fetched once.
    expect(f.calls.filter((u) => u === "https://ok.example/a")).toHaveLength(1);
  });

  it("resumes from saved outcomes, retrying only what is still retryable", async () => {
    const discovery = await discoveryRef();
    const { ref } = await saveCitationInventory({ artifacts, discovery, data: data() });
    await retrieveCitations({
      artifacts,
      inventory: ref,
      fetcher: fetcher({
        "https://slow.example/s": [
          new WebAdapterError("unavailable", 503),
          new WebAdapterError("unavailable", 503),
        ],
      }),
      limits,
    });
    const again = fetcher({});
    const out = await retrieveCitations({ artifacts, inventory: ref, fetcher: again, limits });
    // Only the previously transient key is fetched again.
    expect(again.calls).toEqual(["https://slow.example/s"]);
    expect(out.retryable).toEqual([]);
    expect(out.outcomes.find((o) => o.retrievalKey === "https://slow.example/s")).toMatchObject({
      status: "archived",
    });
  });

  it("records keys beyond the limit as not attempted", async () => {
    const discovery = await discoveryRef();
    const { ref } = await saveCitationInventory({ artifacts, discovery, data: data() });
    const f = fetcher({});
    const out = await retrieveCitations({
      artifacts,
      inventory: ref,
      fetcher: f,
      limits: { ...limits, maxSources: 1 },
    });
    expect(f.calls).toHaveLength(1);
    expect(out.outcomes.filter((o) => o.status === "not-attempted").length).toBeGreaterThan(0);
    expect(
      out.outcomes.every((o) => o.status !== "not-attempted" || o.reason === "source-limit"),
    ).toBe(true);
  });

  it("adopts a snapshot saved before a crash instead of fetching again", async () => {
    const discovery = await discoveryRef();
    const { ref, inventory } = await saveCitationInventory({ artifacts, discovery, data: data() });
    const id = inventory.entries.find(
      (e) => e.originalUrl === "https://ok.example/a",
    )!.retrievalId!;
    await artifacts.write(
      `research-discovery/req-1/disc-1/citations/snapshots/${id}.json`,
      JSON.stringify({
        schemaVersion: 1,
        retrievalKey: "https://ok.example/a",
        url: "https://ok.example/a",
        title: "t",
        truncated: false,
        text: "saved",
      }),
    );
    const f = fetcher({});
    const out = await retrieveCitations({ artifacts, inventory: ref, fetcher: f, limits });
    expect(f.calls).not.toContain("https://ok.example/a");
    expect(out.outcomes.find((o) => o.retrievalId === id)).toMatchObject({ status: "archived" });
  });

  it("stops on exhausted provider credit rather than recording a verdict", async () => {
    const discovery = await discoveryRef();
    const { ref } = await saveCitationInventory({ artifacts, discovery, data: data() });
    const f = fetcher({ "https://ok.example/a": [new WebAdapterError("credit-exhausted", 402)] });
    await expect(
      retrieveCitations({ artifacts, inventory: ref, fetcher: f, limits }),
    ).rejects.toThrow("credit-exhausted");
  });
});
