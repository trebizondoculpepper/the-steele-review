import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { buildArchiveBatch } from "../../src/corpus-refinement/archive-batch.js";

// Synthetic saved records only (#832).
let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "corpus-batch-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

async function seed(
  post: string,
  claims: { id: string; statement: string; passage: string; status: string }[],
  assessedAt: string,
) {
  const extraction = await content.write(
    `claim-extractions/${post}/x-${assessedAt.slice(0, 10)}.json`,
    JSON.stringify({
      claims: claims.map((c) => ({
        claimRecordId: c.id,
        claim: { statement: c.statement },
        occurrence: { passage: c.passage },
      })),
    }),
  );
  await content.write(
    `librarian/coverage/${post}/${assessedAt.slice(0, 10)}.json`,
    JSON.stringify({
      claimResult: {
        repository: extraction.repository,
        commit: extraction.commit,
        path: extraction.path,
        hash: `sha256:${extraction.sha256}`,
      },
      assessedAt,
      claims: claims.map((c) => ({ claimRecordId: c.id, status: c.status })),
    }),
  );
}

describe("reproducible archive batch (#832)", () => {
  it("uses the latest coverage record per post, in order, within the budgets, recording deferrals", async () => {
    // An older record for pub/a, superseded by the later one.
    await seed(
      "pub/a",
      [{ id: "old", statement: "Old", passage: "old", status: "gap" }],
      "2026-11-01T00:00:00Z",
    );
    await seed(
      "pub/a",
      [
        {
          id: "a1",
          statement: "Masts make people ill.",
          passage: "the mast is making us ill",
          status: "covered",
        },
        {
          id: "a2",
          statement: "5G spreads viruses.",
          passage: "5G spreads the virus",
          status: "gap",
        },
      ],
      "2026-11-20T00:00:00Z",
    );
    await seed(
      "pub/b",
      [
        {
          id: "b1",
          statement: "Towers cause sickness.",
          passage: "towers make people sick",
          status: "pending",
        },
        { id: "b2", statement: "Meters spy on homes.", passage: "meters spy", status: "gap" },
      ],
      "2026-11-21T00:00:00Z",
    );
    const batch = await buildArchiveBatch(content, {
      runId: "exp-1",
      posts: ["pub/a", "pub/b", "pub/none"],
      maxClaims: 3,
      maxChars: 10_000,
    });
    expect(batch.input.mode).toBe("archive");
    expect(batch.input.claims.map((c) => [c.id, c.covered, c.post])).toEqual([
      ["a1", true, "pub/a"],
      ["a2", false, "pub/a"],
      ["b1", false, "pub/b"],
    ]);
    expect(batch.input.claims[0]!.utterance).toBe("the mast is making us ill");
    expect(batch.input.deferred).toEqual(["b2"]);
    expect(batch.missing).toEqual(["pub/none"]);
    expect(batch.sources.map((s) => s.post)).toEqual(["pub/a", "pub/b"]);
    // The same inputs give the same batch.
    const again = await buildArchiveBatch(content, {
      runId: "exp-1",
      posts: ["pub/a", "pub/b", "pub/none"],
      maxClaims: 3,
      maxChars: 10_000,
    });
    expect(again.input).toEqual(batch.input);
  });
});
