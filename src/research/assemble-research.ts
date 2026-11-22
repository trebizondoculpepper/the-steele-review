import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore, PendingEventInput } from "../controllers/operation-store.js";
import {
  createResearchCompletedEvent,
  RESEARCH_COMPLETED_SUBJECT,
} from "../events/research-completed-event.js";
import {
  CitationInventorySchema,
  RetrievalOutcomeSchema,
  type RetrievalOutcome,
} from "./citation-inventory.js";
import type { DiscoveryData } from "./discovery-data.js";
import { readResearchDiscovery } from "./discovery.js";
import {
  ResearchManifestSchema,
  ResearchResultSchema,
  researchJobId,
  writeOnce,
  type ResearchManifest,
  type ResearchRequest,
} from "./job.js";

/**
 * Assemble a research result from saved stages (#592, under #210).
 *
 * Reads only exact saved artifacts: accepted discovery (#590), the citation
 * inventory and per-URL retrieval outcomes (#591). Never runs discovery or
 * downloads again. Produces the existing versioned manifest and result
 * contracts, so current consumers and dossiers read them unchanged, under the
 * discovery's own directory.
 *
 * A retrieved document is not evidence: every citation's support is
 * `not-checked` here; support assessment stays a separate boundary. Missing,
 * unsupported, not-attempted and pending retrievals, unfetchable URLs,
 * omitted entries and limited citation provenance are explicit gaps, and any
 * of them makes the outcome `complete-with-gaps`. "Retrieval complete" never
 * means "research sufficient" or a verified biography.
 *
 * Completion and its research-completed event are recorded in one state
 * transaction; a replay returns the recorded result without provider calls.
 */

export type AssemblyReader = (
  discovery: ArtifactRef,
) => Promise<{ data: DiscoveryData; request: ResearchRequest }>;

/** Production reader: #590's typed, acceptance-checked boundary. */
export function acceptedAssemblyReader(
  artifacts: GitArtifactStore,
  operations: Pick<OperationStore, "researchDiscoveryAccepted">,
): AssemblyReader {
  return async (discovery) => {
    const read = await readResearchDiscovery(artifacts, discovery, operations);
    return { data: read.data, request: read.request };
  };
}

export interface AssembledResearch {
  jobId: string;
  outcome: "complete" | "complete-with-gaps";
  manifest: ArtifactRef;
  result: ArtifactRef;
  /** True when this call found the assembly already recorded. */
  reused: boolean;
  /** Fetch keys still without an outcome (retryable or not yet run). */
  pending: number;
}

const toRef = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

export async function assembleResearch(input: {
  artifacts: GitArtifactStore;
  operations: Pick<OperationStore, "claim" | "complete" | "operationStatus" | "fail">;
  /** The discovery `result.json` reference. */
  discovery: ArtifactRef;
  /** The saved citation inventory for that discovery. */
  inventory: ArtifactRef;
  read: AssemblyReader;
  owner: string;
  now?: () => Date;
}): Promise<AssembledResearch> {
  const dir = input.discovery.path.replace(/\/result\.json$/, "");
  const assembledDir = `${dir}/assembled`;
  const { data, request } = await input.read(input.discovery);
  const jobId = researchJobId(request);
  const key = `research-assembly:${dir}`;

  const inventory = CitationInventorySchema.parse(
    JSON.parse(await input.artifacts.read(input.inventory)),
  );
  if (inventory.discovery.path !== input.discovery.path) {
    throw new Error("inventory belongs to another discovery");
  }

  // Replay: a recorded assembly is returned as it was, never rebuilt.
  const recorded = async (reused: boolean): Promise<AssembledResearch | undefined> => {
    const result = await input.artifacts.lookup(`${assembledDir}/result.json`);
    const manifest = await input.artifacts.lookup(`${assembledDir}/manifest.json`);
    if (!result || !manifest) return undefined;
    const parsed = ResearchResultSchema.parse(JSON.parse(await input.artifacts.read(result)));
    const m = ResearchManifestSchema.parse(JSON.parse(await input.artifacts.read(manifest)));
    return {
      jobId,
      outcome: parsed.outcome === "complete" ? "complete" : "complete-with-gaps",
      manifest,
      result,
      reused,
      pending: m.citations.filter((c) => c.retrievalReason === "retrieval-pending").length,
    };
  };
  if (input.operations.operationStatus(key)?.status === "completed") {
    const done = await recorded(true);
    if (done) return done;
  }

  // Per-URL outcomes, by fetch key, read from their exact saved records.
  const dirOf = input.inventory.path.replace(/\/inventory\.json$/, "");
  const outcomes = new Map<string, RetrievalOutcome>();
  for (const id of new Set(inventory.entries.map((e) => e.retrievalId).filter(Boolean))) {
    const ref = await input.artifacts.lookup(`${dirOf}/retrievals/${id}.json`);
    if (ref) {
      outcomes.set(id!, RetrievalOutcomeSchema.parse(JSON.parse(await input.artifacts.read(ref))));
    }
  }

  const gaps: string[] = [];
  const citations: ResearchManifest["citations"] = [];
  let pending = 0;
  let invalid = 0;
  for (const entry of inventory.entries) {
    if (!entry.retrievalId || !entry.retrievalKey) {
      invalid++;
      continue;
    }
    const url = entry.originalUrl;
    const o = outcomes.get(entry.retrievalId);
    const base = { url, support: "not-checked" as const, passages: [] };
    if (!o) {
      pending++;
      citations.push({ ...base, retrieval: "not-attempted", retrievalReason: "retrieval-pending" });
    } else if (o.status === "archived" && o.snapshot) {
      citations.push({ ...base, retrieval: "archived", archivedArtifact: o.snapshot });
    } else if (o.status === "unsupported") {
      citations.push({
        ...base,
        retrieval: "unsupported",
        retrievalReason: o.reason ?? "unsupported",
      });
    } else if (o.status === "not-attempted") {
      citations.push({
        ...base,
        retrieval: "not-attempted",
        retrievalReason: o.reason ?? "not-attempted",
      });
    } else {
      citations.push({
        ...base,
        retrieval: "inaccessible",
        retrievalReason: o.reason ?? "unavailable",
      });
    }
  }
  const missing = citations.filter((c) => c.retrieval !== "archived").length;
  if (missing > 0)
    gaps.push(`${missing} cited source(s) were not retrieved; see each citation's reason.`);
  if (pending > 0) gaps.push(`${pending} retrieval(s) are still pending or retryable.`);
  if (invalid > 0)
    gaps.push(
      `${invalid} cited URL(s) could not be fetched (invalid, unsupported scheme or too long).`,
    );
  if (inventory.omittedEntries > 0)
    gaps.push(
      `${inventory.omittedEntries} cited URL(s) exceeded the inventory bound and were not listed.`,
    );
  if (data.citationProvenance !== "provider-original")
    gaps.push("Citation list comes from the adapter's return, not the original provider envelope.");
  gaps.push("Retrieved documents are not yet assessed as support for any claim.");

  if (citations.length > 500) {
    // The manifest contract holds at most 500 citations; the rest stay in the inventory.
    gaps.push(`${citations.length - 500} further citation(s) are recorded only in the inventory.`);
  }
  // Report text, then manifest, then result: each write-once and deterministic.
  const report = await writeOnce(input.artifacts, `${assembledDir}/report.md`, data.report);
  const manifest = await writeOnce(
    input.artifacts,
    `${assembledDir}/manifest.json`,
    ResearchManifestSchema.parse({
      schemaVersion: 1,
      jobId,
      report: toRef(report),
      citations: citations.slice(0, 500),
      gaps: gaps.slice(0, 100),
      provider: {
        model: data.model,
        ...(data.usage?.costUsd !== undefined ? { costUsd: data.usage.costUsd } : {}),
      },
    }),
  );
  const outcome =
    missing === 0 &&
    invalid === 0 &&
    inventory.omittedEntries === 0 &&
    data.citationProvenance === "provider-original"
      ? "complete"
      : "complete-with-gaps";
  const result = await writeOnce(
    input.artifacts,
    `${assembledDir}/result.json`,
    ResearchResultSchema.parse({
      schemaVersion: 1,
      jobId,
      outcome,
      manifest: toRef(manifest),
      finishedAt: (input.now ?? (() => new Date()))().toISOString(),
    }),
  );

  // Completion and its event in one state transaction (outbox).
  const claim = input.operations.claim(key, input.owner, 60_000, 5);
  if (claim.kind === "busy") throw new Error("assembly-busy");
  if (claim.kind === "claimed") {
    const event = createResearchCompletedEvent(
      { jobId, outcome, manifest: toRef(manifest) },
      { id: `research-assembled-${jobId.slice(9)}`, now: input.now ?? (() => new Date()) },
    );
    const pendingEvent: PendingEventInput = {
      eventId: event.id,
      subject: RESEARCH_COMPLETED_SUBJECT,
      payload: JSON.stringify(event.toJSON()),
    };
    try {
      input.operations.complete(claim.claim, toRef(result), [pendingEvent]);
    } catch (error) {
      // Release the claim as retryable so the next attempt can finish it.
      try {
        input.operations.fail(claim.claim, "assembly-completion-failed", true);
      } catch {
        // Lease already lost; the next owner retries.
      }
      throw error;
    }
  }
  const done = await recorded(claim.kind !== "claimed");
  if (!done) throw new Error("assembly not recorded");
  return { ...done, pending };
}
