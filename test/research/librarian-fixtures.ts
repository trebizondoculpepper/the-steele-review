import { proposeThemes } from "../../src/analysis/theme-proposals.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import type { ArtifactRef, GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { researchJobId, type ResearchRequest } from "../../src/research/job.js";
import type { Commission } from "../../src/research/librarian.js";

/** Shared librarian fixtures: a saved analysis and a researcher stand-in over one store. */
export const TEXT = "A treaty bans weather weapons. They paid 56 million for the attack.";
export const SHARED = "https://treaties.un.org/enmod";
export const CLAIMS = [
  { id: "claim-treaty", statement: "A treaty prohibits hostile environmental modification" },
  { id: "claim-payment", statement: "A payment of 56 million funded an attack" },
];

export function librarianFixtures(artifacts: GitArtifactStore) {
  /** Write once; a job re-commissioned with the same ID reuses what it saved, like the real researcher. */
  const put = async (path: string, content: string) => {
    try {
      return await artifacts.write(path, content);
    } catch {
      const existing = await artifacts.lookup(path);
      if (!existing) throw new Error(`could not write ${path}`);
      return existing;
    }
  };
  async function analysis(
    postId: string,
    claims: { id: string; statement: string }[],
    title = "Weather warfare",
  ) {
    const post = { publicationId: "pub", postId };
    await proposeThemes({
      provider: {
        modelVersion: "fake/m",
        complete: async () =>
          JSON.stringify({
            themes: [{ title, description: "Claims of weather modification as a weapon" }],
          }),
      },
      artifacts,
      post,
      source: {
        text: TEXT,
        sourceVersion: sourceVersionFor(TEXT),
        artifact: {
          repository: "archive",
          commit: "a".repeat(40),
          path: `substack/pub/${postId}/collected.json`,
          hash: `sha256:${"b".repeat(64)}`,
        },
      },
    });
    const [themePath] = await artifacts.list(`theme-proposals/pub/${postId}`, 10);
    const themeResult = (await artifacts.lookup(themePath))!;
    const proposalId = JSON.parse(await artifacts.read(themeResult)).proposals[0].id as string;
    const claimResult = await artifacts.write(
      `claim-extractions/pub/${postId}/r.json`,
      JSON.stringify({
        schemaVersion: 2,
        post,
        sourceVersion: sourceVersionFor(TEXT),
        themeIds: [proposalId],
        themeResult: `${themeResult.commit}:${themeResult.path}`,
        claims: claims.map((c) => ({
          claim: { statement: c.statement },
          occurrence: {},
          kind: "assertion",
          themeIds: [proposalId],
          classification: "themed",
          claimRecordId: c.id,
        })),
        candidates: [],
        rejected: [],
        extraction: { modelVersion: "m", promptVersion: "p", extractedAt: "2026-01-01T00:00:00Z" },
      }),
    );
    return { themeResult, claimResult };
  }

  const ref = (r: ArtifactRef) => ({
    repository: r.repository,
    commit: r.commit,
    path: r.path,
    hash: `sha256:${r.sha256}`,
  });

  /** A researcher stand-in: saves a manifest/result per request and records calls. */
  function researcher(
    plan: (
      req: ResearchRequest,
    ) =>
      | "busy"
      | "failed"
      | { passages: { claimRecordId: string; url: string; monitored?: boolean }[] },
  ) {
    const requests: ResearchRequest[] = [];
    const commission: Commission = async (request) => {
      requests.push(request);
      const jobId = researchJobId(request);
      const outcome = plan(request);
      if (outcome === "busy") return { jobId, status: "busy" };
      if (outcome === "failed") {
        const result = {
          schemaVersion: 1 as const,
          jobId,
          outcome: "failed" as const,
          failure: "provider-error" as const,
          finishedAt: "2026-01-01T00:00:00Z",
        };
        const resultRef = await put(
          `research-jobs/${jobId}/result.json`,
          JSON.stringify(result),
        );
        return { jobId, status: "finished", result, resultRef };
      }
      const report = await put(`research-jobs/${jobId}/report.md`, "# report\n");
      const urls = [...new Set(outcome.passages.map((p) => p.url))];
      const manifest = await put(
        `research-jobs/${jobId}/manifest.json`,
        JSON.stringify({
          schemaVersion: 1,
          jobId,
          report: ref(report),
          citations: urls.map((url) => ({
            url,
            retrieval: "archived",
            ...(outcome.passages.find((p) => p.url === url)?.monitored
              ? { sourceType: "monitored-source", support: "unverified" }
              : { support: "supported" }),
            passages: outcome.passages
              .filter((p) => p.url === url)
              .map((p) => ({
                claimRecordId: p.claimRecordId,
                passage: `Article I text for ${p.claimRecordId}`,
              })),
          })),
          gaps: [],
          provider: { model: "fixture" },
        }),
      );
      const result = {
        schemaVersion: 1 as const,
        jobId,
        outcome: "complete-with-gaps" as const,
        manifest: ref(manifest),
        finishedAt: "2026-01-01T00:00:00Z",
      };
      const resultRef = await put(
        `research-jobs/${jobId}/result.json`,
        JSON.stringify(result),
      );
      return { jobId, status: "finished", result, resultRef };
    };
    return { commission, requests };
  }
  return { analysis, researcher };
}
