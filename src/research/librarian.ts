import { createHash } from "node:crypto";
import { z } from "zod";
import { parseThemeProposalResult, type ThemeProposalResult } from "../analysis/theme-proposals.js";
import { canonicalOf } from "../analysis/claim-equivalence.js";
import { ThemeMappingCatalogue } from "./theme-mappings.js";
import { listCanonicalThemes, ThemeStore } from "./theme-store.js";
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
  ResearchResultSchema,
  researchJobId,
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
    const width = vectors[0]?.length ?? 0;
    const valid =
      Array.isArray(vectors) &&
      vectors.length === dossiers.length + 1 &&
      width > 0 &&
      vectors.every((v) => Array.isArray(v) && v.length === width && v.every(Number.isFinite));
    if (!valid)
      return new LexicalShortlister("embedding response invalid").shortlist(theme, dossiers);
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
  async decide(theme: { title: string; description: string }, shortlist: Shortlist) {
    // A dossier with the identical title is the same theme for this default judge;
    // a judge that understands meaning may still reject a homonym.
    const same = (x: string) => x.normalize("NFKC").trim().toLowerCase();
    const identical = shortlist.candidates.find((c) => same(c.title) === same(theme.title));
    if (identical) return { themeId: identical.themeId, rationale: "identical title" };
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
    sourceContext: Ref.optional(),
    themeResult: Ref,
    claimResult: Ref,
    mappings: z.array(
      z
        .object({
          proposalId: z.string(),
          title: z.string(),
          dossierId: z.string(),
          created: z.boolean(),
          method: z.enum(["embedding", "lexical", "catalogue"]),
          limitation: z.string().optional(),
          rationale: z.string(),
          /**
           * The exact saved mapping version used or recorded (#518). A later
           * correction revises the file; this pin keeps reading the original.
           */
          mappingRef: Ref.optional(),
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
          evidenceFrom: z
            .object({ dossier: Ref, citationIds: z.array(z.string()) })
            .strict()
            .optional(),
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
    /** Dossiers whose revision failed in this run; rerun to apply them. */
    unsavedDossiers: z.array(z.string()).optional(),
    assessedAt: z.string(),
  })
  .strict();
export type CoverageRecord = z.infer<typeof CoverageRecordSchema>;

/** One research job as the librarian sees it: saved outcome plus exact references. */
export interface CommissionedJob {
  jobId: string;
  status: "finished" | "busy" | "not-commissioned";
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
  /** The extraction's own claim ID: the internal key, stable across later merges. */
  key: string;
  /** Current canonical claim identity: coverage and reuse are judged under it. */
  claimRecordId: string;
  statement: string;
  proposalIds: string[];
  /**
   * The extraction's own claim IDs and statements. Research requests are built
   * from these, so a later claim merge cannot change a request's identity.
   */
  extracted: { claimRecordId: string; statement: string }[];
}

function acceptedClaims(record: z.infer<typeof ClaimExtractionRecordSchema>): AcceptedClaim[] {
  // Versions 2 and 3 share the accepted/candidate contract; version 1 is legacy.
  if (record.schemaVersion < 2) return [];
  const seen = new Map<string, AcceptedClaim>();
  for (const c of record.claims) {
    const parsed = ClaimText.safeParse(c.claim);
    if (!c.claimRecordId || !parsed.success) continue;
    const prior = seen.get(c.claimRecordId);
    const proposalIds = [...new Set([...(prior?.proposalIds ?? []), ...c.themeIds])];
    seen.set(c.claimRecordId, {
      key: c.claimRecordId,
      extracted: [{ claimRecordId: c.claimRecordId, statement: parsed.data.statement }],
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
    if (job.status === "not-commissioned") {
      out.set(claim.key, {
        status: "not-commissioned",
        citations: [],
        reason: "article research request limit reached",
      });
      continue;
    }
    if (job.status === "busy") {
      out.set(claim.key, {
        status: "pending",
        citations: [],
        reason: "research job in progress",
      });
      continue;
    }
    if (!job.result || job.result.outcome === "failed" || !manifest) {
      out.set(claim.key, {
        status: "research-failed",
        citations: [],
        reason: `research failed (${job.result?.failure ?? "no result"})`,
      });
      continue;
    }
    const independent: { url: string; passage: string }[] = [];
    let claimantOnly = false;
    let insecureOnly = false;
    for (const c of manifest.citations) {
      for (const p of c.passages) {
        if (
          p.claimRecordId !== claim.claimRecordId &&
          !claim.extracted.some((e) => e.claimRecordId === p.claimRecordId)
        )
          continue;
        if (c.sourceType === "monitored-source") claimantOnly = true;
        // Dossier citations are https-only; plain-http support is not recorded as evidence.
        // Only passages the researcher verified as supporting count as evidence.
        else if (c.url.startsWith("https://") && c.support === "supported")
          independent.push({ url: c.url, passage: p.passage });
        else insecureOnly = true;
      }
    }
    if (independent.length > 0)
      out.set(claim.key, { status: "evidence-found", citations: independent });
    else if (claimantOnly) {
      out.set(claim.key, {
        status: "claimant-only",
        citations: [],
        reason: "only the claimant's own material was found",
      });
    } else {
      out.set(claim.key, {
        status: "no-independent-evidence",
        citations: [],
        reason: insecureOnly
          ? "supporting passages were found only on non-https sources, which are not recorded"
          : "no independent supporting source was found after a search",
      });
    }
  }
  return out;
}

/** Schema limit on claims and citations held by one dossier. */
const MAX_DOSSIER_ENTRIES = 1000;
/** Schema limit on citations per covered claim. */
const MAX_CLAIM_CITATIONS = 50;
/** The researcher's per-request claim limit. */
const MAX_REQUEST_CLAIMS = 100;

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
  const overflow: string[] = [];
  for (const claim of claims) {
    if (claim.status === "pending") continue;
    // Never let a later failed or unsupported assessment erase evidence another
    // assessment has already saved for the same claim.
    const saved = coverage.get(claim.claimRecordId);
    if (saved?.status === "covered" && claim.status !== "evidence-found") continue;
    if (!saved && coverage.size >= MAX_DOSSIER_ENTRIES) {
      overflow.push(claim.claimRecordId);
      continue;
    }
    const ids: string[] = [];
    for (const c of claim.citations) {
      // Stop at the per-claim limit before adding anything to the dossier.
      if (ids.length >= MAX_CLAIM_CITATIONS) break;
      if (!c.url.startsWith("https://")) continue;
      const id = citationId(c.url, c.passage);
      if (!citations.has(id) && citations.size >= MAX_DOSSIER_ENTRIES) continue;
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
    // New evidence that cannot be stored (capacity) never downgrades saved coverage.
    if (saved?.status === "covered" && ids.length === 0) continue;
    coverage.set(
      claim.claimRecordId,
      claim.status === "evidence-found" && ids.length > 0
        ? {
            claimId: claim.claimRecordId,
            status: "covered",
            // The dossier schema allows at most 50 citations per claim.
            citations: [...new Set(ids)].slice(0, MAX_CLAIM_CITATIONS),
          }
        : {
            claimId: claim.claimRecordId,
            status: "gap",
            reason: `${claim.status}: ${claim.reason ?? ""}`.slice(0, 1000),
          },
    );
  }
  const gaps = [
    ...(overflow.length > 0
      ? [
          `Dossier capacity reached: ${overflow.length} claim(s) recorded only in their coverage records.`,
        ]
      : []),
    ...[...coverage.values()]
      .filter((c) => c.status === "gap")
      .map((c) => `${c.claimId}: ${c.status === "gap" ? c.reason : ""}`.slice(0, 1000)),
  ].slice(0, 200);
  return {
    ...metadata,
    citations: [...citations.values()],
    claims: [...coverage.values()],
    gaps,
    updatedAt: checkedAt,
  };
}

/** Theme mappings saved by an earlier assessment of exactly this analysis. */
async function priorMappings(
  artifacts: GitArtifactStore,
  post: { publicationId: string; postId: string },
  themeResult: ArtifactRef,
  claimResult: ArtifactRef,
  jobIds?: Set<string>,
): Promise<Map<string, CoverageRecord["mappings"][number]>> {
  const out = new Map<string, CoverageRecord["mappings"][number]>();
  const paths = await artifacts.list(
    `librarian/coverage/${post.publicationId}/${post.postId}`,
    1000,
  );
  for (const path of paths) {
    const ref = await artifacts.lookup(path);
    if (!ref) continue;
    const parsed = CoverageRecordSchema.safeParse(JSON.parse(await artifacts.read(ref)));
    if (!parsed.success) continue;
    const r = parsed.data;
    const same = (a: { commit: string; path: string }, b: ArtifactRef) =>
      a.commit === b.commit && a.path === b.path;
    if (!same(r.themeResult, themeResult) || !same(r.claimResult, claimResult)) continue;
    for (const m of r.mappings) if (!out.has(m.proposalId)) out.set(m.proposalId, m);
    for (const j of r.jobs) jobIds?.add(j.jobId);
  }
  return out;
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
  if (
    claimRecord.themeResult &&
    claimRecord.themeResult !== `${input.themeResult.commit}:${input.themeResult.path}`
  ) {
    throw new Error("claim result was extracted against a different theme result");
  }
  if (claimRecord.sourceVersion !== themes.sourceVersion) {
    throw new Error("theme and claim results describe different source versions");
  }
  const dossiers = new DossierStore(input.artifacts);
  const summaries: DossierSummary[] = [];
  const existing = new Map<string, StoredDossier>();
  const paths: string[] = [];
  for (let after: string | undefined; ;) {
    const page = await input.artifacts.list("dossier", 1000, after);
    paths.push(...page);
    if (page.length < 1000) break;
    after = page[page.length - 1];
  }
  for (const path of paths) {
    const id = /^dossier\/([^/]+)\.md$/.exec(path)?.[1];
    if (!id) continue;
    // An unreadable canonical dossier is a failure, not an absence: treating it
    // as missing could duplicate the theme or commission needless research.
    const d = await dossiers.current(id);
    if (!d) continue;
    existing.set(id, d);
    summaries.push({ themeId: id, title: d.metadata.title, scope: d.metadata.scope });
  }
  // Canonical themes exist without research (#528): an established theme with
  // no dossier yet is still a mapping target, so it is never duplicated.
  const established = new Set(existing.keys());
  for (const theme of await listCanonicalThemes(new ThemeStore(input.artifacts))) {
    established.add(theme.id);
    if (existing.has(theme.id)) continue;
    summaries.push({
      themeId: theme.id,
      title: theme.title,
      scope: theme.description ?? theme.title,
    });
  }

  // 1. Map proposed themes to dossiers.
  const mappings: CoverageRecord["mappings"] = [];
  const dossierFor = new Map<string, string>();
  const titles = new Map<string, string>();
  /** Research subject per dossier from this analysis's own proposals (never editable dossier titles). */
  const subjects = new Map<string, string>();
  // Reassessing the same analysis reuses the mapping its earlier run saved,
  // so shortlist or judge changes cannot move a theme to another dossier.
  // Jobs an earlier assessment of this exact analysis commissioned (#658):
  // reassessment repeats the same request rather than switching mode.
  const priorJobIds = new Set<string>();
  const savedMapping = await priorMappings(
    input.artifacts,
    post,
    input.themeResult,
    input.claimResult,
    priorJobIds,
  );
  const catalogue = new ThemeMappingCatalogue(input.artifacts);
  // Canonical themes exist independently of research (#528).
  const themeStore = new ThemeStore(input.artifacts);
  for (const proposal of themes.proposals) {
    const p = { ...proposal, description: proposal.description ?? "" };
    const kept = savedMapping.get(p.id);
    if (kept) {
      dossierFor.set(p.id, kept.dossierId);
      titles.set(kept.dossierId, existing.get(kept.dossierId)?.metadata.title ?? p.title);
      if (!subjects.has(kept.dossierId)) subjects.set(kept.dossierId, p.title);
      mappings.push({ ...kept, created: kept.created && !existing.has(kept.dossierId) });
      // Coverage from before canonical themes existed still establishes one.
      await themeStore.ensure({
        id: kept.dossierId,
        title: existing.get(kept.dossierId)?.metadata.title ?? kept.title,
        createdAt: now,
      });
      continue;
    }
    // A decision made for the same proposal on another post is reused instead
    // of recalculated, as long as its canonical dossier still exists (#518).
    const pinned = await catalogue.current({
      proposal: p.title,
      ...(p.description ? { description: p.description } : {}),
    });
    const catalogued = pinned?.mapping;
    if (pinned && catalogued && established.has(catalogued.canonicalThemeId)) {
      const dossierId = catalogued.canonicalThemeId;
      if (!subjects.has(dossierId)) subjects.set(dossierId, p.title);
      dossierFor.set(p.id, dossierId);
      titles.set(dossierId, existing.get(dossierId)?.metadata.title ?? p.title);
      mappings.push({
        proposalId: p.id,
        title: p.title,
        dossierId,
        created: false,
        method: "catalogue",
        rationale: `reused saved catalogue decision (${catalogued.key})`,
        mappingRef: toRef(pinned.ref),
      });
      await themeStore.ensure({
        id: dossierId,
        title: existing.get(dossierId)?.metadata.title ?? p.title,
        ...(p.description ? { description: p.description } : {}),
        createdAt: now,
      });
      continue;
    }
    const shortlist = await input.shortlister.shortlist(p, summaries);
    const decision = await judge.decide(p, shortlist);
    let dossierId = decision.themeId ?? newDossierId(p.title);
    // A rejected equivalence must never land in the existing dossier it rejected.
    for (let n = 2; decision.themeId === null && established.has(dossierId); n++) {
      dossierId = newDossierId(`${p.title}#${n}`);
    }
    if (!subjects.has(dossierId)) subjects.set(dossierId, p.title);
    dossierFor.set(p.id, dossierId);
    titles.set(dossierId, existing.get(dossierId)?.metadata.title ?? p.title);
    mappings.push({
      proposalId: p.id,
      title: p.title,
      dossierId,
      created: decision.themeId === null && !established.has(dossierId),
      method: shortlist.method,
      ...(shortlist.limitation ? { limitation: shortlist.limitation } : {}),
      rationale: decision.rationale,
    });
    await themeStore.ensure({
      id: dossierId,
      title: existing.get(dossierId)?.metadata.title ?? p.title,
      ...(p.description ? { description: p.description } : {}),
      createdAt: now,
    });
    // Only an accepted equivalence teaches the catalogue: a new dossier is
    // this post's own invention and must not become a global default.
    if (decision.themeId !== null) {
      const recorded = await catalogue.recordPinned({
        proposal: p.title,
        ...(p.description ? { description: p.description } : {}),
        canonicalThemeId: dossierId,
        decidedAt: now,
        decidedBy: { publicationId: post.publicationId, postId: post.postId },
        rationale: decision.rationale.slice(0, 1000),
        method: shortlist.method,
        source: { themeResult: toRef(input.themeResult), proposalId: p.id.slice(0, 200) },
      });
      const winner = recorded.mapping;
      // Pin exactly the stored version this post's coverage now depends on.
      mappings[mappings.length - 1]!.mappingRef = toRef(recorded.ref);
      // A concurrent assessment may have stored a different winner. It is
      // authoritative: this mapping must not diverge from it.
      if (
        winner.status !== "unresolved" &&
        winner.canonicalThemeId !== dossierId &&
        established.has(winner.canonicalThemeId)
      ) {
        const saved = mappings[mappings.length - 1]!;
        saved.dossierId = winner.canonicalThemeId;
        saved.method = "catalogue";
        saved.created = false;
        saved.rationale = "reconciled to the saved catalogue winner";
        dossierFor.set(p.id, winner.canonicalThemeId);
        // The research subject follows the dossier this mapping now points at.
        if (!subjects.has(winner.canonicalThemeId)) subjects.set(winner.canonicalThemeId, p.title);
      }
    }
  }

  // 2. Account for every accepted claim: reuse, or group by dossier for research.
  // Account for claims under their current canonical identity: an extracted
  // claim later merged into an earlier one is covered by the canonical record.
  const claims: AcceptedClaim[] = [];
  const byCanonical = new Map<string, AcceptedClaim>();
  for (const c of acceptedClaims(claimRecord)) {
    const canonical = await canonicalOf(input.artifacts, c.claimRecordId);
    // One entry per extracted claim: grouping and request limits follow the
    // extraction, so later merges cannot regroup or resize requests.
    const entry = { ...c, claimRecordId: canonical };
    byCanonical.set(c.key, entry);
    claims.push(entry);
  }
  const outcomes = new Map<string, CoverageRecord["claims"][number]>();
  const groups = new Map<string, AcceptedClaim[]>();
  for (const claim of claims) {
    const home = claim.proposalIds.map((id) => dossierFor.get(id)).find(Boolean) ?? null;
    if (!home) {
      outcomes.set(claim.key, {
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
    // Reuse evidence from any dossier this claim is mapped to, home first.
    const mapped = [
      ...new Set(
        claim.proposalIds.map((id) => dossierFor.get(id)).filter((x): x is string => Boolean(x)),
      ),
    ];
    let homeDossier: StoredDossier | undefined;
    let prior: DossierMetadata["claims"][number] | undefined;
    for (const id of mapped) {
      const d = existing.get(id);
      // Coverage may be stored under the canonical ID or the extracted (merged-away) one.
      const c = d?.metadata.claims.find(
        (x) => x.claimId === claim.claimRecordId || x.claimId === claim.key,
      );
      if (d && c?.status === "covered") {
        homeDossier = d;
        prior = c;
        break;
      }
    }
    if (homeDossier && prior?.status === "covered") {
      const cites = homeDossier.metadata.citations.filter((c) => prior.citations.includes(c.id));
      outcomes.set(claim.key, {
        claimRecordId: claim.claimRecordId,
        statement: claim.statement,
        dossierId: homeDossier.metadata.themeId,
        status: "evidence-found",
        reused: true,
        jobIds: [],
        citations: cites.map((c) => ({ url: c.url, passage: c.passage })),
        // The exact dossier version the reused evidence was read from.
        evidenceFrom: { dossier: toRef(homeDossier.ref), citationIds: prior.citations },
      });
    }
    // Every claim stays in its dossier's group, so the request for this
    // analysis is identical on every assessment (reused claims included).
    groups.set(home, [...(groups.get(home) ?? []), claim]);
  }

  // 3. Commission one request per dossier, then assess from exact saved results.
  const jobs: CoverageRecord["jobs"] = [];
  const postRefs = {
    publicationId: post.publicationId,
    postId: post.postId,
    sourceArtifact: themes.artifact,
    ...((claimRecord.sourceContext ?? themes.sourceContext)
      ? { sourceContext: claimRecord.sourceContext ?? themes.sourceContext }
      : {}),
    themeResult: toRef(input.themeResult),
    claimResult: toRef(input.claimResult),
  };
  const run = async (
    dossierId: string,
    group: AcceptedClaim[],
    pass: number,
    previousJobId?: string,
    /**
     * Targeted enhancement of an already researched theme (#658): identity is
     * the theme and the claims needing evidence only, never the byline,
     * source context or extraction identifiers of this post (kept as audit
     * provenance in the coverage record instead).
     */
    targeted = false,
  ) => {
    const request = buildRequest(dossierId, group, pass, previousJobId, targeted);
    return commissionAndAssess(dossierId, group, pass, request);
  };
  function buildRequest(
    dossierId: string,
    group: AcceptedClaim[],
    pass: number,
    previousJobId: string | undefined,
    targeted: boolean,
  ): ResearchRequest {
    return {
      schemaVersion: RESEARCH_JOB_SCHEMA_VERSION,
      origin: targeted ? "theme" : "extraction",
      pass,
      ...(previousJobId ? { previousJobId } : {}),
      ...(targeted ? {} : { post: postRefs }),
      claims: group
        .flatMap((c) => c.extracted)
        .map((e) => ({
          claimRecordId: e.claimRecordId,
          statement: e.statement,
          themeIds: [dossierId],
        })),
      question: targeted
        ? `Targeted enhancement of existing research on ${dossierId}: find independent, authoritative sources that directly address these specific claims, which the theme's saved research does not yet support.`
        : pass === 1
          ? `What do independent, authoritative sources establish about these claims concerning ${subjects.get(dossierId)}?`
          : "Targeted follow-up: find primary or authoritative sources that directly address these specific claims, which an earlier search could not support.",
      // Request identity depends only on the saved analysis and claims, never on
      // the dossier version this run may itself revise, so reassessing the same
      // analysis reuses the same job instead of commissioning new research.
      corpusRefs: [],
    };
  }
  async function commissionAndAssess(
    dossierId: string,
    group: AcceptedClaim[],
    pass: number,
    request: ResearchRequest,
  ) {
    const commissioned = await input.commission(request);
    // Assess the saved result and manifest through their exact pinned
    // references, never an in-memory copy or whatever a path holds now.
    const job: CommissionedJob = commissioned.resultRef
      ? {
          ...commissioned,
          result: ResearchResultSchema.parse(
            JSON.parse(await input.artifacts.read(commissioned.resultRef)),
          ),
        }
      : commissioned;
    let manifest: ResearchManifest | undefined;
    let manifestRef: ArtifactRef | undefined;
    if (job.status === "finished" && job.result?.manifest) {
      const m = job.result.manifest;
      manifestRef = {
        repository: m.repository,
        commit: m.commit,
        path: m.path,
        sha256: m.hash.replace(/^sha256:/, ""),
      };
      manifest = ResearchManifestSchema.parse(JSON.parse(await input.artifacts.read(manifestRef)));
    }
    jobs.push({
      jobId: job.jobId,
      dossierId,
      pass,
      outcome:
        job.status === "finished"
          ? (job.result?.outcome ?? "unknown")
          : job.status === "busy"
            ? "pending"
            : job.status,
      ...(job.resultRef ? { result: toRef(job.resultRef) } : {}),
      ...(manifestRef ? { manifest: toRef(manifestRef) } : {}),
    });
    return { job, assessed: assess(group, job, manifest) };
  }

  for (const [dossierId, all] of groups) {
    // Nothing to research when every claim is already covered.
    if (all.every((c) => outcomes.get(c.key)?.reused)) continue;
    // A theme that already has saved research is not researched again from
    // scratch because this post's byline, context, claim order or extraction
    // IDs differ (#658): its covered claims are reused above, and only the
    // claims that still need evidence get one bounded, targeted request.
    const saved = existing.get(dossierId);
    const sortedAll = [...all].sort((a, b) => a.key.localeCompare(b.key));
    const fullRequestedBefore = chunks(sortedAll).some((g) =>
      priorJobIds.has(researchJobId(buildRequest(dossierId, g, 1, undefined, false))),
    );
    if (saved && saved.metadata.claims.length > 0 && !fullRequestedBefore) {
      const needs = [...all]
        .filter((c) => !outcomes.get(c.key)?.reused)
        .sort((a, b) => a.claimRecordId.localeCompare(b.claimRecordId));
      for (let start = 0; start < needs.length; start += MAX_REQUEST_CLAIMS) {
        await enhanceGroup(dossierId, needs.slice(start, start + MAX_REQUEST_CLAIMS));
      }
      continue;
    }
    for (const g of chunks(sortedAll)) await assessGroup(dossierId, g);
  }

  function chunks(list: AcceptedClaim[]): AcceptedClaim[][] {
    const out: AcceptedClaim[][] = [];
    for (let start = 0; start < list.length; start += MAX_REQUEST_CLAIMS)
      out.push(list.slice(start, start + MAX_REQUEST_CLAIMS));
    return out;
  }

  async function enhanceGroup(dossierId: string, group: AcceptedClaim[]) {
    const targeted = await run(dossierId, group, 1, undefined, true);
    for (const claim of group) {
      const a = targeted.assessed.get(claim.key)!;
      // Only what this targeted research supports counts: reused theme
      // research is never presented as covering a new claim.
      outcomes.set(claim.key, {
        claimRecordId: claim.claimRecordId,
        statement: claim.statement,
        dossierId,
        reused: false,
        jobIds: [targeted.job.jobId],
        ...a,
        ...(a.reason ? { reason: a.reason } : {}),
      });
    }
  }

  async function assessGroup(dossierId: string, group: AcceptedClaim[]) {
    const first = await run(dossierId, group, 1);
    for (const claim of group) {
      if (outcomes.get(claim.key)?.reused) continue;
      const a = first.assessed.get(claim.key)!;
      outcomes.set(claim.key, {
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
    // Derived from the pass-1 job's saved result only (never from reuse in
    // the dossier), so reassessment rebuilds the identical pass-2 request.
    const followUp = group.filter(
      (c) =>
        first.assessed.get(c.key)?.status === "no-independent-evidence" &&
        (input.consequential?.(c) ?? false),
    );
    if (followUp.length > 0 && first.job.status === "finished") {
      const second = await run(dossierId, followUp, 2, first.job.jobId);
      for (const claim of followUp) {
        if (outcomes.get(claim.key)?.reused) continue;
        const a = second.assessed.get(claim.key)!;
        const prior = outcomes.get(claim.key)!;
        outcomes.set(claim.key, {
          ...prior,
          jobIds: [...prior.jobIds, second.job.jobId],
          // Evidence from the second pass replaces the gap; a pending or failed
          // second pass is recorded as such rather than hidden behind pass 1.
          ...(a.status === "evidence-found"
            ? { status: a.status, citations: a.citations, reason: undefined }
            : a.status === "pending" ||
                a.status === "research-failed" ||
                a.status === "claimant-only"
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
  // Save every affected dossier; a failure must not lose the job references
  // already gathered, so the coverage record is still written, listing what
  // was not saved, before the failure is reported.
  const unsaved: string[] = [];
  let saveError: unknown;
  for (const [dossierId, items] of byDossier) {
    try {
      const saved = await saveDossier(
        dossiers,
        dossierId,
        titles.get(dossierId) ?? dossierId,
        (m) => mergeCoverage(m, items, now),
        now,
      );
      dossierRefs.push({ dossierId, ref: toRef(saved.ref) });
    } catch (error) {
      unsaved.push(dossierId);
      saveError ??= error;
    }
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
    ...((claimRecord.sourceContext ?? themes.sourceContext)
      ? { sourceContext: claimRecord.sourceContext ?? themes.sourceContext }
      : {}),
    themeResult: toRef(input.themeResult),
    claimResult: toRef(input.claimResult),
    mappings,
    claims: [...outcomes.values()].map((o) => {
      const { reason, ...rest } = o;
      return reason ? { ...rest, reason } : rest;
    }),
    jobs,
    dossiers: dossierRefs.sort((a, b) => a.dossierId.localeCompare(b.dossierId)),
    ...(unsaved.length > 0 ? { unsavedDossiers: unsaved.sort() } : {}),
    assessedAt: now,
  });
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        record.themeResult,
        record.claimResult,
        record.mappings,
        record.jobs,
        record.dossiers,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  const ref = await writeOnce(
    input.artifacts,
    `librarian/coverage/${post.publicationId}/${post.postId}/${key}.json`,
    record,
  );
  // An unchanged reassessment maps to an earlier record; return what is stored there.
  const stored = CoverageRecordSchema.parse(JSON.parse(await input.artifacts.read(ref)));
  if (saveError) throw saveError;
  return { record: stored, ref };
}
