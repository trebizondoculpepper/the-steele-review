import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { researchJobPath } from "../../src/research/job.js";
import {
  selectAndSaveResearch,
  selectResearch,
  type SelectionCandidate,
} from "../../src/research/research-allowance.js";

// Synthetic job IDs only; no provider is reachable from these tests.
const job = (n: number) => `research-${String(n).padStart(32, "0")}`;
const ranked = (...ids: string[]): SelectionCandidate[] =>
  ids.map((jobId, i) => ({ jobId, rank: i + 1 }));
const none = new Set<string>();

describe("research selection under a new-job allowance (#596)", () => {
  it("reuse is free: a reusable first job and two new jobs fit two; a third is deferred", () => {
    const out = selectResearch(ranked(job(1), job(2), job(3), job(4)), {
      allowance: 2,
      reusable: new Set([job(1)]),
      counted: none,
    });
    expect(out.decisions.map((d) => [d.jobId, d.decision])).toEqual([
      [job(1), "reuse"],
      [job(2), "new"],
      [job(3), "new"],
      [job(4), "deferred"],
    ]);
    expect(out.newJobs).toBe(2);
  });

  it("an allowance of zero commissions nothing new but still reuses", () => {
    const out = selectResearch(ranked(job(1), job(2)), {
      allowance: 0,
      reusable: new Set([job(2)]),
      counted: none,
    });
    expect(out.decisions.map((d) => d.decision)).toEqual(["deferred", "reuse"]);
    expect(out.decisions[0]!.reason).toMatch(/allowance of 0/);
  });

  it("is deterministic in rank order with job ID tie-breaks, and drops duplicates", () => {
    const input = [
      { jobId: job(3), rank: 2 },
      { jobId: job(2), rank: 1 },
      { jobId: job(1), rank: 2 },
      { jobId: job(2), rank: 3 },
    ];
    const a = selectResearch(input, { allowance: 2, reusable: none, counted: none });
    const b = selectResearch([...input].reverse(), {
      allowance: 2,
      reusable: none,
      counted: none,
    });
    expect(a).toEqual(b);
    expect(a.decisions.map((d) => [d.jobId, d.decision])).toEqual([
      [job(2), "new"],
      [job(1), "new"],
      [job(3), "deferred"],
      [job(2), "duplicate"],
    ]);
  });

  it("shares the allowance across rounds: earlier new jobs count once and are not re-spent", () => {
    const out = selectResearch(ranked(job(1), job(5), job(6)), {
      allowance: 2,
      reusable: none,
      // Round one commissioned job 1 and job 9 (still running / elsewhere).
      counted: new Set([job(1), job(9)]),
    });
    expect(out.remainingBefore).toBe(0);
    expect(out.decisions.map((d) => d.decision)).toEqual(["in-flight", "deferred", "deferred"]);
  });
});

describe("saved selection (#596)", () => {
  let dir: string;
  let content: GitArtifactStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "steele-allowance-"));
    content = new GitArtifactStore({ repoPath: dir, repository: "content" });
    await content.initialise();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const post = { publicationId: "pub", postId: "p1" };
  const ref = async (path: string) => (await content.lookup(path)) ?? content.write(path, path);

  it("replays its own decision and carries spending into the next round", async () => {
    // Job 1 already has a saved result: reusable at no cost.
    await content.write(researchJobPath(job(1), "result"), "{}");
    const themeResult = await ref("themes/pub/p1/t.json");
    const claimResult = await ref("claims/pub/p1/c.json");
    const first = {
      post,
      themeResult,
      claimResult,
      candidates: ranked(job(1), job(2), job(3), job(4)),
      allowance: 2,
    };
    const round1 = await selectAndSaveResearch(content, first);
    expect(round1.record.decisions.map((d) => d.decision)).toEqual([
      "reuse",
      "new",
      "new",
      "deferred",
    ]);
    // A replay of the same selection returns the saved decision, not a
    // fresh one that would see its own jobs as already spent.
    const replay = await selectAndSaveResearch(content, first);
    expect(replay.ref).toEqual(round1.ref);
    expect(replay.record).toEqual(round1.record);

    // A follow-up round for the same article (new claim analysis).
    const round2 = await selectAndSaveResearch(content, {
      ...first,
      claimResult: await ref("claims/pub/p1/c2.json"),
      candidates: ranked(job(4), job(2)),
    });
    expect(round2.record.remainingBefore).toBe(0);
    expect(round2.record.decisions.map((d) => [d.jobId, d.decision])).toEqual([
      [job(4), "deferred"],
      [job(2), "in-flight"],
    ]);

    // Another article has its own allowance.
    const other = await selectAndSaveResearch(content, {
      ...first,
      post: { publicationId: "pub", postId: "p2" },
      candidates: ranked(job(4)),
    });
    expect(other.record.decisions[0]!.decision).toBe("new");
  });
});
