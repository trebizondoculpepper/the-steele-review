import {
  StagedNeedEvidenceSchema,
  stagedNeedEvidence,
  readStagedNeedEvidence,
  type DiscoveryAcceptance,
} from "./staged-need-evidence.js";
import { CitationSnapshotSchema } from "./citation-inventory.js";
import { ClaimExtractionRecordSchema } from "../analysis/grounded-claims.js";
import { parseThemeProposalResult } from "../analysis/theme-proposals.js";
import { canonicalNeed } from "./canonical-need.js";
import { readResearchNeedBindings } from "./need-bindings.js";
import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import type {
  ArtifactRef,
  GitArtifactStore,
} from "../controllers/artifact-store.js";
import { CanonicalNeedSchema, canonicalNeedId } from "./canonical-need.js";
import {
  ResearchManifestSchema,
  ResearchRequestSchema,
  ResearchResultSchema,
  researchJobId,
  researchJobPath,
} from "./job.js";
import {
  SavedReportSchema,
  savedSourceSchema,
  MAX_SAVED_REPORT_CHARS,
} from "./runner.js";
type EvidenceStore = Pick<
  GitArtifactStore,
  "read" | "lookup" | "lookupAt" | "list"
>;
const Ref = ArtifactReferenceSchema;
export const ResearchNeedEvidenceSchema = z
  .object({
    version: z.literal("research-need-evidence-v1"),
    need: CanonicalNeedSchema,
    bindings: Ref.optional(),
    staged: StagedNeedEvidenceSchema.optional(),
    request: Ref,
    result: Ref,
    manifest: Ref,
    report: Ref,
  })
  .strict();
export type ResearchNeedEvidence = z.infer<typeof ResearchNeedEvidenceSchema>;
const artifact = (r: z.infer<typeof Ref>): ArtifactRef => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  sha256: r.hash.slice(7),
});
const reference = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Validate the exact original request, paid report and support before projecting into a new post. */
export async function readResearchNeedEvidence(
  artifacts: EvidenceStore,
  input: ResearchNeedEvidence,
  acceptance?: DiscoveryAcceptance,
) {
  const proof = ResearchNeedEvidenceSchema.parse(input);
  const request = ResearchRequestSchema.parse(
    JSON.parse(await artifacts.read(artifact(proof.request))),
  );
  const jobId = researchJobId(request);
  const needId = canonicalNeedId(proof.need);
  let passageId = needId;
  if (request.canonicalNeeds) {
    if (!proof.bindings) throw new Error("research-need-binding-missing");
    const bindings = await readResearchNeedBindings(
      artifacts,
      artifact(proof.bindings),
    );
    const selected = request.canonicalNeeds.needs.find(
      (n) => canonicalNeedId(n) === needId,
    );
    if (
      !selected ||
      !same(selected, proof.need) ||
      !bindings.entries.some(
        (e) => e.needId === needId && same(e.need, proof.need),
      )
    )
      throw new Error("research-need-binding-mismatch");
  } else {
    const selected = await legacyRequestNeed(artifacts, request, proof.need);
    if (!selected) throw new Error("research-need-legacy-scope-mismatch");
    passageId = selected;
  }
  if (proof.request.path !== researchJobPath(jobId, "request"))
    throw new Error("research-need-request-mismatch");
  const result = ResearchResultSchema.parse(
    JSON.parse(await artifacts.read(artifact(proof.result))),
  );
  if (
    result.jobId !== jobId ||
    result.outcome === "failed" ||
    proof.result.path !== researchJobPath(jobId, "result") ||
    !same(result.manifest, proof.manifest)
  )
    throw new Error("research-need-result-mismatch");
  const manifest = ResearchManifestSchema.parse(
    JSON.parse(await artifacts.read(artifact(proof.manifest))),
  );
  if (manifest.jobId !== jobId || !same(manifest.report, proof.report))
    throw new Error("research-need-manifest-mismatch");
  let stagedKeys: Map<string, string> | undefined;
  if (proof.staged) {
    if (!acceptance)
      throw new Error("research-need-discovery-acceptance-required");
    stagedKeys = await readStagedNeedEvidence({
      artifacts,
      acceptance,
      staged: proof.staged,
      request,
      result,
      manifest,
      manifestRef: proof.manifest,
      report: proof.report,
    });
  } else {
    if (proof.manifest.path !== researchJobPath(jobId, "manifest"))
      throw new Error("research-need-manifest-mismatch");
    const report = SavedReportSchema.parse(
      JSON.parse(await artifacts.read(artifact(proof.report))),
    );
    if (
      report.jobId !== jobId ||
      proof.report.path !== `research-jobs/${jobId}/report.json`
    )
      throw new Error("research-need-report-mismatch");
  }
  const allowed = new Set(request.claims.map((c) => c.claimRecordId));
  if (
    manifest.citations.some((c) =>
      c.passages.some((p) => !allowed.has(p.claimRecordId)),
    )
  )
    throw new Error("research-need-passage-mismatch");
  const citations: { url: string; passage: string }[] = [];
  const normalise = (value: string) =>
    value.normalize("NFC").replace(/\s+/gu, " ").trim();
  for (const citation of manifest.citations) {
    if (
      citation.retrieval !== "archived" ||
      !citation.archivedArtifact ||
      citation.support !== "supported" ||
      citation.sourceType === "monitored-source" ||
      !citation.url.startsWith("https://")
    )
      continue;
    const matching = citation.passages.filter(
      (p) => p.claimRecordId === passageId,
    );
    if (!matching.length) continue;
    const rawSource = JSON.parse(
      await artifacts.read(artifact(citation.archivedArtifact)),
    );
    const source = stagedKeys
      ? CitationSnapshotSchema.parse(rawSource)
      : savedSourceSchema(MAX_SAVED_REPORT_CHARS).parse(rawSource);
    const sourceMatches = stagedKeys
      ? "retrievalKey" in source &&
        source.retrievalKey ===
          stagedKeys.get(JSON.stringify(citation.archivedArtifact))
      : source.url === citation.url;
    if (
      !sourceMatches ||
      matching.some(
        (p) => !normalise(source.text).includes(normalise(p.passage)),
      )
    )
      throw new Error("research-need-source-passage-mismatch");
    citations.push(
      ...matching.map((p) => ({ url: citation.url, passage: p.passage })),
    );
  }
  return { proof, request, result, manifest, citations };
}

/** Resolve a finished new-contract job at its immutable result snapshot. */
export async function researchNeedEvidence(
  artifacts: EvidenceStore,
  resultRef: ArtifactRef,
  need: z.infer<typeof CanonicalNeedSchema>,
  bindingsRef?: ArtifactRef,
  acceptance?: DiscoveryAcceptance,
): Promise<ResearchNeedEvidence> {
  const result = ResearchResultSchema.parse(
    JSON.parse(await artifacts.read(resultRef)),
  );
  if (!result.manifest) throw new Error("research-need-result-mismatch");
  const request = await artifacts.lookupAt(
    resultRef.commit,
    researchJobPath(result.jobId, "request"),
  );
  if (!request) throw new Error("research-need-request-missing");
  const manifest = ResearchManifestSchema.parse(
    JSON.parse(await artifacts.read(artifact(result.manifest))),
  );
  const proof = ResearchNeedEvidenceSchema.parse({
    version: "research-need-evidence-v1",
    need,
    ...(bindingsRef ? { bindings: reference(bindingsRef) } : {}),
    request: reference(request.ref),
    result: reference(resultRef),
    manifest: result.manifest,
    report: manifest.report,
    ...(result.manifest.path === researchJobPath(result.jobId, "manifest")
      ? {}
      : {
          staged: await stagedNeedEvidence(
            artifacts,
            resultRef,
            artifact(result.manifest),
          ),
        }),
  });
  await readResearchNeedEvidence(artifacts, proof, acceptance);
  return proof;
}

/** Build all semantic bindings once, refusing a grouped ID whose accepted rows disagree. */
async function legacyRequestNeeds(
  artifacts: EvidenceStore,
  request: z.infer<typeof ResearchRequestSchema>,
) {
  const out = new Map<string, string | undefined>();
  if (request.origin !== "extraction" || !request.post) return out;
  const post = request.post;
  const record = ClaimExtractionRecordSchema.parse(
    JSON.parse(await artifacts.read(artifact(post.claimResult))),
  );
  const themes = parseThemeProposalResult(
    JSON.parse(await artifacts.read(artifact(post.themeResult))),
  );
  if (
    record.schemaVersion < 3 ||
    record.post.publicationId !== post.publicationId ||
    record.post.postId !== post.postId ||
    themes.post.publicationId !== post.publicationId ||
    themes.post.postId !== post.postId ||
    record.sourceVersion !== themes.sourceVersion ||
    !same(themes.artifact, post.sourceArtifact) ||
    (record.themeResult &&
      record.themeResult !==
        `${post.themeResult.commit}:${post.themeResult.path}`)
  )
    return out;
  for (const requested of request.claims) {
    if (requested.themeIds.length !== 1) continue;
    const rows = record.claims
      .map((claim, index) => ({ claim, index }))
      .filter(({ claim }) => claim.claimRecordId === requested.claimRecordId);
    if (!rows.length) continue;
    const needs = rows.map(({ claim, index }) => {
      if (
        z.looseObject({ statement: z.string() }).parse(claim.claim)
          .statement !== requested.statement ||
        claim.themeIds.some((id) => !themes.proposals.some((p) => p.id === id))
      )
        return undefined;
      return canonicalNeed({
        themeId: requested.themeIds[0]!,
        claimRecordId: requested.claimRecordId,
        kind: claim.kind,
        claim: claim.claim,
        occurrence: claim.occurrence,
        binding: {
          schemaVersion: record.schemaVersion,
          ...record.post,
          sourceVersion: record.sourceVersion,
          source: post.sourceArtifact,
          analysis: post.claimResult,
          index,
        },
      });
    });
    const ids = [
      ...new Set(
        needs
          .filter((n): n is NonNullable<typeof n> => !!n && !n.occurrenceScope)
          .map((n) => canonicalNeedId(n)),
      ),
    ];
    if (needs.some((n) => !n || n.occurrenceScope) || ids.length !== 1) {
      for (const id of ids) out.set(id, undefined);
      continue;
    }
    out.set(ids[0]!, requested.claimRecordId);
  }
  return out;
}
async function legacyRequestNeed(
  artifacts: EvidenceStore,
  request: z.infer<typeof ResearchRequestSchema>,
  expected: z.infer<typeof CanonicalNeedSchema>,
) {
  if (expected.occurrenceScope) return undefined;
  return (await legacyRequestNeeds(artifacts, request)).get(
    canonicalNeedId(expected),
  );
}

class LegacyProofLimitError extends Error {}

export type LegacyNeedLookup =
  | { status: "found"; proof: ResearchNeedEvidence }
  | {
      status: "unavailable";
      reason:
        | "legacy-proof-missing"
        | "legacy-proof-scan-bound"
        | "legacy-proof-ambiguous";
    };
/** Exact immutable reads may be shared within one assessment, never across mutable path lookups. */
export function cachedResearchEvidenceStore(
  artifacts: EvidenceStore,
): EvidenceStore {
  const values = new Map<string, string>();
  const inFlight = new Map<string, Promise<string>>();
  let chars = 0;
  const maxChars = 16 * 1024 * 1024; // At most roughly 32 MiB of UTF-16 source text.
  return {
    lookup: artifacts.lookup.bind(artifacts),
    lookupAt: artifacts.lookupAt.bind(artifacts),
    list: artifacts.list.bind(artifacts),
    read: (ref) => {
      const key = JSON.stringify(reference(ref));
      const saved = values.get(key);
      if (saved !== undefined) return Promise.resolve(saved);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const read = artifacts
        .read(ref)
        .then((value) => {
          if (value.length <= maxChars) {
            while (chars + value.length > maxChars || values.size >= 2048) {
              const oldest = values.keys().next().value;
              if (oldest === undefined) break;
              chars -= values.get(oldest)!.length;
              values.delete(oldest);
            }
            values.set(key, value);
            chars += value.length;
          }
          return value;
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, read);
      return read;
    },
  };
}

/** One bounded index per assessment, not a complete corpus scan for every claim. */
export function createLegacyResearchNeedLookup(
  artifacts: EvidenceStore,
  acceptance?: DiscoveryAcceptance,
): (need: z.infer<typeof CanonicalNeedSchema>) => Promise<LegacyNeedLookup> {
  const refs = new Set<string>();
  const retained = cachedResearchEvidenceStore(artifacts);
  const cached: EvidenceStore = {
    ...retained,
    read: (ref) => {
      const key = JSON.stringify(reference(ref));
      if (!refs.has(key) && refs.size >= 20000)
        throw new LegacyProofLimitError("research-need-legacy-read-limit");
      refs.add(key);
      return retained.read(ref);
    },
  };
  let index:
    Promise<Map<string, z.infer<typeof ResearchRequestSchema>[]>> | undefined;
  let limited = false;
  const ambiguous = new Set<string>();
  const build = async () => {
    const out = new Map<string, z.infer<typeof ResearchRequestSchema>[]>();
    let paths = 0;
    let rows = 0;
    for (let after: string | undefined; ;) {
      const page = await artifacts.list("research-jobs", 1000, after);
      paths += page.length;
      if (paths > 20000) {
        limited = true;
        return out;
      }
      for (const path of page) {
        if (!/^research-jobs\/research-[0-9a-f]{32}\/request\.json$/.test(path))
          continue;
        const ref = await artifacts.lookup(path);
        if (!ref) throw new Error("research-need-legacy-lookup-changed");
        const request = ResearchRequestSchema.parse(
          JSON.parse(await cached.read(ref)),
        );
        if (request.canonicalNeeds || request.origin !== "extraction") continue;
        rows += request.claims.length;
        if (rows > 20000) {
          limited = true;
          return out;
        }
        for (const [id, passageId] of await legacyRequestNeeds(
          cached,
          request,
        )) {
          if (passageId === undefined) ambiguous.add(id);
          else out.set(id, [...(out.get(id) ?? []), request]);
        }
      }
      if (page.length < 1000) return out;
      after = page[page.length - 1];
    }
  };
  const results = new Map<string, Promise<LegacyNeedLookup>>();
  return (need) => {
    const id = canonicalNeedId(need);
    let result = results.get(id);
    if (!result) {
      result = (async (): Promise<LegacyNeedLookup> => {
        if (need.occurrenceScope)
          return { status: "unavailable", reason: "legacy-proof-ambiguous" };
        index ??= build().catch((error) => {
          if (!(error instanceof LegacyProofLimitError)) throw error;
          limited = true;
          return new Map();
        });
        const candidates = (await index).get(id) ?? [];
        if (limited)
          return { status: "unavailable", reason: "legacy-proof-scan-bound" };
        // Validating candidates spends the same read budget as the index, so
        // running out here is the same explicit, bounded unavailability.
        try {
          for (const request of candidates) {
            const resultRef = await artifacts.lookup(
              researchJobPath(researchJobId(request), "result"),
            );
            if (!resultRef) continue;
            const saved = ResearchResultSchema.parse(
              JSON.parse(await cached.read(resultRef)),
            );
            if (saved.outcome === "failed") continue;
            const proof = await researchNeedEvidence(
              cached,
              resultRef,
              need,
              undefined,
              acceptance,
            );
            const checked = await readResearchNeedEvidence(
              cached,
              proof,
              acceptance,
            );
            if (checked.citations.length) return { status: "found", proof };
          }
        } catch (error) {
          if (!(error instanceof LegacyProofLimitError)) throw error;
          limited = true;
          return { status: "unavailable", reason: "legacy-proof-scan-bound" };
        }
        return {
          status: "unavailable",
          reason: ambiguous.has(id)
            ? "legacy-proof-ambiguous"
            : "legacy-proof-missing",
        };
      })().catch((error) => {
        if (!(error instanceof LegacyProofLimitError)) throw error;
        return {
          status: "unavailable",
          reason: "legacy-proof-scan-bound",
        } as const;
      });
      results.set(id, result);
    }
    return result;
  };
}
