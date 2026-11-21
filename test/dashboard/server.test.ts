import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDashboardServer, escapeHtml } from "../../src/dashboard/server.js";

let base: string;
const server = createDashboardServer([
  { path: "/overview", title: "Overview", render: () => "<p>ok</p>" },
  {
    path: "/articles",
    title: "Articles",
    render: () => `<p>${escapeHtml("<script>x</script>")}</p>`,
  },
  {
    path: "/broken",
    title: "Broken",
    render: () => {
      throw new Error("db at /secret/path unavailable");
    },
  },
]);
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("dashboard shell (#375)", () => {
  it("serves Overview and Articles with navigation and a no-script policy", async () => {
    const res = await fetch(`${base}/overview`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).not.toContain("script-src");
    const html = await res.text();
    expect(html).toContain('<a href="/overview" aria-current="page">Overview</a>');
    expect(html).toContain('<a href="/articles">Articles</a>');
    expect(html).not.toContain("<script");
  });

  it("redirects the root to the first view and reports health", async () => {
    const root = await fetch(`${base}/`, { redirect: "manual" });
    expect(root.status).toBe(303);
    expect(root.headers.get("location")).toBe("/overview");
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
  });

  it("escapes untrusted text and never echoes internal errors", async () => {
    expect(await (await fetch(`${base}/articles`)).text()).toContain(
      "&lt;script&gt;x&lt;/script&gt;",
    );
    const broken = await (await fetch(`${base}/broken`)).text();
    expect(broken).toContain("unavailable right now");
    expect(broken).not.toContain("/secret/path");
  });

  it("rejects mutations and unknown paths", async () => {
    const post = await fetch(`${base}/overview`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
