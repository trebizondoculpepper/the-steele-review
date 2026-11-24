import * as clients from "@restatedev/restate-sdk-clients";
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { SubstackItem } from "../../src/content/substack-item.js";
import {
  discoveryPollObject,
  type DiscoveryPollObject,
  type PollStatus,
} from "../../src/discovery/restate-poll.js";
import type { DiscoveryEvent } from "../../src/events/discovery-event.js";

// Synthetic feed and an in-memory publisher only: no network, no NATS (#823).
const item = (slug: string): SubstackItem => ({
  publicationId: "example",
  postId: slug,
  url: `https://example.substack.com/p/${slug}`,
  title: `Post ${slug}`,
});
const feeds: Record<string, SubstackItem[]> = { alpha: [], beta: [], gamma: [], delta: [] };
const failFeed = new Set<string>();
const failPublishOnce = new Set<string>();
/** Like JetStream: a repeated event ID within the window is not a new message. */
const published: { source: string; id: string; postId: string }[] = [];
const statuses: { key: string; status: PollStatus }[] = [];
let fetches = 0;

let env: RestateTestEnvironment;
let ingress: clients.Ingress;
beforeAll(async () => {
  env = await RestateTestEnvironment.start(
    {
      services: [
        discoveryPollObject({
          sources: ["alpha", "beta", "gamma", "delta"],
          intervalMs: 60 * 60 * 1000, // long: tests drive polls explicitly
          maxBackoffMs: 4 * 60 * 60 * 1000,
          fetchItems: async function* (key) {
            fetches++;
            if (failFeed.has(key)) throw new TypeError("synthetic feed failure");
            yield* feeds[key]!;
          },
          publisher: {
            async publish(event: DiscoveryEvent) {
              const postId = event.data!.postId;
              if (failPublishOnce.delete(postId)) throw new Error("synthetic publish failure");
              if (!published.some((p) => p.id === event.id))
                published.push({ source: "x", id: event.id, postId });
            },
          },
          writeStatus: async (key, status) => void statuses.push({ key, status }),
        }),
      ],
      serviceEndpointAccess: "docker-host",
    },
    () => new RestateContainer("1.8.1"),
  );
  ingress = clients.connect({ url: env.baseUrl() });
}, 240_000);
afterAll(async () => {
  await env?.stop();
});
const poll = (key: string) =>
  ingress.objectClient<DiscoveryPollObject>({ name: "DiscoveryPoll" }, key);
const postsOf = (prefix: string) =>
  published.filter((p) => p.postId.startsWith(prefix)).map((p) => p.postId);

describe("discovery polls as Restate jobs (#823)", { timeout: 120_000 }, () => {
  it("publishes each newly discovered article once", async () => {
    feeds.alpha = [item("a-one"), item("a-two")];
    const first = await poll("alpha").poll({ reason: "manual" });
    expect(first).toMatchObject({ status: "complete", discovered: 2, published: 2 });
    // A later scheduled poll of the same feed publishes nothing new.
    const start = await poll("alpha").start();
    await new Promise((r) => setTimeout(r, 1500));
    expect(postsOf("a-")).toEqual(["a-one", "a-two"]);
    // One new article appears: exactly one event for it.
    feeds.alpha = [item("a-three"), ...feeds.alpha];
    await poll("alpha").poll({ reason: "scheduled", generation: start.generation });
    expect(postsOf("a-")).toEqual(["a-one", "a-two", "a-three"]);
  });

  it("coalesces an on-demand poll that arrives right after another", async () => {
    feeds.beta = [item("b-one")];
    const before = fetches;
    const [a, b] = await Promise.all([
      poll("beta").poll({ reason: "manual" }),
      poll("beta").poll({ reason: "manual" }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["coalesced", "complete"]);
    expect(fetches).toBe(before + 1);
    expect(postsOf("b-")).toEqual(["b-one"]);
  });

  it("keeps one effective schedule: a call from an older chain does nothing", async () => {
    feeds.gamma = [item("g-one")];
    const old = await poll("gamma").start();
    const current = await poll("gamma").start();
    expect(current.generation).not.toBe(old.generation);
    // Let the immediate polls that each start sent finish first.
    await new Promise((r) => setTimeout(r, 1500));
    const before = fetches;
    const stale = await poll("gamma").poll({ reason: "scheduled", generation: old.generation });
    expect(stale.status).toBe("superseded");
    expect(fetches).toBe(before);
  });

  it("retries a failed publish without a second event, and backs off after a feed failure", async () => {
    feeds.delta = [item("d-one")];
    failPublishOnce.add("d-one");
    const ok = await poll("delta").poll({ reason: "manual" });
    expect(ok.status).toBe("complete");
    expect(postsOf("d-")).toEqual(["d-one"]);

    failFeed.add("delta");
    const start = await poll("delta").start();
    await new Promise((r) => setTimeout(r, 1500));
    const failed = await poll("delta").poll({ reason: "scheduled", generation: start.generation });
    expect(failed).toMatchObject({
      status: "failed",
      failure: { stage: "source", errorName: "TypeError" },
    });
    // Backoff doubles the interval after consecutive failures.
    expect(failed.nextDelayMs).toBeGreaterThan(60 * 60 * 1000);
    const last = statuses.filter((s) => s.key === "delta").at(-1)!.status;
    expect(last).toMatchObject({ lastOutcome: "failed", consecutiveFailures: 2 });
    failFeed.delete("delta");
  });

  it("refuses a source this endpoint does not serve", async () => {
    await expect(poll("unknown").poll({ reason: "manual" })).rejects.toThrow(/unknown source/);
  });
});
