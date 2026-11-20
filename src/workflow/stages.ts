import type { ExtractionModelProvider } from "../analysis/extraction.js";
import { extractGroundedClaims } from "../analysis/grounded-claims.js";
import { parseThemeProposalResult, proposeThemes } from "../analysis/theme-proposals.js";
import { collectionArtifactPath, CollectionRecordSchema } from "../collection/collection-store.js";
import { transcriptTimingsFor } from "../content/embedding-consumer.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { draftFromPackage } from "../drafting/package-draft.js";
import { saveWriterPackage } from "../drafting/writer-package.js";
import type { PageFetcher } from "../research/gap-research.js";
import { researchJobId, type ResearchRequest } from "../research/job.js";
import {
  assessPostCoverage,
  type CommissionedJob,
  type ThemeShortlister,
} from "../research/librarian.js";
import { runResearchJob, type SupportJudge } from "../research/runner.js";
import type { SonarClient } from "../research/sonar.js";
import { StageError, type ArticleStages, type PinnedResearch, type Ref } from "./article-run.js";

/**
 * The real stages for an unattended article run (#243), composed from the
 * delivered modules through their normal interfaces. Each stage is idempotent
 * for the same inputs: theme and claim results, research jobs, coverage
 * records, packages and drafts are content-addressed or reuse saved results.
 */

const plain = (r: ArtifactRef): Ref => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  sha256: r.sha256,
});

export function articleStages(deps: {
  archive: GitArtifactStore;
  content: GitArtifactStore;
  operations: OperationStore;
  /** Per-stage model choices (configured; OpenRouter for live runs). */
  models: {
    themes: ExtractionModelProvider;
    claims: ExtractionModelProvider;
    writer: ExtractionModelProvider;
  };
  shortlister: ThemeShortlister;
  research: {
    sonar: SonarClient;
    fetcher: PageFetcher;
    judge?: SupportJudge;
    monitoredHosts?: string[];
  };
  owner: string;
}): ArticleStages {
  const loadSource = async (post: { publicationId: string; postId: string }) => {
    const ref = await deps.archive.lookup(collectionArtifactPath(post));
    if (!ref) throw new StageError("source", "not-captured");
    const record = CollectionRecordSchema.parse(JSON.parse(await deps.archive.read(ref)));
    if (!record.complete) throw new StageError("source", "incomplete-capture");
    return { ref, record, sourceVersion: sourceVersionFor(record.text) };
  };

  // Planning captures the librarian's requests without commissioning research.
  const planned = async (themes: Ref, claims: Ref): Promise<ResearchRequest[]> => {
    const requests: ResearchRequest[] = [];
    await assessPostCoverage({
      artifacts: deps.content,
      themeResult: themes,
      claimResult: claims,
      shortlister: deps.shortlister,
      commission: async (request) => {
        requests.push(request);
        return { jobId: "planning", status: "busy" };
      },
    });
    return requests;
  };

  return {
    async themes(post) {
      const { ref, record, sourceVersion } = await loadSource(post);
      if (sourceVersion !== post.sourceVersion)
        throw new StageError("themes", "source-version-changed");
      const out = await proposeThemes({
        provider: deps.models.themes,
        artifacts: deps.content,
        post: { publicationId: post.publicationId, postId: post.postId },
        source: {
          text: record.text,
          sourceVersion,
          artifact: {
            repository: ref.repository,
            commit: ref.commit,
            path: ref.path,
            hash: `sha256:${ref.sha256}`,
          },
        },
      });
      if (out.status !== "proposed") {
        // A provider failure may be transient (bounded retry); the rest are permanent.
        if (out.reason === "provider-failed") throw new Error("themes: provider-failed");
        throw new StageError("themes", out.reason);
      }
      return plain(out.ref);
    },

    async claims(post, themes) {
      const { ref, record, sourceVersion } = await loadSource(post);
      const themeResult = parseThemeProposalResult(JSON.parse(await deps.content.read(themes)));
      const out = await extractGroundedClaims({
        provider: deps.models.claims,
        artifacts: deps.content,
        themes: themeResult.proposals.map((p) => ({
          id: p.id,
          name: p.title,
          definition: p.description ?? p.title,
        })),
        themeResult: `${themes.commit}:${themes.path}`,
        source: {
          text: record.text,
          sourceVersion,
          artifact: {
            repository: ref.repository,
            commit: ref.commit,
            path: ref.path,
            hash: `sha256:${ref.sha256}`,
          },
          publicationId: post.publicationId,
          postId: post.postId,
          url: record.item.url,
          ...(record.item.publishedAt ? { publishedAt: record.item.publishedAt } : {}),
          ...transcriptTimingsFor(record),
        },
      });
      if (out.status !== "extracted") {
        if (out.reason === "provider-failed") throw new Error("claims: provider-failed");
        throw new StageError("claims", out.reason);
      }
      return plain(out.recordRef);
    },

    planResearch: (themes, claims) => planned(themes, claims),

    async research(request): Promise<CommissionedJob> {
      const out = await runResearchJob({
        artifacts: deps.content,
        operations: deps.operations,
        request,
        owner: deps.owner,
        sonar: deps.research.sonar,
        fetcher: deps.research.fetcher,
        ...(deps.research.judge ? { judge: deps.research.judge } : {}),
        ...(deps.research.monitoredHosts ? { monitoredHosts: deps.research.monitoredHosts } : {}),
      });
      if (out.status === "busy") return { jobId: out.jobId, status: "busy" };
      const resultRef = await deps.content.lookup(`research-jobs/${out.jobId}/result.json`);
      return {
        jobId: out.jobId,
        status: "finished",
        result: out.result,
        ...(resultRef ? { resultRef } : {}),
      };
    },

    async coverage(themes, claims, pinned: PinnedResearch[]) {
      // Exactly the results pinned at the deadline; nothing later.
      const byJob = new Map(pinned.map((p) => [p.jobId, p]));
      const out = await assessPostCoverage({
        artifacts: deps.content,
        themeResult: themes,
        claimResult: claims,
        shortlister: deps.shortlister,
        commission: async (request) => {
          const jobId = researchJobId(request);
          const p = byJob.get(jobId);
          if (p?.outcome === "finished") return p.job;
          // Timed out, failed, or not part of the pinned batch: an explicit gap.
          return {
            jobId,
            status: "finished",
            result: {
              schemaVersion: 1,
              jobId,
              outcome: "failed",
              failure: p?.outcome === "timed-out" || !p ? "timeout" : "provider-error",
              finishedAt: new Date(0).toISOString(),
            },
          };
        },
      });
      return plain(out.ref);
    },

    async package(coverage) {
      const { package: pkg, ref } = await saveWriterPackage({
        content: deps.content,
        archive: deps.archive,
        coverage,
      });
      return { ref: plain(ref), status: pkg.status };
    },

    async draft(pkg, sourceUrl) {
      const out = await draftFromPackage({
        content: deps.content,
        archive: deps.archive,
        package: pkg,
        provider: deps.models.writer,
        sourceUrl,
      });
      if (out.status === "drafted") return { ref: plain(out.draft) };
      return { failure: out.status === "failed" ? out.reason : out.status };
    },

    // Verifying a package draft is #150; until it lands the run reports
    // "drafted-unverified" rather than claiming an approval.
    async verify() {
      return { approved: false, unavailable: "package-draft verifier not yet implemented (#150)" };
    },
  };
}
