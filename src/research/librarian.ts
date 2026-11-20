import { createHash } from "node:crypto";
import { z } from "zod";
import { parseThemeProposalResult, type ThemeProposalResult } from "../analysis/theme-proposals.js";
import { ClaimExtractionRecordSchema } from "../analysis/grounded-claims.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import {
  DossierStore,
  StaleDossierError,
  type Dossier,
  type DossierMetadata,
  type StoredDossier,
} from "./dossier.js";
import {
  RESEARCH_JOB_SCHEMA_VERSION,
  ResearchManifestSchema,
  type ResearchManifest,
  type ResearchRequest,
  type ResearchResult,
  writeOnce,
} from "./job.js";

/**
 * Librarian coverage integration (#217; design: doc/architecture/18-module-outline.md).
 *
 * Given one post's saved analysis (exact theme and claim results), the
 * librarian:
 * 1. shortlists existing dossiers for each proposed theme (embeddings when a
 *    compatible vector space is available, otherwise a recorded lexical
 *    fallback) and decides equivalence, recording the mapping without
 *    altering the extraction;
 * 2. accounts for every accepted claim: reuses evidence a dossier already
 *    holds, and groups the rest into one research request per dossier;
 * 3. reads each job's saved result and manifest by exact reference and
 *    records claim-by-claim coverage: evidence found, claimant-only
 *    attribution, no independent evidence after a search, research failed,
 *    or no further search commissioned;
 * 4. optionally commissions one targeted second pass for consequential gaps;
 * 5. revises the affected dossiers (expected-version checked) and saves a
 *    write-once coverage record with the exact source, analysis, job and
 *    dossier references the writer handoff (#148) needs.
 */

export const COVERAGE_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Theme shortlisting and equivalence

export interface DossierSummary {
  themeId: string;
  title: string;
  scope: string;
}

export interface DossierCandidate extends DossierSummary {
  score: number;
}

export interface Shortlist {
  method: "embedding" | "lexical";
  /** Why the preferred method was not used, when it was not. */
  limitation?: string;
  candidates: DossierCandidate[];
}

export interface ThemeShortlister {
  shortlist(
    theme: { title: string; description: string },
    dossiers: DossierSummary[],
  ): Promise<Shortlist>;
}

const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .normalize("NFKC")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );

/** Token-overlap (Jaccard) shortlist: the documented fallback when no compatible vectors exist. */
export class LexicalShortlister implements ThemeShortlister {
  constructor(private readonly limitation?: string) {}
  async shortlist(
    theme: { title: string; description: string },
    dossiers: DossierSummary[],
  ): Promise<Shortlist> {
    const t = tokens(`${theme.title} ${theme.description}`);
    const candidates = dossiers
      .map((d) => {
        const o = tokens(`${d.title} ${d.scope}`);
        const shared = [...t].filter((x) => o.has(x)).length;
        const union = new Set([...t, ...o]).size;
        return { ...d, score: union === 0 ? 0 : shared / union };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    return {
      method: "lexical",
      ...(this.limitation ? { limitation: this.limitation } : {}),
      candidates,
    };
  }
}

/** Minimal embedding surface: vectors in one declared vector space. */
export interface ThemeEmbedder {
  readonly vectorSpace: string;
  embed(texts: string[]): Promise<number[][]>;
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};

/**
 * Embedding shortlist. Only compares vectors from the configured vector
 * space; when the expected space differs or embedding fails, it falls back to
 * the lexical shortlist and records why.
 */
export class EmbeddingShortlister implements ThemeShortlister {
  constructor(
    private readonly embedder: ThemeEmbedder,
    private readonly expectedVectorSpace: string,
  ) {}
  async shortlist(
    theme: { title: string; description: string },
    dossiers: DossierSummary[],
  ): Promise<Shortlist> {
    if (this.embedder.vectorSpace !== this.expectedVectorSpace) {
      return new LexicalShortlister("incompatible vector space").shortlist(theme, dossiers);
    }
    if (dossiers.length === 0) return { method: "embedding", candidates: [] };
    let vectors: number[][];
    try {
      vectors = await this.embedder.embed([
        `${theme.title}. ${theme.description}`,
        ...dossiers.map((d) => `${d.title}. ${d.scope}`),
      ]);
    } catch {
      return new LexicalShortlister("embedding unavailable").shortlist(theme, dossiers);
    }
    const [q, ...rest] = vectors;
    const candidates = dossiers
      .map((d, i) => ({ ...d, score: cosine(q, rest[i]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    return { method: "embedding", candidates };
  }
}

/** The librarian's equivalence decision for one proposed theme. */
export interface ThemeEquivalenceJudge {
  decide(
    theme: { title: string; description: string },
    shortlist: Shortlist,
  ): Promise<{ themeId: string; rationale: string } | { themeId: null; rationale: string }>;
}

/** Threshold judge: the best candidate when its score clears the method's bar, else a new dossier. */
export class ThresholdJudge implements ThemeEquivalenceJudge {
  constructor(private readonly bars = { embedding: 0.85, lexical: 0.5 }) {}
  async decide(_theme: { title: string; description: string }, shortlist: Shortlist) {
    const best = shortlist.candidates[0];
    if (best && best.score >= this.bars[shortlist.method]) {
      return {
        themeId: best.themeId,
        rationale: `${shortlist.method} similarity ${best.score.toFixed(2)}`,
      };
    }
    return { themeId: null, rationale: "no existing dossier is equivalent" };
  }
}

/** A canonical dossier ID minted by the librarian for a new theme. */
export function newDossierId(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  const hash = createHash("sha256").update(title.trim().toLowerCase()).digest("hex").slice(0, 8);
  return `${slug || "theme"}-${hash}`;
}

// ---------------------------------------------------------------------------
// Coverage

export const CoverageStatusSchema = z.enum([
  "evidence-found",
  "claimant-only",
  "no-independent-evidence",
  "research-failed",
  "not-commissioned",
  "pending",
]);
export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;

const Ref = z
  .object({ repository: z.string(), commit: z.string(), path: z.string(), hash: z.string() })
  .strict();

export const CoverageRecordSchema = z
  .object({
    schemaVersion: z.literal(COVERAGE_SCHEMA_VERSION),
    post: z.object({ publicationId: z.string(), postId: z.string() }).strict(),
    source: Ref,
    themeResult: Ref,
    claimResult: Ref,
    mappings: z.array(
      z
        .object({
          proposalId: z.string(),
          title: z.string(),
          dossierId: z.string(),
          created: z.boolean(),
          method: z.enum(["embedding", "lexical"]),
          limitation: z.string().optional(),
          rationale: z.string(),
        })
        .strict(),
    ),
    claims: z.array(
      z
        .object({
          claimRecordId: z.string(),
          statement: z.string(),
          dossierId: z.string().nullable(),
          status: CoverageStatusSchema,
          reused: z.boolean(),
          jobIds: z.array(z.string()),
          citations: z.array(z.object({ url: z.string(), passage: z.string() }).strict()),
          reason: z.string().optional(),
        })
        .strict(),
    ),
    jobs: z.array(
      z
        .object({
          jobId: z.string(),
          dossierId: z.string(),
          pass: z.number(),
          outcome: z.string(),
          result: Ref.optional(),
          manifest: Ref.optional(),
        })
        .strict(),
    ),
    dossiers: z.array(z.object({ dossierId: z.string(), ref: Ref }).strict()),
    assessedAt: z.string(),
  })
  .strict();
export type CoverageRecord = z.infer<typeof CoverageRecordSchema>;

/** One research job as the librarian sees it: saved outcome plus exact references. */
export interface CommissionedJob {
  jobId: string;
  status: "finished" | "busy";
  result?: ResearchResult;
  resultRef?: ArtifactRef;
}

/** Runs (or reuses) a research job for a request; the researcher owns provider calls. */
export type Commission = (request: ResearchRequest) => Promise<CommissionedJob>;

const toRef = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

const ClaimText = z.looseObject({ statement: z.string().min(1) });

interface AcceptedClaim {
  claimRecordId: string;
  statement: string;
  proposalIds: string[];
}

function acceptedClaims(record: z.infer<typeof ClaimExtractionRecordSchema>): AcceptedClaim[] {
  if (record.schemaVersion !== 2) return [];
  const seen = new Map<string, AcceptedClaim>();
  for (const c of record.claims) {
    const parsed = ClaimText.safeParse(c.claim);
    if (!c.claimRecordId || !parsed.success) continue;
    const prior = seen.get(c.claimRecordId);
    const proposalIds = [...new Set([...(prior?.proposalIds ?? []), ...c.themeIds])];
    seen.set(c.claimRecordId, {
      claimRecordId: c.claimRecordId,
      statement: parsed.data.statement,
      proposalIds,
    });
  }
  return [...seen.values()];
}

/** Coverage for each request claim from a finished job's manifest. */
function assess(
  claims: AcceptedClaim[],
  job: CommissionedJob,
  manifest: ResearchManifest | undefined,
): Map<
  string,
  { status: CoverageStatus; citations: { url: string; passage: string }[]; reason?: string }
> {
  const out = new Map<
    string,
    { status: CoverageStatus; citations: { url: string; passage: string }[]; reason?: string }
  >();
  for (const claim of claims) {
    if (job.status === "busy") {
      out.set(claim.claimRecordId, {
        status: "pending",
        citations: [],
        reason: "research job in progress",
      });
      continue;
    }
    if (!job.result || job.result.outcome === "failed" || !manifest) {
      out.set(claim.claimRecordId, {
        status: "research-failed",
        citations: [],
        reason: `research failed (${job.result?.failure ?? "no result"})`,
      });
      continue;
    }
    const independent: { url: string; passage: string }[] = [];
    let claimantOnly = false;
    for (const c of manifest.citations) {
      for (const p of c.passages) {
        if (p.claimRecordId !== claim.claimRecordId) continue;
        if (c.sourceType === "monitored-source") claimantOnly = true;
        else independent.push({ url: c.url, passage: p.passage });
      }
    }
    if (independent.length > 0)
      out.set(claim.claimRecordId, { status: "evidence-found", citations: independent });
    else if (claimantOnly) {
      out.set(claim.claimRecordId, {
        status: "claimant-only",
        citations: [],
        reason: "only the claimant's own material was found",
      });
    } else {
      out.set(claim.claimRecordId, {
        status: "no-independent-evidence",
        citations: [],
        reason: "no independent supporting source was found after a search",
      });
    }
  }
  return out;
}

const citationId = (url: string, passage: string) =>
  `c-${createHash("sha256")
    .update(JSON.stringify([url, passage]))
    .digest("hex")
    .slice(0, 24)}`;

/** Merge this post's coverage into a dossier's metadata (claims replace prior entries for the same claim). */
export function mergeCoverage(
  metadata: DossierMetadata,
  claims: {
    claimRecordId: string;
    status: CoverageStatus;
    citations: { url: string; passage: string }[];
    reason?: string;
  }[],
  checkedAt: string,
): DossierMetadata {
  const citations = new Map(metadata.citations.map((c) => [c.id, c]));
  const coverage = new Map(metadata.claims.map((c) => [c.claimId, c]));
  for (const claim of claims) {
    if (claim.status === "pending") continue;
    const ids: string[] = [];
    for (const c of claim.citations) {
      if (!c.url.startsWith("https://")) continue;
      const id = citationId(c.url, c.passage);
      if (!citations.has(id)) {
        citations.set(id, {
          id,
          url: c.url,
          title: new URL(c.url).hostname,
          passage: c.passage.slice(0, 4000),
          checkedAt,
        });
      }
      ids.push(id);
    }
    coverage.set(
      claim.claimRecordId,
      claim.status === "evidence-found" && ids.length > 0
        ? { claimId: claim.claimRecordId, status: "covered", citations: [...new Set(ids)] }
        : {
            claimId: claim.claimRecordId,
            status: "gap",
            reason: `${claim.status}: ${claim.reason ?? ""}`.slice(0, 1000),
          },
    );
  }
  const gaps = [...coverage.values()]
    .filter((c) => c.status === "gap")
    .map((c) => `${c.claimId}: ${c.status === "gap" ? c.reason : ""}`.slice(0, 1000))
    .slice(0, 200);
  return {
    ...metadata,
    citations: [...citations.values()],
    claims: [...coverage.values()],
    gaps,
    updatedAt: checkedAt,
  };
}

async function saveDossier(
  store: DossierStore,
  themeId: string,
  title: string,
  update: (m: DossierMetadata) => DossierMetadata,
  now: string,
): Promise<StoredDossier> {
  for (let attempt = 0; ; attempt++) {
    const current = await store.current(themeId);
    const base: Dossier = current ?? {
      metadata: {
        schemaVersion: 1,
        themeId,
        title: title.slice(0, 200),
        scope: title.slice(0, 2000),
        claims: [],
        citations: [],
        gaps: [],
        updatedAt: now,
      },
      body: `# ${title}\n\nDossier maintained by the librarian.`,
    };
    try {
      return await store.save({ ...base, metadata: update(base.metadata) }, current?.ref);
    } catch (error) {
      if (error instanceof StaleDossierError && attempt < 3) continue;
      throw error;
    }
  }
}

/**
 * Assess one post's coverage end to end. Re-running with the same saved
 * analysis reuses finished jobs (the researcher never repeats a provider
 * call) and re-derives the same coverage; a job still running is reported as
 * `pending` and its claims are left out of the dossier until a later run.
 */
export async function assessPostCoverage(input: {
  artifacts: GitArtifactStore;
  themeResult: ArtifactRef;
  claimResult: ArtifactRef;
  commission: Commission;
  shortlister: ThemeShortlister;
  judge?: ThemeEquivalenceJudge;
  /** Claims whose remaining gap could materially change the writer's account. */
  consequential?: (claim: { claimRecordId: string; statement: string }) => boolean;
  now?: () => Date;
}): Promise<{ record: CoverageRecord; ref: ArtifactRef }> {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const judge = input.judge ?? new ThresholdJudge();
  const themes: ThemeProposalResult = parseThemeProposalResult(
    JSON.parse(await input.artifacts.read(input.themeResult)),
  );
  const claimRecord = ClaimExtractionRecordSchema.parse(
    JSON.parse(await input.artifacts.read(input.claimResult)),
  );
  const post = { publicationId: themes.post.publicationId, postId: themes.post.postId };
  if (
    claimRecord.post.publicationId !== post.publicationId ||
    claimRecord.post.postId !== post.postId
  ) {
    throw new Error("theme and claim results belong to different posts");
  }
  const dossiers = new DossierStore(input.artifacts);
  const summaries: DossierSummary[] = [];
  const existing = new Map<string, StoredDossier>();
  for (const path of await input.artifacts.list("dossier", 1000)) {
    const id = /^dossier\/([^/]+)\.md$/.exec(path)?.[1];
    if (!id) continue;
    const d = await dossiers.current(id).catch(() => undefined);
    if (!d) continue;
    existing.set(id, d);
    summaries.push({ themeId: id, title: d.metadata.title, scope: d.metadata.scope });
  }

  // 1. Map proposed themes to dossiers.
  const mappings: CoverageRecord["mappings"] = [];
  const dossierFor = new Map<string, string>();
  const titles = new Map<string, string>();
  for (const proposal of themes.proposals) {
    const p = { ...proposal, description: proposal.description ?? "" };
    const shortlist = await input.shortlister.shortlist(p, summaries);
    const decision = await judge.decide(p, shortlist);
    const dossierId = decision.themeId ?? newDossierId(p.title);
    dossierFor.set(p.id, dossierId);
    titles.set(dossierId, existing.get(dossierId)?.metadata.title ?? p.title);
    mappings.push({
      proposalId: p.id,
      title: p.title,
      dossierId,
      created: decision.themeId === null && !existing.has(dossierId),
      method: shortlist.method,
      ...(shortlist.limitation ? { limitation: shortlist.limitation } : {}),
      rationale: decision.rationale,
    });
  }

  // 2. Account for every accepted claim: reuse, or group by dossier for research.
  const claims = acceptedClaims(claimRecord);
  const outcomes = new Map<string, CoverageRecord["claims"][number]>();
  const groups = new Map<string, AcceptedClaim[]>();
  for (const claim of claims) {
    const home = claim.proposalIds.map((id) => dossierFor.get(id)).find(Boolean) ?? null;
    if (!home) {
      outcomes.set(claim.claimRecordId, {
        claimRecordId: claim.claimRecordId,
        statement: claim.statement,
        dossierId: null,
        status: "not-commissioned",
        reused: false,
        jobIds: [],
        citations: [],
        reason: "claim is not linked to a mapped theme",
      });
      continue;
    }
    const prior = existing
      .get(home)
      ?.metadata.claims.find((c) => c.claimId === claim.claimRecordId);
    if (prior?.status === "covered") {
      const cites = existing
        .get(home)!
        .metadata.citations.filter((c) => prior.citations.includes(c.id));
      outcomes.set(claim.claimRecordId, {
        claimRecordId: claim.claimRecordId,
        statement: claim.statement,
        dossierId: home,
        status: "evidence-found",
        reused: true,
        jobIds: [],
        citations: cites.map((c) => ({ url: c.url, passage: c.passage })),
      });
      continue;
    }
    groups.set(home, [...(groups.get(home) ?? []), claim]);
  }

  // 3. Commission one request per dossier, then assess from exact saved results.
  const jobs: CoverageRecord["jobs"] = [];
  const postRefs = {
    publicationId: post.publicationId,
    postId: post.postId,
    sourceArtifact: themes.artifact,
    themeResult: toRef(input.themeResult),
    claimResult: toRef(input.claimResult),
  };
  const run = async (
    dossierId: string,
    group: AcceptedClaim[],
    pass: number,
    previousJobId?: string,
  ) => {
    const request: ResearchRequest = {
      schemaVersion: RESEARCH_JOB_SCHEMA_VERSION,
      origin: "extraction",
      pass,
      ...(previousJobId ? { previousJobId } : {}),
      post: postRefs,
      claims: group.map((c) => ({
        claimRecordId: c.claimRecordId,
        statement: c.statement,
        themeIds: [dossierId],
      })),
      question:
        pass === 1
          ? `What do independent, authoritative sources establish about these claims concerning ${titles.get(dossierId)}?`
          : "Targeted follow-up: find primary or authoritative sources that directly address these specific claims, which an earlier search could not support.",
      // Request identity depends only on the saved analysis and claims, never on
      // the dossier version this run may itself revise, so reassessing the same
      // analysis reuses the same job instead of commissioning new research.
      corpusRefs: [],
    };
    const job = await input.commission(request);
    let manifest: ResearchManifest | undefined;
    let manifestRef: ArtifactRef | undefined;
    if (job.status === "finished" && job.result?.manifest) {
      manifestRef = await input.artifacts.lookup(job.result.manifest.path);
      if (manifestRef)
        manifest = ResearchManifestSchema.parse(
          JSON.parse(await input.artifacts.read(manifestRef)),
        );
    }
    jobs.push({
      jobId: job.jobId,
      dossierId,
      pass,
      outcome: job.status === "busy" ? "pending" : (job.result?.outcome ?? "unknown"),
      ...(job.resultRef ? { result: toRef(job.resultRef) } : {}),
      ...(manifestRef ? { manifest: toRef(manifestRef) } : {}),
    });
    return { job, assessed: assess(group, job, manifest) };
  };

  for (const [dossierId, group] of groups) {
    const first = await run(dossierId, group, 1);
    for (const claim of group) {
      const a = first.assessed.get(claim.claimRecordId)!;
      outcomes.set(claim.claimRecordId, {
        claimRecordId: claim.claimRecordId,
        statement: claim.statement,
        dossierId,
        reused: false,
        jobIds: [first.job.jobId],
        ...a,
        ...(a.reason ? { reason: a.reason } : {}),
      });
    }
    // 4. One targeted second pass for consequential, unsupported claims.
    const followUp = group.filter(
      (c) =>
        outcomes.get(c.claimRecordId)?.status === "no-independent-evidence" &&
        (input.consequential?.(c) ?? false),
    );
    if (followUp.length > 0 && first.job.status === "finished") {
      const second = await run(dossierId, followUp, 2, first.job.jobId);
      for (const claim of followUp) {
        const a = second.assessed.get(claim.claimRecordId)!;
        const prior = outcomes.get(claim.claimRecordId)!;
        outcomes.set(claim.claimRecordId, {
          ...prior,
          jobIds: [...prior.jobIds, second.job.jobId],
          // Evidence from the second pass replaces the gap; a pending or failed
          // second pass is recorded as such rather than hidden behind pass 1.
          ...(a.status === "evidence-found"
            ? { status: a.status, citations: a.citations, reason: undefined }
            : a.status === "pending" || a.status === "research-failed"
              ? { status: a.status, citations: [], reason: `second pass: ${a.reason ?? a.status}` }
              : {}),
        });
      }
    }
  }

  // 5. Revise affected dossiers, then save the coverage record.
  const dossierRefs: CoverageRecord["dossiers"] = [];
  const byDossier = new Map<string, CoverageRecord["claims"]>();
  for (const o of outcomes.values()) {
    if (o.dossierId && !o.reused && o.status !== "pending") {
      byDossier.set(o.dossierId, [...(byDossier.get(o.dossierId) ?? []), o]);
    }
  }
  for (const [dossierId, items] of byDossier) {
    const saved = await saveDossier(
      dossiers,
      dossierId,
      titles.get(dossierId) ?? dossierId,
      (m) => mergeCoverage(m, items, now),
      now,
    );
    dossierRefs.push({ dossierId, ref: toRef(saved.ref) });
  }
  for (const [id, d] of existing) {
    if (!byDossier.has(id) && [...outcomes.values()].some((o) => o.dossierId === id)) {
      dossierRefs.push({ dossierId: id, ref: toRef(d.ref) });
    }
  }

  const record = CoverageRecordSchema.parse({
    schemaVersion: COVERAGE_SCHEMA_VERSION,
    post,
    source: themes.artifact,
    themeResult: toRef(input.themeResult),
    claimResult: toRef(input.claimResult),
    mappings,
    claims: [...outcomes.values()].map((o) => {
      const { reason, ...rest } = o;
      return reason ? { ...rest, reason } : rest;
    }),
    jobs,
    dossiers: dossierRefs.sort((a, b) => a.dossierId.localeCompare(b.dossierId)),
    assessedAt: now,
  });
  const key = createHash("sha256")
    .update(JSON.stringify([record.themeResult, record.claimResult, record.jobs, record.dossiers]))
    .digest("hex")
    .slice(0, 32);
  const ref = await writeOnce(
    input.artifacts,
    `librarian/coverage/${post.publicationId}/${post.postId}/${key}.json`,
    record,
  );
  return { record, ref };
}
