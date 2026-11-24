import type { AddressInfo } from "node:net";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { SubstackItem } from "../../src/content/substack-item.js";
import { parsePollSources, pollNowAction, type PollSource } from "../../src/dashboard/poll-now.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { discoveryPollObject, type DiscoveryPollObject } from "../../src/discovery/restate-poll.js";
import type { DiscoveryEvent } from "../../src/events/discovery-event.js";

// The real DiscoveryPoll handler in Restate, a synthetic feed and an
// in-memory publisher; the dashboard's real action route (#824).
const item = (pub: string, slug: string): SubstackItem => ({
  publicationId: pub,
  postId: slug,
  url: `https://${pub}.substack.com/p/${slug}`,
  title: slug,
});
const feeds: Record<string, SubstackItem[]> = { alpha: [], broken: [] };
const published: string[] = [];
let env: RestateTestEnvironment;
let server: ReturnType<typeof createDashboardServer>;
let base = "";
let ORIGIN = "";
beforeAll(async () => {
  env = await RestateTestEnvironment.start(
    {
      services: [
        discoveryPollObject({
          sources: ["alpha", "broken"],
          intervalMs: 60 * 60 * 1000,
          maxBackoffMs: 4 * 60 * 60 * 1000,
          coalesceMs: 1_000,
          fetchItems: async function* (key) {
            if (key === "broken") throw new TypeError("synthetic feed failure");
            yield* feeds[key]!;
          },
          publisher: {
            async publish(event: DiscoveryEvent) {
              if (!published.includes(event.id)) published.push(event.id);
            },
          },
        }),
      ],
      serviceEndpointAccess: "docker-host",
    },
    () => new RestateContainer("1.8.1"),
  );
  const ingress = clients.connect({ url: env.baseUrl() });
  const action = pollNowAction({
    sources: parsePollSources("substack:alpha,substack:broken,bogus:x,substack:Not Valid"),
    poll: (source: PollSource) =>
      ingress
        .objectClient<DiscoveryPollObject>({ name: "DiscoveryPoll" }, source.id)
        .poll({ reason: "manual" }),
  });
  const actions = {
    origin: "http://placeholder.invalid",
    routes: { "/articles/poll": action.submit },
  };
  server = createDashboardServer(
    [{ path: "/articles", title: "Articles", render: (url) => action.panel(url) }],
    actions,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ORIGIN = base;
  actions.origin = base;
}, 240_000);
afterAll(async () => {
  server?.close();
  await env?.stop();
});

const click = async (type = "substack", origin = ORIGIN) => {
  const res = await fetch(`${base}/articles/poll`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({ type, confirm: "yes" }).toString(),
  });
  return {
    res,
    page: res.headers.get("location")
      ? await (await fetch(`${base}${res.headers.get("location")}`)).text()
      : "",
  };
};

describe("Poll now on the Articles page (#824)", { timeout: 120_000 }, () => {
  it("offers one button per source type, and disables a type with no sources", async () => {
    const html = await (await fetch(`${base}/articles`)).text();
    expect(html).toContain("Poll substack now");
    expect(html).toContain("2 configured sources");
    expect(html).toMatch(/<button disabled>Poll telegram now<\/button>/);
  });

  it("discovers a new item, and reports each source including a partial failure", async () => {
    feeds.alpha = [item("alpha", "one")];
    const { res, page } = await click();
    expect(res.status).toBe(303);
    expect(published).toHaveLength(1);
    expect(page).toContain("Polled substack: 1 of 2 sources succeeded; 1 did not");
    expect(page).toMatch(/<code>alpha<\/code><\/td><td>complete<\/td><td>1<\/td><td>1<\/td>/);
    expect(page).toContain("source:TypeError");
  });

  it("does not duplicate discovery on repeated clicks, and finds the next new item", async () => {
    await new Promise((r) => setTimeout(r, 1_200));
    const before = published.length;
    const { page } = await click();
    const again = await click();
    expect(published).toHaveLength(before); // nothing new on the feed
    expect(again.page).toContain("already polled just now");
    expect(page).toMatch(/<code>alpha<\/code><\/td><td>complete<\/td><td>1<\/td><td>0<\/td>/);
    feeds.alpha = [item("alpha", "two"), ...feeds.alpha];
    await new Promise((r) => setTimeout(r, 1_200));
    await click();
    expect(published).toHaveLength(before + 1);
  });

  it("refuses a cross-origin click and an unknown type, and ignores tampered results", async () => {
    expect((await click("substack", "http://evil.test")).res.status).toBeGreaterThanOrEqual(400);
    expect((await click("fax")).res.headers.get("location")).toBe("/articles?poll-error=invalid");
    const forged = Buffer.from(JSON.stringify([{ id: "<script>", status: "complete" }])).toString(
      "base64url",
    );
    const html = await (await fetch(`${base}/articles?polled=substack&results=${forged}`)).text();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Polled substack");
  });
});
