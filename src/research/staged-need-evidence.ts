import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import type {
  ArtifactRef,
  GitArtifactStore,
} from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { readResearchDiscovery } from "./discovery.js";
import {
  buildCitationInventory,
  CitationInventorySchema,
  CitationSnapshotSchema,
  RetrievalOutcomeSchema,
} from "./citation-inventory.js";
import {
  ResearchResultSchema,
  researchJobId,
  type ResearchManifest,
  type ResearchRequest,
} from "./job.js";
const Ref = ArtifactReferenceSchema;
export const StagedNeedEvidenceSchema = z
  .object({
    version: z.literal("staged-need-evidence-v1"),
    discovery: Ref,
    inventory: Ref,
    assemblyResult: Ref,
  })
  .strict();
export type DiscoveryAcceptance = Pick<
  OperationStore,
  "researchDiscoveryAccepted"
>;
type Store = Pick<GitArtifactStore, "read" | "lookup" | "lookupAt">;
const toRef = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});
const artifact = (r: z.infer<typeof Ref>): ArtifactRef => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  sha256: r.hash.slice(7),
});
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const directory = (path: string) =>
  /^(research-discovery\/research-[0-9a-f]{32}\/discovery-[0-9a-f]{32})\/assembled\/manifest\.json$/.exec(
    path,
  )?.[1];

export async function stagedNeedEvidence(
  artifacts: Store,
  result: ArtifactRef,
  manifest: ArtifactRef,
) {
  const dir = directory(manifest.path);
  if (!dir) throw new Error("research-need-staged-path-mismatch");
  const refs: ArtifactRef[] = [];
  for (const path of [
    `${dir}/result.json`,
    `${dir}/citations/inventory.json`,
    `${dir}/assembled/result.json`,
  ]) {
    const saved = await artifacts.lookupAt(result.commit, path);
    if (!saved || saved.ref.repository !== result.repository)
      throw new Error("research-need-staged-artifact-missing");
    refs.push(saved.ref);
  }
  return StagedNeedEvidenceSchema.parse({
    version: "staged-need-evidence-v1",
    discovery: toRef(refs[0]!),
    inventory: toRef(refs[1]!),
    assemblyResult: toRef(refs[2]!),
  });
}

/** Validate the immutable staged assembly and accepted discovery, not a permissive path exception. */
export async function readStagedNeedEvidence(input: {
  artifacts: Store;
  acceptance: DiscoveryAcceptance;
  staged: z.infer<typeof StagedNeedEvidenceSchema>;
  request: ResearchRequest;
  result: z.infer<typeof ResearchResultSchema>;
  manifest: ResearchManifest;
  manifestRef: z.infer<typeof Ref>;
  report: z.infer<typeof Ref>;
}) {
  const s = StagedNeedEvidenceSchema.parse(input.staged);
  const dir = directory(input.manifestRef.path);
  if (
    !dir ||
    s.discovery.path !== `${dir}/result.json` ||
    s.inventory.path !== `${dir}/citations/inventory.json` ||
    s.assemblyResult.path !== `${dir}/assembled/result.json` ||
    input.report.path !== `${dir}/assembled/report.md`
  )
    throw new Error("research-need-staged-path-mismatch");
  const assembly = ResearchResultSchema.parse(
    JSON.parse(await input.artifacts.read(artifact(s.assemblyResult))),
  );
  if (
    !same(assembly, input.result) ||
    !same(assembly.manifest, input.manifestRef) ||
    researchJobId(input.request) !== assembly.jobId
  )
    throw new Error("research-need-staged-result-mismatch");
  const discovery = await readResearchDiscovery(
    input.artifacts,
    artifact(s.discovery),
    input.acceptance,
  );
  if (
    !same(discovery.request, input.request) ||
    discovery.result.requestId !== assembly.jobId
  )
    throw new Error("research-need-staged-request-mismatch");
  if (
    (await input.artifacts.read(artifact(input.report))) !==
    discovery.data.report
  )
    throw new Error("research-need-staged-report-mismatch");
  const inventory = CitationInventorySchema.parse(
    JSON.parse(await input.artifacts.read(artifact(s.inventory))),
  );
  const expected = buildCitationInventory(discovery.data);
  if (
    !same(inventory.discovery, s.discovery) ||
    !same(inventory.entries, expected.entries) ||
    inventory.omittedEntries !== expected.omittedEntries
  )
    throw new Error("research-need-staged-inventory-mismatch");
  const snapshotKeys = new Map<string, string>();
  for (const citation of input.manifest.citations) {
    const entry = inventory.entries.find((e) => e.originalUrl === citation.url);
    if (!entry) throw new Error("research-need-staged-citation-mismatch");
    if (citation.retrieval !== "archived") continue;
    if (!entry.retrievalId || !entry.retrievalKey || !citation.archivedArtifact)
      throw new Error("research-need-staged-source-mismatch");
    const saved = await input.artifacts.lookupAt(
      s.assemblyResult.commit,
      `${dir}/citations/retrievals/${entry.retrievalId}.json`,
    );
    if (!saved) throw new Error("research-need-staged-retrieval-missing");
    const outcome = RetrievalOutcomeSchema.parse(JSON.parse(saved.content));
    if (
      outcome.status !== "archived" ||
      outcome.retrievalId !== entry.retrievalId ||
      outcome.retrievalKey !== entry.retrievalKey ||
      !same(outcome.inventory, s.inventory) ||
      !same(outcome.snapshot, citation.archivedArtifact)
    )
      throw new Error("research-need-staged-source-mismatch");
    const snapshot = CitationSnapshotSchema.parse(
      JSON.parse(
        await input.artifacts.read(artifact(citation.archivedArtifact)),
      ),
    );
    if (snapshot.retrievalKey !== entry.retrievalKey)
      throw new Error("research-need-staged-source-mismatch");
    snapshotKeys.set(
      JSON.stringify(citation.archivedArtifact),
      entry.retrievalKey,
    );
  }
  return snapshotKeys;
}
