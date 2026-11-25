import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { corpusRefinementSubmitter } from "../../src/corpus-refinement/submission.js";
import { corpusRefinementWorkflow } from "../../src/corpus-refinement/workflow.js";
import { corpusRefinementAction } from "../../src/dashboard/corpus-refinement.js";
import { restateUiLinks } from "../../src/dashboard/restate-links.js";
import { createDashboardServer } from "../../src/dashboard/server.js";

// Fixture mode only: no model calls, an isolated repository (#831).
let ORIGIN = "";
let dir: string;
let env: RestateTestEnvironment;
let base: string;
let server: ReturnType<typeof createDashboardServer>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "corpus-dashboard-"));
  const artifacts = new GitArtifactStore({ repoPath: dir, repository: "corpus-test" });
  await artifacts.initialise();
  env = await RestateTestEnvironment.start(
    { services: [corpusRefinementWorkflow({ artifacts })], serviceEndpointAccess: "docker-host" },
    () => new RestateContainer("1.8.1"),
  );
  const action = corpusRefinementAction({
    submitter: corpusRefinementSubmitter(env.baseUrl()),
    // Synthetic console address only.
    links: restateUiLinks("http://console.example.test/ui")!,
  });
  // The action check requires Origin and Host to match the configured origin,
  // known only once the server listens.
  const actions = {
    origin: "http://placeholder.invalid",
    routes: { "/corpus-refinement/run": action.submit },
  };
  server = createDashboardServer([action.view], actions);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ORIGIN = base;
  actions.origin = base;
}, 240_000);
afterAll(async () => {
  server?.close();
  await env?.stop();
  await rm(dir, { recursive: true, force: true });
});

const post = (fields: Record<string, string>, origin = ORIGIN) =>
  fetch(`${base}/corpus-refinement/run`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams(fields).toString(),
  });
const page = async (location: string) => (await fetch(`${base}${location}`)).text();

describe("Run Corpus Refinement from the dashboard (#831)", { timeout: 120_000 }, () => {
  it("offers the fixture-mode form", async () => {
    const html = await page("/corpus-refinement");
    expect(html).toContain('action="/corpus-refinement/run"');
    expect(html).toContain("fixture");
  });

  it("refuses a cross-origin submission through the existing action check", async () => {
    const res = await post({ run: "cross-origin", size: "3", confirm: "yes" }, "http://evil.test");
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("submits once, shows the invocation and its progress link, and attaches on resubmission", async () => {
    const first = await post({ run: "dash-run", size: "4", confirm: "yes" });
    expect(first.status).toBe(303);
    const firstLocation = first.headers.get("location")!;
    const firstQuery = new URL(firstLocation, base).searchParams;
    expect(firstQuery.get("submitted")).toBe("started");
    const invocation = firstQuery.get("invocation")!;
    expect(invocation).toMatch(/^inv_/);
    const html = await page(firstLocation);
    expect(html).toContain(invocation);
    expect(html).toContain(`href="http://console.example.test/ui/invocations/${invocation}"`);

    const again = await post({ run: "dash-run", size: "4", confirm: "yes" });
    const againQuery = new URL(again.headers.get("location")!, base).searchParams;
    expect(againQuery.get("submitted")).toBe("already-submitted");
    expect(againQuery.get("invocation")).toBe(invocation);
    expect(await page(again.headers.get("location")!)).toContain("attached to the existing run");
  });

  it("reports an invalid run ID without submitting anything", async () => {
    const res = await post({ run: "Not Valid!", size: "4", confirm: "yes" });
    expect(new URL(res.headers.get("location")!, base).searchParams.get("error")).toBe("invalid");
    const oversized = await post({ run: "too-big", size: "999", confirm: "yes" });
    expect(new URL(oversized.headers.get("location")!, base).searchParams.get("error")).toBe(
      "invalid",
    );
  });
});
