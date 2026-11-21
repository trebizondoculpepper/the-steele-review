import { describe, expect, it } from "vite-plus/test";
import { githubBuilds, portainerDashboardStack } from "../../src/controllers/dashboard-deploy.js";
import {
  updateDashboard,
  type Build,
  type UpdateState,
} from "../../src/deploy/dashboard-update.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const REPO = "ghcr.io/example/app";
const img = (c: string) => `${REPO}@sha256:${c[0]!.repeat(64)}`;

/** Synthetic history: A <- B <- C. */
const order = [A, B, C];

function harness(opts: {
  build?: Partial<Build>;
  live?: string;
  ready?: boolean[];
  state?: UpdateState;
}) {
  const calls: string[] = [];
  let live = opts.live ?? img(A);
  const ready = [...(opts.ready ?? [true])];
  const state: UpdateState = opts.state ?? { deployed: { commit: A, image: img(A), at: "t0" } };
  const run = () =>
    updateDashboard({
      imageRepository: REPO,
      state,
      now: () => new Date("2026-11-21T00:00:00Z"),
      builds: {
        latestMainBuild: async () => ({
          runId: 1,
          commit: B,
          conclusion: "success",
          branch: "main",
          event: "push",
          ...opts.build,
        }),
        isStrictlyNewer: async (older, newer) => order.indexOf(newer) > order.indexOf(older),
      },
      registry: { digestFor: async (c) => `sha256:${c[0]!.repeat(64)}` },
      stack: {
        currentImage: async () => live,
        pull: async (i) => void calls.push(`pull ${i}`),
        setImage: async (i) => {
          calls.push(`set ${i}`);
          live = i;
        },
      },
      readiness: { ready: async () => ready.shift() ?? false },
    });
  return { run, calls, live: () => live };
}

describe("dashboard auto-update (#476)", () => {
  it("deploys a newer successful main build, pinned by digest", async () => {
    const h = harness({});
    const { result, state } = await h.run();
    expect(result).toEqual({ outcome: "deployed", commit: B, image: img(B) });
    expect(h.calls).toEqual([`pull ${img(B)}`, `set ${img(B)}`]);
    expect(state.deployed).toMatchObject({ commit: B, image: img(B) });
  });

  it("ignores failed, non-main, duplicate and older builds", async () => {
    for (const [build, reason] of [
      [{ conclusion: "failure" }, "no-trusted-build"],
      [{ branch: "feature" }, "no-trusted-build"],
      [{ event: "pull_request" }, "no-trusted-build"],
      [{ commit: A }, "already-deployed"],
    ] as const) {
      const h = harness({ build });
      expect((await h.run()).result).toMatchObject({ outcome: "skipped", reason });
      expect(h.calls).toEqual([]);
    }
    // An out-of-order notification for an older commit never downgrades.
    const older = harness({
      build: { commit: A },
      live: img(C),
      state: { deployed: { commit: C, image: img(C), at: "t" } },
    });
    expect((await older.run()).result).toMatchObject({ reason: "not-newer" });
    expect(older.calls).toEqual([]);
    const stale = harness({
      build: { commit: B },
      live: img(C),
      state: { deployed: { commit: C, image: img(C), at: "t" } },
    });
    expect((await stale.run()).result).toMatchObject({ reason: "not-newer" });
    expect(stale.calls).toEqual([]);
  });

  it("refuses to act without a baseline or after a manual change", async () => {
    expect((await harness({ state: {} }).run()).result).toMatchObject({
      reason: "baseline-unknown",
    });
    const drift = harness({ live: img(C) });
    expect((await drift.run()).result).toMatchObject({ reason: "drift" });
    expect(drift.calls).toEqual([]);
  });

  it("rolls back once on failed readiness and does not retry that commit", async () => {
    const h = harness({ ready: [false, true] });
    const { result, state } = await h.run();
    expect(result).toEqual({ outcome: "rolled-back", commit: B, image: img(B), restored: img(A) });
    expect(h.live()).toBe(img(A));
    expect(state).toMatchObject({ deployed: { commit: A }, failed: { commit: B } });
    const again = harness({ state });
    expect((await again.run()).result).toMatchObject({ reason: "failed-previously" });
    expect(again.calls).toEqual([]);
    // A rollback that also fails is reported, and the drift guard stops any loop.
    const worse = harness({ ready: [false, false] });
    const out = await worse.run();
    expect(out.result.outcome).toBe("rollback-failed");
  });

  it("Portainer adapter changes only the image variable and never re-pulls the stack", async () => {
    const requests: { url: string; body?: unknown }[] = [];
    const env = [
      { name: "STEELE_IMAGE", value: "worker@sha256:1" },
      { name: "STEELE_DASHBOARD_IMAGE", value: img(A) },
      { name: "PRIVATE", value: "kept" },
    ];
    const fake = (async (url: string, init?: RequestInit) => {
      requests.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.endsWith("/api/stacks/7")) return Response.json({ EndpointId: 3, Env: env });
      if (url.endsWith("/api/stacks/7/file"))
        return Response.json({ StackFileContent: "services: {}\n" });
      return Response.json({});
    }) as typeof fetch;
    const stack = portainerDashboardStack({
      url: "http://portainer.invalid",
      apiKey: "k",
      stackId: 7,
      imageVariable: "STEELE_DASHBOARD_IMAGE",
      fetch: fake,
    });
    await stack.setImage(img(B));
    const put = requests.find((r) => r.url.includes("?endpointId=3"))!.body as {
      env: { name: string; value: string }[];
      stackFileContent: string;
      pullImage: boolean;
      prune: boolean;
    };
    expect(put.pullImage).toBe(false);
    expect(put.prune).toBe(false);
    expect(put.stackFileContent).toBe("services: {}\n");
    expect(put.env).toEqual([env[0], { name: "STEELE_DASHBOARD_IMAGE", value: img(B) }, env[2]]);
  });

  it("GitHub adapter treats only 'ahead' as newer", async () => {
    for (const [status, newer] of [
      ["ahead", true],
      ["behind", false],
      ["identical", false],
      ["diverged", false],
    ] as const) {
      const builds = githubBuilds({
        repository: "example/app",
        workflowFile: "container-image.yml",
        fetch: (async () => Response.json({ status })) as typeof fetch,
      });
      expect(await builds.isStrictlyNewer(A, B)).toBe(newer);
    }
  });
});
