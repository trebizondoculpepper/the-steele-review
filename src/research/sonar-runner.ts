import { captureResearchDiscovery, ResearchDiscoveryError } from "./discovery.js";
import { discoveryFromAdapterReport } from "./discovery-data.js";
import { ModelProviderError } from "../controllers/openrouter.js";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import {
  SonarError,
  SUBJECT_RESEARCH_PROMPT_VERSION,
  type SubjectResearchProvider,
  type SonarReport,
} from "../controllers/sonar.js";
import type { PageFetcher } from "./gap-research.js";
import {
  CitationRecordSchema,
  finishResearchJob,
  openResearchJob,
  ResearchManifestSchema,
  outputLimitWarning,
  type ResearchWarning,
  researchJobPath,
  type ResearchManifest,
  type ResearchRequest,
  type ResearchResult,
} from "./job.js";
import { WebAdapterError } from "../controllers/research-web.js";

function reference({ repository, commit, path, sha256 }: ArtifactRef) {
  return { repository, commit, path, hash: `sha256:${sha256}` };
}

async function writeArtifact(store: GitArtifactStore, path: string, content: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await store.write(path, content);
    } catch (error) {
      if (
        !(error instanceof ArtifactStoreError && error.code === "concurrent-update" && attempt < 5)
      ) {
        throw error;
      }
    }
  }
}

export async function runSonarResearch(input: {
  artifacts: GitArtifactStore;
  operations: OperationStore;
  owner: string;
  request: ResearchRequest;
  discover: SubjectResearchProvider;
  fetcher: PageFetcher;
}): Promise<
  | { status: "busy"; jobId: string }
  | { status: "finished"; result: ResearchResult; reused: boolean }
> {
  const job = await openResearchJob(input);
  if (job.status === "busy") return { status: "busy", jobId: job.jobId };
  if (job.status === "finished") return { status: "finished", result: job.existing, reused: true };

  const finish = async (
    fields: Pick<
      Parameters<typeof finishResearchJob>[0],
      "outcome" | "failure" | "manifest" | "warnings"
    >,
  ) => {
    const { result, reused } = await finishResearchJob({
      artifacts: input.artifacts,
      operations: input.operations,
      jobId: job.jobId,
      ...fields,
    });
    return { status: "finished" as const, result, reused };
  };

  let warnings: ResearchWarning[] = [];
  let discovery: SonarReport;
  let discoveryRef: ArtifactRef | undefined;
  try {
    const captured = await captureResearchDiscovery({
      artifacts: input.artifacts,
      operations: input.operations,
      request: input.request,
      owner: input.owner,
      partialReport: "warning-v1",
      processor: input.discover.discoveryProcessor ?? {
        version: "research-discovery-v1",
        model: "adapter-unspecified",
        promptVersion: SUBJECT_RESEARCH_PROMPT_VERSION,
        parameters: {},
      },
      invoke: async (capture) => {
        try {
          return discoveryFromAdapterReport(await input.discover(input.request, capture));
        } catch (error) {
          if (error instanceof SonarError)
            throw new ModelProviderError(
              error.code === "budget-exceeded"
                ? "credit-exhausted"
                : error.code === "timeout"
                  ? "timeout"
                  : error.code === "invalid-report"
                    ? "bad-response"
                    : error.code === "rate-limited" ||
                        error.code === "unauthorised" ||
                        error.code === "bad-request"
                      ? error.code
                      : "unavailable",
              error.status,
            );
          throw error;
        }
      },
    });
    discoveryRef = captured.ref;
    if (captured.partial) warnings = [outputLimitWarning(reference(captured.ref))];
    const cited = [
      ...captured.data.citations,
      ...captured.data.annotationUrls,
      ...Array.from(captured.data.report.matchAll(/\]\((https?:\/\/[^\s)<>]+)\)/g), (m) => m[1]!),
    ];
    discovery = {
      model: captured.data.model,
      report: captured.data.report,
      citations: cited.length ? cited : captured.data.searchResultUrls,
      ...(captured.data.usage?.costUsd === undefined
        ? {}
        : { costUsd: captured.data.usage.costUsd }),
    };
  } catch (error) {
    if (error instanceof ResearchDiscoveryError && error.code === "busy") {
      input.operations.yieldClaim(job.claim);
      return { status: "busy", jobId: job.jobId };
    }
    return finish({
      outcome: "failed",
      failure:
        error instanceof ModelProviderError
          ? error.code === "credit-exhausted"
            ? "budget-exceeded"
            : error.code === "timeout"
              ? "timeout"
              : "provider-error"
          : error instanceof ResearchDiscoveryError && error.code === "invalid-report"
            ? "invalid-report"
            : "provider-error",
    });
  }
  const directory = `research-jobs/${job.jobId}`;
  const report = await writeArtifact(
    input.artifacts,
    `${directory}/report.md`,
    `${discovery.report}\n`,
  );
  const urls = [
    ...new Set(
      discovery.citations.flatMap((value) => {
        if (value.length > 4096) return [];
        try {
          const url = new URL(value);
          if (url.protocol !== "https:" && url.protocol !== "http:") return [];
          if (url.username || url.password) return [];
          url.hash = "";
          return [url.href];
        } catch {
          return [];
        }
      }),
    ),
  ];
  const gaps: string[] = warnings.map((w) => w.message);
  if (!urls.length) gaps.push("The report did not provide any usable citation URLs.");
  if (urls.length > 12) gaps.push("Source retrieval was limited to the first 12 URLs.");
  const citations: ResearchManifest["citations"] = [];
  const signal = AbortSignal.timeout(60_000);
  for (const [index, url] of urls.slice(0, 500).entries()) {
    if (index >= 12 || signal.aborted) {
      citations.push({ url, retrieval: "not-attempted", passages: [] });
      continue;
    }
    let page;
    try {
      page = await input.fetcher.fetch(url, signal);
    } catch (error) {
      const reason = error instanceof WebAdapterError ? error.code : "unavailable";
      citations.push(
        CitationRecordSchema.parse({
          url,
          retrieval:
            reason === "unsupported-content" || reason === "redirected"
              ? "unsupported"
              : "inaccessible",
          confidenceRationale: reason,
          passages: [],
        }),
      );
      continue;
    }
    if (!page.text.trim()) {
      citations.push({
        url,
        retrieval: "inaccessible",
        confidenceRationale: "empty page",
        passages: [],
      });
      continue;
    }
    const snapshot = await writeArtifact(
      input.artifacts,
      `${directory}/sources/${index + 1}.json`,
      `${JSON.stringify({ ...page, url }, null, 2)}\n`,
    );
    citations.push({
      url,
      retrieval: "archived",
      archivedArtifact: reference(snapshot),
      confidenceRationale:
        "Captured source text. Claim support and source type have not been independently established.",
      passages: [],
    });
  }
  if (citations.some((entry) => entry.retrieval !== "archived")) {
    gaps.push("Some sources could not be captured. See the individual retrieval outcomes.");
  }
  if (citations.length) {
    gaps.push(
      "The saved snapshots are available for review. Claim support and source type remain unverified.",
    );
  }
  const note = await writeArtifact(
    input.artifacts,
    `${directory}/coverage.md`,
    [
      "See report.md for the provider research and manifest.json for citation references.",
      "",
      ...gaps.map((gap) => `- ${gap}`),
      "",
    ].join("\n"),
  );
  const manifest = ResearchManifestSchema.parse({
    schemaVersion: 1,
    jobId: job.jobId,
    ...(discoveryRef ? { discovery: reference(discoveryRef) } : {}),
    report: reference(report),
    coveringNote: reference(note),
    ...(warnings.length ? { warnings } : {}),
    citations,
    gaps,
    provider: {
      model: discovery.model,
      ...(discovery.costUsd === undefined ? {} : { costUsd: discovery.costUsd }),
    },
  });
  const manifestRef = await writeArtifact(
    input.artifacts,
    researchJobPath(job.jobId, "manifest"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return finish({
    outcome: gaps.length ? "complete-with-gaps" : "complete",
    manifest: manifestRef,
    ...(warnings.length ? { warnings } : {}),
  });
}
