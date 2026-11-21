import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { type ArtifactRef, GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { CoverageRecordSchema } from "../../src/research/librarian.js";
import { SavedEvidenceError, selectSavedEvidence } from "../../src/research/saved-evidence.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-saved-evidence-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const URL_A = "https://example.org/radio-waves";
const toRef = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

/** A finished job that archived one source, and coverage that left both claims as gaps. */
async function fixture(outcome = "complete-with-gaps") {
  const snapshot = await content.write(
    "research-jobs/job-1/sources/a.json",
    JSON.stringify({
      url: URL_A,
      title: "Radio waves",
      truncated: false,
      text: "Intro.\nRadio waves do not have enough\n energy to damage DNA. More text.",
    }),
  );
  const manifest = await content.write(
    "research-jobs/job-1/manifest.json",
    JSON.stringify({
      schemaVersion: 1,
      jobId: "job-1",
      citations: [{ url: URL_A, retrieval: "archived", archivedArtifact: toRef(snapshot) }],
    }),
  );
  const any = toRef(snapshot);
  const coverage = await content.write(
    "librarian/coverage/pub/p1/original.json",
    JSON.stringify(
      CoverageRecordSchema.parse({
        schemaVersion: 1,
        post: { publicationId: "pub", postId: "p1" },
        source: any,
        themeResult: any,
        claimResult: any,
        mappings: [],
        claims: ["claim-a", "claim-b"].map((id) => ({
          claimRecordId: id,
          statement: `statement ${id}`,
          dossierId: "d1",
          status: "no-independent-evidence",
          reused: false,
          jobIds: ["job-1"],
          citations: [],
          reason: "no independent supporting source was found after a search",
        })),
        jobs: [{ jobId: "job-1", dossierId: "d1", pass: 1, outcome, manifest: toRef(manifest) }],
        dossiers: [],
        assessedAt: "2026-11-21T00:00:00.000Z",
      }),
    ),
  );
  return coverage;
}

const select = (coverage: ArtifactRef, overrides: Record<string, string> = {}) =>
  selectSavedEvidence({
    content,
    coverage,
    claimRecordId: "claim-a",
    jobId: "job-1",
    url: URL_A,
    passage: "Radio waves do not have enough energy to damage DNA.",
    note: "selected for #261",
    ...overrides,
  });

describe("selectSavedEvidence (#261)", () => {
  it("covers one claim with a verbatim archived passage and leaves other gaps alone", async () => {
    const { record, ref } = await select(await fixture());
    expect(ref.path).toMatch(/^librarian\/coverage\/pub\/p1\/[0-9a-f]{32}\.json$/);
    const [a, b] = record.claims;
    expect(a).toMatchObject({
      status: "evidence-found",
      citations: [{ url: URL_A, passage: "Radio waves do not have enough energy to damage DNA." }],
    });
    expect(a!.reason).toContain("hand-selected from saved research job-1");
    expect(b).toMatchObject({ status: "no-independent-evidence", citations: [] });
    // Stored and schema-valid; rerunning reuses the same record.
    expect(
      (
        await select(
          await content.lookup("librarian/coverage/pub/p1/original.json").then((r) => r!),
        )
      ).ref.path,
    ).toBe(ref.path);
  });

  it("refuses passages, URLs, jobs and claims the saved research does not hold", async () => {
    const coverage = await fixture();
    const code = (p: Promise<unknown>) =>
      p.then(
        () => "accepted",
        (e: unknown) => (e instanceof SavedEvidenceError ? e.code : String(e)),
      );
    expect(
      await code(select(coverage, { passage: "Radio waves are perfectly safe at any power." })),
    ).toBe("passage-not-in-snapshot");
    expect(await code(select(coverage, { url: "https://example.org/other" }))).toBe(
      "citation-not-archived",
    );
    expect(await code(select(coverage, { jobId: "job-2" }))).toBe("unknown-job");
    expect(await code(select(coverage, { claimRecordId: "claim-z" }))).toBe("unknown-claim");
    expect(await code(select(await fixtureFailed()))).toBe("job-not-finished");
  });
});

async function fixtureFailed() {
  await rm(dir, { recursive: true, force: true });
  dir = await mkdtemp(join(tmpdir(), "steele-saved-evidence-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  return fixture("failed");
}
