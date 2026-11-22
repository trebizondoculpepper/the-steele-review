import { SourceContextSchema, type SourceContext } from "../content/source-context.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { readLengthLimitedResearchDiscovery } from "./discovery.js";
import { CoverageRecordSchema } from "./librarian.js";
import {
  ResearchRequestSchema,
  ResearchResultSchema,
  ResearchManifestSchema,
  researchJobId,
} from "./job.js";

const ref = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});
const fromRef = (r: ReturnType<typeof ref>): ArtifactRef => ({ ...r, sha256: r.hash.slice(7) });

/** No provider capability: derive one exact, distinct recovery request from accepted retained bytes. */
export async function prepareRetainedResearch(input: {
  artifacts: GitArtifactStore;
  operations: Pick<OperationStore, "researchDiscoveryAccepted">;
  discovery: ArtifactRef;
  failedResult: ArtifactRef;
}) {
  const retained = await readLengthLimitedResearchDiscovery(
    input.artifacts,
    input.discovery,
    input.operations,
  );
  const failed = ResearchResultSchema.parse(
    JSON.parse(await input.artifacts.read(input.failedResult)),
  );
  const originalJobId = researchJobId(retained.request);
  if (
    input.failedResult.path !== `research-jobs/${originalJobId}/result.json` ||
    failed.jobId !== originalJobId ||
    failed.outcome !== "failed" ||
    failed.failure !== "invalid-report" ||
    retained.request.retainedRecovery
  )
    throw new Error("invalid-retained-research-recovery");
  const request = ResearchRequestSchema.parse({
    ...retained.request,
    pass: retained.request.pass + 1,
    previousJobId: originalJobId,
    retainedRecovery: {
      version: "retained-length-limit-v1",
      discovery: ref(input.discovery),
      failedResult: ref(input.failedResult),
    },
  });
  return { retained, request, originalJobId };
}

/** Recheck identity on every entry; changing claims, context or question cannot reuse this report. */
export async function loadRetainedResearch(input: {
  artifacts: GitArtifactStore;
  operations: Pick<OperationStore, "researchDiscoveryAccepted">;
  request: unknown;
}) {
  const request = ResearchRequestSchema.parse(input.request);
  if (!request.retainedRecovery) throw new Error("missing-retained-research-recovery");
  const loaded = await prepareRetainedResearch({
    ...input,
    discovery: fromRef(request.retainedRecovery.discovery),
    failedResult: fromRef(request.retainedRecovery.failedResult),
  });
  if (JSON.stringify(loaded.request) !== JSON.stringify(request))
    throw new Error("retained-research-input-mismatch");
  return loaded;
}

/** Validate the accepted binding and exact request again before normal research composition reuses it. */
export async function readAcceptedResearchRecovery(input: {
  artifacts: GitArtifactStore;
  operations: Pick<OperationStore, "researchRecovery" | "researchDiscoveryAccepted">;
  request: unknown;
}) {
  const request = ResearchRequestSchema.parse(input.request),
    originalJobId = researchJobId(request);
  const binding = input.operations.researchRecovery(originalJobId);
  if (!binding) return undefined;
  const loaded = await prepareRetainedResearch({
    ...input,
    discovery: fromRef(binding.discovery),
    failedResult: fromRef(binding.failedResult),
  });
  if (
    loaded.originalJobId !== originalJobId ||
    JSON.stringify(loaded.retained.request) !== JSON.stringify(request) ||
    researchJobId(loaded.request) !== binding.jobId
  )
    throw new Error("retained-research-binding-mismatch");
  const result = ResearchResultSchema.parse(
    JSON.parse(await input.artifacts.read(fromRef(binding.result))),
  );
  if (result.jobId !== binding.jobId || result.outcome !== "complete-with-gaps" || !result.manifest)
    throw new Error("invalid-retained-research-result");
  const manifest = ResearchManifestSchema.parse(
    JSON.parse(await input.artifacts.read(fromRef(result.manifest))),
  );
  if (
    manifest.jobId !== binding.jobId ||
    JSON.stringify(manifest.retainedRecovery) !== JSON.stringify(loaded.request.retainedRecovery)
  )
    throw new Error("invalid-retained-research-manifest");
  return { binding, result, resultRef: fromRef(binding.result) };
}

/** Pre-submit validation for a normal article continuation; a supplied ID is never acceptance. */
export async function validateRetainedArticleResearch(input: {
  artifacts: GitArtifactStore;
  operations: Pick<OperationStore, "researchRecovery" | "researchDiscoveryAccepted">;
  jobIds: readonly string[];
  capture: ArtifactRef;
  sourceContext: SourceContext;
}) {
  for (const id of input.jobIds) {
    if (!/^research-[0-9a-f]{32}$/.test(id)) throw new Error("invalid-retained-research-id");
    const requestRef = await input.artifacts.lookup(`research-jobs/${id}/request.json`);
    if (!requestRef) throw new Error("retained-research-request-missing");
    const request = ResearchRequestSchema.parse(JSON.parse(await input.artifacts.read(requestRef)));
    if (request.origin === "theme") {
      // A theme request (#658) carries no post by design: it is bound to this
      // article through the coverage record that commissioned it, never by
      // putting post data back into its shared identity.
      if (researchJobId(request) !== id) throw new Error("retained-research-capture-mismatch");
      await requireCommissioningCoverage(input, id);
      if (!(await readAcceptedResearchRecovery({ ...input, request })))
        throw new Error("retained-research-not-accepted");
      continue;
    }
    if (
      researchJobId(request) !== id ||
      !request.post?.sourceContext ||
      JSON.stringify(request.post.sourceArtifact) !== JSON.stringify(ref(input.capture))
    )
      throw new Error("retained-research-capture-mismatch");
    const context = SourceContextSchema.parse(
      JSON.parse(await input.artifacts.read(fromRef(request.post.sourceContext))),
    );
    if (JSON.stringify(context) !== JSON.stringify(SourceContextSchema.parse(input.sourceContext)))
      throw new Error("retained-research-context-mismatch");
    if (!(await readAcceptedResearchRecovery({ ...input, request })))
      throw new Error("retained-research-not-accepted");
  }
}

/** Bound on coverage records examined when binding a theme request. */
const COVERAGE_SCAN = 2_000;

/**
 * A coverage record for exactly this capture and source context must list
 * the job; otherwise the theme job was not commissioned for this article.
 */
async function requireCommissioningCoverage(
  input: { artifacts: GitArtifactStore; capture: ArtifactRef; sourceContext: SourceContext },
  jobId: string,
): Promise<void> {
  const capture = JSON.stringify(ref(input.capture));
  let after: string | undefined;
  let scanned = 0;
  while (scanned < COVERAGE_SCAN) {
    const paths = await input.artifacts.list("librarian/coverage", 200, after);
    for (const path of paths) {
      scanned++;
      const r = await input.artifacts.lookup(path);
      if (!r) continue;
      const parsed = CoverageRecordSchema.safeParse(JSON.parse(await input.artifacts.read(r)));
      if (!parsed.success) continue;
      const c = parsed.data;
      if (JSON.stringify(c.source) !== capture || !c.jobs.some((j) => j.jobId === jobId)) continue;
      if (!c.sourceContext) continue;
      const context = SourceContextSchema.parse(
        JSON.parse(await input.artifacts.read(fromRef(c.sourceContext))),
      );
      const wanted = JSON.stringify(SourceContextSchema.parse(input.sourceContext));
      if (JSON.stringify(context) !== wanted) throw new Error("retained-research-context-mismatch");
      return;
    }
    if (paths.length < 200) break;
    after = paths[paths.length - 1];
  }
  throw new Error("retained-research-capture-mismatch");
}
