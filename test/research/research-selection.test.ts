import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { researchJobId, type ResearchRequest } from "../../src/research/job.js";
import {
  originalOrder,
  rankResearchRequests,
  saveResearchSelection,
} from "../../src/research/librarian.js";

let dir: string;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-selection-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await artifacts.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const theme = (id: string, n: number): ResearchRequest => ({
  schemaVersion: 1,
  origin: "theme",
  pass: 1,
  claims: Array.from({ length: n }, (_, i) => ({
    claimRecordId: `${id}-claim-${i}`,
    statement: `Claim ${i} about ${id}`,
    themeIds: [id],
  })),
  question: `Targeted enhancement of ${id}`,
  corpusRefs: [],
});

describe("research selection (#533)", () => {
  it("ranks the largest remaining gap first, deterministically, with rationale", () => {
    const requests = [theme("small", 1), theme("large", 4), theme("medium", 2)];
    const ranked = rankResearchRequests(requests);
    expect(ranked.map((r) => r.request.claims[0]!.themeIds[0])).toEqual([
      "large",
      "medium",
      "small",
    ]);
    expect(ranked[0]).toMatchObject({ rank: 1, claimsNeedingEvidence: 4 });
    expect(ranked[0]!.rationale).toMatch(/most claims/);
    // Input order never changes the selection: retries choose the same job.
    const shuffled = rankResearchRequests([requests[2]!, requests[0]!, requests[1]!]);
    expect(shuffled.map((r) => r.jobId)).toEqual(ranked.map((r) => r.jobId));
  });

  it("breaks ties on the stable job ID", () => {
    const a = theme("alpha", 2);
    const b = theme("beta", 2);
    const ranked = rankResearchRequests([a, b]);
    const expected = [researchJobId(a), researchJobId(b)].sort();
    expect(ranked.map((r) => r.jobId)).toEqual(expected);
  });

  it("creates zero candidates when saved coverage is sufficient", () => {
    expect(rankResearchRequests([])).toEqual([]);
  });

  it("saves the ranked candidates write-once for the analysis", async () => {
    const themeResult = await artifacts.write("theme-proposals/pub/p1/r.json", "{}");
    const claimResult = await artifacts.write("claim-extractions/pub/p1/r.json", "{}");
    const ranked = rankResearchRequests([theme("small", 1), theme("large", 3)]);
    const post = { publicationId: "pub", postId: "p1" };
    const ref = await saveResearchSelection(artifacts, post, themeResult, claimResult, ranked);
    const saved = JSON.parse(await artifacts.read(ref));
    expect(
      saved.candidates.map((c: { rank: number; claimsNeedingEvidence: number }) => [
        c.rank,
        c.claimsNeedingEvidence,
      ]),
    ).toEqual([
      [1, 3],
      [2, 1],
    ]);
    // A repeat keeps the first selection (write-once).
    const again = await saveResearchSelection(
      artifacts,
      post,
      themeResult,
      claimResult,
      ranked.slice().reverse(),
    );
    expect(again.sha256).toBe(ref.sha256);
  });

  it("keeps a separate record for a different candidate set of the same analysis", async () => {
    const themeResult = await artifacts.write("theme-proposals/pub/p1/r.json", "{}");
    const claimResult = await artifacts.write("claim-extractions/pub/p1/r.json", "{}");
    const post = { publicationId: "pub", postId: "p1" };
    const both = await saveResearchSelection(
      artifacts,
      post,
      themeResult,
      claimResult,
      rankResearchRequests([theme("small", 1), theme("large", 3)]),
    );
    const remaining = await saveResearchSelection(
      artifacts,
      post,
      themeResult,
      claimResult,
      rankResearchRequests([theme("small", 1)]),
    );
    expect(remaining.path).not.toBe(both.path);
    expect(JSON.parse(await artifacts.read(remaining)).candidates).toHaveLength(1);
  });

  it("keeps the original order for an analysis planned before ranking", () => {
    const requests = [theme("small", 1), theme("large", 4)];
    const kept = originalOrder(requests);
    expect(kept.map((r) => r.request)).toEqual(requests);
    expect(kept[0]!.rationale).toMatch(/before ranking/);
  });
});
