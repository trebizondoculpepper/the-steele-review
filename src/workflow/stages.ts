import { postAttribution, type ParsedSourceMetadata } from "../content/source-metadata.js";
import type { MechanicalPolicy } from "../drafting/mechanical-policy.js";
import type { ExtractionModelProvider } from "../analysis/extraction.js";
import { extractGroundedClaims } from "../analysis/grounded-claims.js";
import { parseThemeProposalResult, proposeThemes } from "../analysis/theme-proposals.js";
import { collectionArtifactPath, CollectionRecordSchema } from "../collection/collection-store.js";
import { transcriptTimingsFor } from "../content/embedding-consumer.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { draftFromPackage } from "../drafting/package-draft.js";
import { verifyWithRevisions } from "../drafting/package-verify.js";
import {
  saveSpeakerComparisons,
  type SpeakerComparisonDeps,
} from "../drafting/speaker-comparisons.js";
import { saveWriterPackage } from "../drafting/writer-package.js";
import type { PageFetcher } from "../research/gap-research.js";
import { researchJobId, type ResearchRequest } from "../research/job.js";
import {
  assessPostCoverage,
  CoverageRecordSchema,
  type CommissionedJob,
  type ThemeShortlister,
} from "../research/librarian.js";
import { runResearchJob, type SupportJudge } from "../research/runner.js";
import type { SonarClient } from "../research/sonar.js";
import { CREDIT_EXHAUSTED } from "../observability/provider-condition.js";
import { recordApproval } from "../publishing/approved-article.js";
import {
  StageError,
  type ArticleRunInput,
  type ArticleStages,
  type PinnedResearch,
  type Ref,
} from "./article-run.js";

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
  mechanicalPolicy?: MechanicalPolicy;
  archive: GitArtifactStore;
  content: GitArtifactStore;
  operations: OperationStore;
  /** Per-stage model choices (configured; OpenRouter for live runs). */
  models: {
    themes: ExtractionModelProvider;
    claims: ExtractionModelProvider;
    writer: ExtractionModelProvider;
    /** Independent verifier stage (#150); without it runs end drafted-unverified. */
    verifier?: ExtractionModelProvider;
  };
  shortlister: ThemeShortlister;
  research: {
    sonar: SonarClient;
    fetcher: PageFetcher;
    judge?: SupportJudge;
    monitoredHosts?: string[];
  };
  /**
   * Same-speaker history for the essay (#370). Optional: without it, or when
   * nothing is found, the article simply has no historical section.
   */
  history?: SpeakerComparisonDeps;
  /** Configured source attribution (#482); absent keeps legacy behaviour. */
  sourceMetadata?: ParsedSourceMetadata;
  owner: string;
}): ArticleStages {
  const loadSource = async (post: ArticleRunInput) => {
    // A run started from a captured-content event reads exactly that archived
    // revision (hash-verified); a Substack replay looks up the current capture.
    const ref: ArtifactRef | undefined = post.source
      ? post.source.artifact
      : await deps.archive.lookup(collectionArtifactPath(post));
    if (!ref) throw new StageError("source", "not-captured");
    let raw: string;
    try {
      raw = await deps.archive.read(ref);
    } catch (error) {
      // A missing or altered capture is permanent; other read failures retry.
      if (
        error instanceof ArtifactStoreError &&
        (error.code === "not-found" || error.code === "hash-mismatch")
      )
        throw new StageError("source", "capture-unavailable");
      throw error;
    }
    const parsed = CollectionRecordSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new StageError("source", "unsupported-capture-format");
    const record = parsed.data;
    // Hash verification authenticates the bytes, not the identity: a caller
    // supplied reference could point at a valid capture of a different post.
    if (record.item.publicationId !== post.publicationId || record.item.postId !== post.postId)
      throw new StageError("source", "capture-identity-mismatch");
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
      const attribution = postAttribution(deps.sourceMetadata, {
        publicationId: post.publicationId,
        ...(record.item.author ? { author: record.item.author } : {}),
      });
      const out = await extractGroundedClaims({
        provider: deps.models.claims,
        ...(attribution ? { attribution } : {}),
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
          ...(record.item.author ? { author: record.item.author } : {}),
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
      // Research that stopped for lack of provider credit is not a gap in the
      // evidence: stop the run so the article is not written from it (#407).
      if (
        pinned.some(
          (p) =>
            p.outcome === "finished" &&
            p.job.status === "finished" &&
            p.job.result?.outcome === "failed" &&
            p.job.result?.failure === "budget-exceeded",
        )
      ) {
        throw new StageError("research", CREDIT_EXHAUSTED);
      }
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
          if (p?.outcome === "not-commissioned") return { jobId, status: "not-commissioned" };
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
      let comparisons: ArtifactRef[] = [];
      if (deps.history) {
        const record = CoverageRecordSchema.parse(JSON.parse(await deps.content.read(coverage)));
        const claimResult = await deps.content.lookup(record.claimResult.path);
        if (claimResult) {
          comparisons = await saveSpeakerComparisons({
            content: deps.content,
            claimResult,
            deps: deps.history,
          });
        }
      }
      const { package: pkg, ref } = await saveWriterPackage({
        content: deps.content,
        archive: deps.archive,
        coverage,
        comparisons,
        historyGap: "omit",
      });
      return { ref: plain(ref), status: pkg.status };
    },

    async draft(pkg, sourceUrl) {
      const out = await draftFromPackage({
        operations: deps.operations,
        mechanicalPolicy: deps.mechanicalPolicy,
        content: deps.content,
        archive: deps.archive,
        package: pkg,
        provider: deps.models.writer,
        sourceUrl,
      });
      const diagnostics = "diagnostics" in out ? out.diagnostics?.map(plain) : undefined;
      const mechanicalRun =
        "mechanicalRun" in out && out.mechanicalRun ? plain(out.mechanicalRun) : undefined;
      if (out.status === "drafted") return { ref: plain(out.draft), diagnostics, mechanicalRun };
      return {
        failure:
          out.status === "failed"
            ? out.validationFailure
              ? `draft: ${out.validationFailure}`
              : out.reason
            : out.status,
        ...(diagnostics?.length ? { diagnostics } : {}),
        ...(mechanicalRun ? { mechanicalRun } : {}),
      };
    },

    async verify(draft, pkg, sourceUrl) {
      if (!deps.models.verifier)
        return { approved: false, unavailable: "no verifier model configured" };
      const metadata = await deps.content.lookup(draft.path.replace(/\.md$/, ".json"));
      if (!metadata) throw new StageError("verify", "draft-metadata-missing");
      const out = await verifyWithRevisions({
        operations: deps.operations,
        mechanicalPolicy: deps.mechanicalPolicy,
        content: deps.content,
        archive: deps.archive,
        package: pkg,
        metadata,
        writer: deps.models.writer,
        verifier: deps.models.verifier,
        sourceUrl,
      });
      if (out.outcome === "approved")
        return { approved: true, ref: plain(out.report), draft: plain(out.draft) };
      if (out.outcome === "unresolved") {
        return {
          approved: false,
          ref: plain(out.report),
          draft: plain(out.draft),
          reason: `unresolved after ${out.revisions} redrafts`,
        };
      }
      if (out.mechanicalRun)
        return {
          approved: false,
          failure: `verify: ${out.reason}`,
          ...(out.draft ? { draft: plain(out.draft) } : {}),
          ...(out.report ? { ref: plain(out.report) } : {}),
          mechanicalRun: plain(out.mechanicalRun),
        };
      throw new Error(`verify: ${out.reason}`);
    },

    async approve(report) {
      const { eventId } = await recordApproval({
        content: deps.content,
        operations: deps.operations,
        report,
      });
      return { eventId };
    },
  };
}
