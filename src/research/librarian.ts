import { canonicalNeedId, CanonicalNeedSchema } from "./canonical-need.js";
import { researchNeedBindings, retainResearchNeedBindings } from "./need-bindings.js";
import {
  researchNeedEvidence,
  cachedResearchEvidenceStore,
  createLegacyResearchNeedLookup,
  readResearchNeedEvidence,
  type ResearchNeedEvidence,
} from "./need-evidence.js";
import { loadPromptFile } from "../prompt-files.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseThemeProposalResult, type ThemeProposalResult } from "../analysis/theme-proposals.js";
import { canonicalOf } from "../analysis/claim-equivalence.js";
import { ThemeMappingCatalogue, normaliseMappingKey } from "./theme-mappings.js";
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
  ResearchWarningsSchema,
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

/** Claims sent in one theme research request (#533); the rest stay explicit gaps. */
export const MAX_CLAIMS_PER_REQUEST = 12;

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
  ): Promise<
    { themeId: string; rationale: string } | { themeId: null; rationale: string; abstain?: boolean }
  >;
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

const titleWords = (text: string) => new Set(normaliseMappingKey(text).split(" ").filter(Boolean));
const titleSimilarity = (a: string, b: string) => {
  const left = titleWords(a);
  const right = titleWords(b);
  const union = new Set([...left, ...right]).size;
  return union ? [...left].filter((word) => right.has(word)).length / union : 0;
};
/** New-plan policy: titles select candidates; conflicting/unknown meaning stays unresolved. */
export class TitleFirstJudge extends ThresholdJudge {
  override async decide(
    theme: { title: string; description: string },
    shortlist: Shortlist,
  ): Promise<{ themeId: string | null; rationale: string; abstain?: boolean }> {
    const exact = shortlist.candidates.filter(
      (c) => normaliseMappingKey(c.title) === normaliseMappingKey(theme.title),
    );
    if (exact.length) {
      const titleTokens = tokens(theme.title);
      const meaningful = (text: string) =>
        new Set([...tokens(text)].filter((t) => !titleTokens.has(t)));
      const query = meaningful(theme.description);
      const compatible = exact.filter((c) => {
        if (
          normaliseMappingKey(c.scope) === normaliseMappingKey(theme.description) &&
          query.size > 0
        )
          return true;
        const scope = meaningful(c.scope);
        const overlap = [...query].filter((t) => scope.has(t)).length;
        return overlap > 0 && overlap / new Set([...query, ...scope]).size >= 0.5;
      });
      if (compatible.length === 1)
        return {
          themeId: compatible[0]!.themeId,
          rationale: "title-first match with compatible description scope",
        };
      return {
        themeId: null,
        abstain: true,
        rationale:
          compatible.length > 1
            ? "same-title meaning remains ambiguous"
            : "same-title description conflicts or lacks enough scope",
      };
    }
    const titled = shortlist.candidates.filter((c) => titleSimilarity(theme.title, c.title) >= 0.5);
    if (titled.length) {
      const ranked = titled
        .map((c) => ({
          c,
          title: titleSimilarity(theme.title, c.title),
          scope: titleSimilarity(theme.description, c.scope),
        }))
        .sort(
          (a, b) =>
            b.title - a.title || b.scope - a.scope || a.c.themeId.localeCompare(b.c.themeId),
        );
      const best = ranked[0]!;
      if (
        best.scope >= 0.5 &&
        (ranked.length === 1 || best.title > ranked[1]!.title || best.scope > ranked[1]!.scope)
      )
        return {
          themeId: best.c.themeId,
          rationale: "title-primary similarity with compatible description scope",
        };
      return { themeId: null, abstain: true, rationale: "near-title meaning remains ambiguous" };
    }
    if (shortlist.candidates.length)
      return {
        themeId: null,
        abstain: true,
        rationale: "description similarity alone does not establish title equivalence",
      };
    return { themeId: null, rationale: "no existing title candidate" };
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
    needBindings: Ref.optional(),
    reuseLimitations: z
      .array(
        z
          .object({
            claimRecordId: z.string().max(200),
            reason: z.enum([
              "legacy-proof-missing",
              "legacy-proof-scan-bound",
              "legacy-proof-ambiguous",
              "semantic-group-ambiguous",
            ]),
          })
          .strict(),
      )
      .max(10000)
      .optional(),
    unresolvedProposals: z
      .array(
        z
          .object({
            proposalId: z.string(),
            title: z.string(),
            description: z.string().max(2000),
            reason: z.string().max(1000),
          })
          .strict(),
      )
      .max(1000)
      .optional(),
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
          warnings: ResearchWarningsSchema.optional(),
          /**
           * The exact claim batch of a targeted theme request (#658), so a
           * reassessment replays the same request instead of rebuilding it
           * from dossier coverage that this run may itself have changed.
           */
          // One batch per theme since #533, so a batch can hold every claim of the theme.
          targetedClaims: z.array(z.string()).max(1000).optional(),
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

/** Question template for targeted enhancement of a researched theme (#658). */
const THEME_ENHANCEMENT = loadPromptFile("research", "theme-enhancement-v1");
const CANONICAL_RESEARCH = loadPromptFile("research", "canonical-need-v1");
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
  need?: z.infer<typeof CanonicalNeedSchema>;
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
        reason:
          "not selected: the article's new-research allowance went to higher-ranked evidence gaps (see the saved research selection)",
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
type RequestPlanEntry =
  | { mode: "full"; question?: string; promptVersion?: string }
  | { mode: "targeted"; batches: string[][]; question?: string; promptVersion?: string };
const RequestPlanEntries = z.record(
  z.string(),
  z.union([
    z
      .object({
        mode: z.literal("full"),
        question: z.string().min(1).max(4000).optional(),
        promptVersion: z.string().min(1).max(200).optional(),
      })
      .strict(),
    z
      .object({
        mode: z.literal("targeted"),
        batches: z.array(z.array(z.string()).max(1000)).max(100),
        question: z.string().min(1).max(4000).optional(),
        promptVersion: z.string().min(1).max(200).optional(),
      })
      .strict(),
  ]),
);
const OrderedRequestPlanSchema = z
  .object({
    schemaVersion: z.literal(2),
    dossiers: RequestPlanEntries,
    order: z.array(z.string()).max(1000),
  })
  .strict()
  .superRefine((p, ctx) => {
    const keys = Object.keys(p.dossiers);
    if (
      p.order.length !== keys.length ||
      new Set(p.order).size !== p.order.length ||
      p.order.some((id) => !Object.hasOwn(p.dossiers, id))
    )
      ctx.addIssue({
        code: "custom",
        message: "research plan order must name every dossier exactly once",
      });
  });
const CanonicalRequestPlanSchema = z
  .object({
    schemaVersion: z.literal(3),
    dossiers: RequestPlanEntries,
    order: z.array(z.string()).max(1000),
  })
  .strict()
  .superRefine((p, ctx) => {
    const keys = Object.keys(p.dossiers);
    if (
      p.order.length !== keys.length ||
      new Set(p.order).size !== p.order.length ||
      p.order.some((id) => !Object.hasOwn(p.dossiers, id))
    )
      ctx.addIssue({
        code: "custom",
        message: "research plan order must name every dossier exactly once",
      });
  });
const RequestPlanSchema = z.union([
  CanonicalRequestPlanSchema,
  z.object({ schemaVersion: z.literal(1), dossiers: RequestPlanEntries }).strict(),
  OrderedRequestPlanSchema,
]);
type RequestPlan = z.infer<typeof RequestPlanSchema>;

/** Prior exact-analysis coverage wins; unrecorded groups keep extraction order. */
function commissioningOrder(groups: string[], history: string[][]): string[] {
  const wanted = new Set(groups);
  const sequences = history
    .map((ids) => [...new Set(ids.filter((id) => wanted.has(id)))])
    .filter((ids) => ids.length > 0)
    .sort((a, b) => b.length - a.length);
  const recorded = sequences[0] ?? [];
  for (const sequence of sequences) {
    let next = 0;
    for (const id of recorded) if (sequence[next] === id) next++;
    if (next !== sequence.length) throw new Error("research-plan-order-conflict");
  }
  return [...recorded, ...groups.filter((id) => !recorded.includes(id))];
}

/**
 * The request plan of one analysis, saved write-once: the first plan saved
 * is the one every retry follows. A plan that does not name a dossier (a
 * group that was fully reused when it was made) leaves that group alone.
 */
async function retainedPlan(
  artifacts: GitArtifactStore,
  post: { publicationId: string; postId: string },
  themeResult: ArtifactRef,
  claimResult: ArtifactRef,
  proposed: () =>
    | z.infer<typeof OrderedRequestPlanSchema>
    | z.infer<typeof CanonicalRequestPlanSchema>,
): Promise<RequestPlan> {
  const key = createHash("sha256")
    .update(JSON.stringify([toRef(themeResult), toRef(claimResult)]))
    .digest("hex")
    .slice(0, 32);
  const path = `librarian/request-plans/${post.publicationId}/${post.postId}/${key}.json`;
  const existing = await artifacts.lookup(path);
  if (existing) return RequestPlanSchema.parse(JSON.parse(await artifacts.read(existing)));
  const ref = await writeOnce(artifacts, path, RequestPlanSchema.parse(proposed()));
  return RequestPlanSchema.parse(JSON.parse(await artifacts.read(ref)));
}

async function priorMappings(
  artifacts: GitArtifactStore,
  post: { publicationId: string; postId: string },
  themeResult: ArtifactRef,
  claimResult: ArtifactRef,
  jobIds?: Set<string>,
  targetedBatches?: Map<string, string[][]>,
  commissioningOrders?: string[][],
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
    const same = (a: { commit: string; path: string; hash: string }, b: ArtifactRef) =>
      a.commit === b.commit && a.path === b.path && a.hash === `sha256:${b.sha256}`;
    if (!same(r.themeResult, themeResult) || !same(r.claimResult, claimResult)) continue;
    commissioningOrders?.push([
      ...new Set(r.jobs.filter((j) => j.pass === 1).map((j) => j.dossierId)),
    ]);
    for (const m of r.mappings) if (!out.has(m.proposalId)) out.set(m.proposalId, m);
    for (const j of r.jobs) {
      jobIds?.add(j.jobId);
      if (j.targetedClaims && targetedBatches) {
        const batches = targetedBatches.get(j.dossierId) ?? [];
        const key = JSON.stringify(j.targetedClaims);
        if (!batches.some((b) => JSON.stringify(b) === key)) batches.push(j.targetedClaims);
        targetedBatches.set(j.dossierId, batches);
      }
    }
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
/** Validate the complete analysis association before any planning mutation. */
export async function readCoverageAnalysis(
  artifacts: GitArtifactStore,
  themeResult: ArtifactRef,
  claimResult: ArtifactRef,
) {
  const themes: ThemeProposalResult = parseThemeProposalResult(
    JSON.parse(await artifacts.read(themeResult)),
  );
  const claimRecord = ClaimExtractionRecordSchema.parse(
    JSON.parse(await artifacts.read(claimResult)),
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
    claimRecord.themeResult !== `${themeResult.commit}:${themeResult.path}`
  ) {
    throw new Error("claim result was extracted against a different theme result");
  }
  if (claimRecord.sourceVersion !== themes.sourceVersion) {
    throw new Error("theme and claim results describe different source versions");
  }
  return { themes, claimRecord, post };
}

/**
 * How a theme is named in a research question. A source-author theme (#753)
 * carries its configured disambiguation, so research concerns the intended
 * person and not a namesake; other themes are named by title as before.
 */
function researchSubject(p: { title: string; description?: string; origin?: string }): string {
  return p.origin === "source-author" && p.description ? `${p.title} (${p.description})` : p.title;
}

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
  /**
   * Job IDs the workflow already journaled for this analysis (#658). A run
   * planned before targeted theme requests existed keeps its full request:
   * the plan follows these rather than inventing a request it never made.
   */
  pinnedJobIds?: ReadonlySet<string>;
}): Promise<{ record: CoverageRecord; ref: ArtifactRef }> {
  const now = (input.now ?? (() => new Date()))().toISOString();

  const { themes, claimRecord, post } = await readCoverageAnalysis(
    input.artifacts,
    input.themeResult,
    input.claimResult,
  );
  const planKey = createHash("sha256")
    .update(JSON.stringify([toRef(input.themeResult), toRef(input.claimResult)]))
    .digest("hex")
    .slice(0, 32);
  const priorPlanRef = await input.artifacts.lookup(
    `librarian/request-plans/${post.publicationId}/${post.postId}/${planKey}.json`,
  );
  const priorPlan = priorPlanRef
    ? RequestPlanSchema.parse(JSON.parse(await input.artifacts.read(priorPlanRef)))
    : undefined;
  const canonicalMode = priorPlan
    ? priorPlan.schemaVersion === 3
    : claimRecord.schemaVersion >= 3 && !input.pinnedJobIds?.size;
  const judge: ThemeEquivalenceJudge =
    input.judge ?? (canonicalMode ? new TitleFirstJudge() : new ThresholdJudge());
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
    if (existing.has(theme.id)) {
      if (canonicalMode) {
        const summary = summaries.find((s) => s.themeId === theme.id)!;
        summary.title = theme.title;
        if (theme.description) summary.scope = theme.description;
      }
      continue;
    }
    summaries.push({
      themeId: theme.id,
      title: theme.title,
      scope: theme.description ?? theme.title,
    });
  }

  // 1. Map proposed themes to dossiers.
  const mappings: CoverageRecord["mappings"] = [];
  const unresolvedProposals: NonNullable<CoverageRecord["unresolvedProposals"]> = [];
  const dossierFor = new Map<string, string>();
  const titles = new Map<string, string>();
  /** Research subject per dossier from this analysis's own proposals (never editable dossier titles). */
  const subjects = new Map<string, string>();
  // Reassessing the same analysis reuses the mapping its earlier run saved,
  // so shortlist or judge changes cannot move a theme to another dossier.
  // Jobs an earlier assessment of this exact analysis commissioned (#658):
  // reassessment repeats the same request rather than switching mode.
  const priorJobIds = new Set<string>(input.pinnedJobIds ?? []);
  const priorTargeted = new Map<string, string[][]>();
  const priorOrders: string[][] = [];
  const savedMapping = await priorMappings(
    input.artifacts,
    post,
    input.themeResult,
    input.claimResult,
    priorJobIds,
    priorTargeted,
    priorOrders,
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
      if (!subjects.has(kept.dossierId)) subjects.set(kept.dossierId, researchSubject(p));
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
      if (!subjects.has(dossierId)) subjects.set(dossierId, researchSubject(p));
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
    let shortlist = await input.shortlister.shortlist(p, summaries);
    if (canonicalMode) {
      const aliases = await catalogue.titleCandidates(p.title);
      if (aliases.some((a) => !a.mapping.scope && a.mapping.status === "unresolved")) {
        unresolvedProposals.push({
          proposalId: p.id,
          title: p.title,
          description: p.description,
          reason: "saved same-title mapping requires disambiguation",
        });
        continue;
      }
      const exact = [
        ...summaries.filter((s) => normaliseMappingKey(s.title) === normaliseMappingKey(p.title)),
        ...aliases
          .filter((a) => !a.mapping.scope && established.has(a.mapping.canonicalThemeId))
          .map((a) => ({
            themeId: a.mapping.canonicalThemeId,
            title: p.title,
            scope: a.mapping.description ?? "",
          })),
      ];
      const byTheme = new Map<string, DossierCandidate>();
      for (const candidate of exact) {
        const prior = byTheme.get(candidate.themeId);
        if (
          !prior ||
          titleSimilarity(p.description, candidate.scope) >
            titleSimilarity(p.description, prior.scope)
        )
          byTheme.set(candidate.themeId, { ...candidate, score: 1 });
      }
      const candidates = [...byTheme.values()];
      if (candidates.length > 5) {
        unresolvedProposals.push({
          proposalId: p.id,
          title: p.title,
          description: p.description,
          reason: "same-title candidates exceed bounded disambiguation shortlist",
        });
        continue;
      }
      const titleRanked = summaries
        .filter((s) => titleSimilarity(p.title, s.title) > 0)
        .map((s) => ({ ...s, score: titleSimilarity(p.title, s.title) }))
        .sort(
          (a, b) =>
            b.score - a.score ||
            titleSimilarity(p.description, b.scope) - titleSimilarity(p.description, a.scope) ||
            a.themeId.localeCompare(b.themeId),
        );
      const priority = [
        ...candidates,
        ...titleRanked.filter((c) => !candidates.some((e) => e.themeId === c.themeId)),
      ];
      shortlist = {
        ...shortlist,
        candidates: [
          ...priority,
          ...shortlist.candidates.filter((c) => !priority.some((e) => e.themeId === c.themeId)),
        ].slice(0, 5),
      };
    }
    const decision = await judge.decide(p, shortlist);
    if (decision.themeId === null && decision.abstain) {
      unresolvedProposals.push({
        proposalId: p.id,
        title: p.title,
        description: p.description,
        reason: decision.rationale.slice(0, 1000),
      });
      continue;
    }
    let dossierId = decision.themeId ?? newDossierId(p.title);
    // A rejected equivalence must never land in the existing dossier it rejected.
    for (let n = 2; decision.themeId === null && established.has(dossierId); n++) {
      dossierId = newDossierId(`${p.title}#${n}`);
    }
    if (!subjects.has(dossierId)) subjects.set(dossierId, researchSubject(p));
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
    // Every decision is recorded durably before any research (#531): an
    // accepted equivalence, or the newly established canonical theme. A later
    // post with compatible wording and meaning (title plus description) reuses
    // it without a new decision; a different meaning has a different key.
    {
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
        // The current registry, not this run's opening snapshot: a concurrent
        // assessment may have established the winner after this one started.
        (established.has(winner.canonicalThemeId) ||
          (await themeStore.get(winner.canonicalThemeId)) !== undefined)
      ) {
        established.add(winner.canonicalThemeId);
        const saved = mappings[mappings.length - 1]!;
        saved.dossierId = winner.canonicalThemeId;
        saved.method = "catalogue";
        saved.created = false;
        saved.rationale = "reconciled to the saved catalogue winner";
        dossierFor.set(p.id, winner.canonicalThemeId);
        // The research subject follows the dossier this mapping now points at.
        if (!subjects.has(winner.canonicalThemeId))
          subjects.set(winner.canonicalThemeId, researchSubject(p));
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
  const bindings = canonicalMode
    ? researchNeedBindings({
        record: claimRecord,
        source: themes.artifact,
        themeResult: input.themeResult,
        claimResult: input.claimResult,
        mappings: dossierFor,
      })
    : undefined;
  const needBindingsRef = bindings
    ? await retainResearchNeedBindings(input.artifacts, bindings)
    : undefined;
  const newEvidence = new Map<string, ResearchNeedEvidence[]>();
  const evidenceArtifacts = cachedResearchEvidenceStore(input.artifacts);
  const legacyNeedLookup = createLegacyResearchNeedLookup(evidenceArtifacts);
  const reuseLimitations: NonNullable<CoverageRecord["reuseLimitations"]> = [];
  const jobs: CoverageRecord["jobs"] = [];
  const retainJob = (job: CoverageRecord["jobs"][number]) => {
    const existing = jobs.find((j) => j.jobId === job.jobId);
    if (existing) {
      if (
        existing.dossierId !== job.dossierId ||
        existing.pass !== job.pass ||
        existing.outcome !== job.outcome ||
        JSON.stringify(existing.result ?? null) !== JSON.stringify(job.result ?? null) ||
        JSON.stringify(existing.manifest ?? null) !== JSON.stringify(job.manifest ?? null)
      )
        throw new Error("research-job-reference-conflict");
      if (job.targetedClaims)
        existing.targetedClaims = [
          ...new Set([...(existing.targetedClaims ?? []), ...job.targetedClaims]),
        ];
      return;
    }
    jobs.push(job);
  };
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
    if (canonicalMode) {
      const entries = bindings!.entries.filter(
        (e) => e.themeId === home && e.claimRecordId === claim.key,
      );
      if (new Set(entries.map((e) => e.needId)).size > 1) {
        reuseLimitations.push({
          claimRecordId: claim.claimRecordId,
          reason: "semantic-group-ambiguous",
        });
        outcomes.set(claim.key, {
          claimRecordId: claim.claimRecordId,
          statement: claim.statement,
          dossierId: home,
          status: "not-commissioned",
          reused: false,
          jobIds: [],
          citations: [],
          reason:
            "grouped claim has different semantic occurrence scopes; refinement required before research",
        });
        continue;
      }
      const entry = entries[0];
      if (entry) claim.need = entry.need;
      if (claim.need) {
        for (const id of mapped) {
          const dossier = existing.get(id);
          let proof = dossier?.metadata.researchNeeds?.find(
            (p) => canonicalNeedId(p.need) === canonicalNeedId(claim.need!),
          );
          if (!proof && dossier?.metadata.claims.some((c) => c.status === "covered")) {
            const legacy = await legacyNeedLookup(claim.need);
            if (legacy.status === "found") proof = legacy.proof;
            else
              reuseLimitations.push({ claimRecordId: claim.claimRecordId, reason: legacy.reason });
          }
          if (!dossier || !proof) continue;
          const checked = await readResearchNeedEvidence(evidenceArtifacts, proof);
          if (checked.citations.length === 0) continue;
          retainJob({
            jobId: checked.result.jobId,
            dossierId: id,
            pass: checked.request.pass,
            outcome: checked.result.outcome,
            result: checked.proof.result,
            manifest: checked.proof.manifest,
          });
          outcomes.set(claim.key, {
            claimRecordId: claim.claimRecordId,
            statement: claim.statement,
            dossierId: id,
            status: "evidence-found",
            reused: true,
            jobIds: [checked.result.jobId],
            citations: checked.citations,
            evidenceFrom: {
              dossier: toRef(dossier.ref),
              citationIds: dossier.metadata.citations
                .filter((c) =>
                  checked.citations.some((p) => p.url === c.url && p.passage === c.passage),
                )
                .map((c) => c.id),
            },
          });
          break;
        }
      }
    }
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
    if (!canonicalMode && homeDossier && prior?.status === "covered") {
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
    question?: string,
  ) => {
    const request = buildRequest(dossierId, group, pass, previousJobId, targeted, question);
    return commissionAndAssess(
      dossierId,
      group,
      pass,
      request,
      targeted ? group.map((c) => c.key) : undefined,
    );
  };
  /**
   * At most MAX_CLAIMS_PER_REQUEST claims per theme request (#533), in the
   * group's priority order; the rest are recorded as omitted and stay gaps.
   */
  function boundedClaims<T extends { claimRecordId: string }>(all: T[]) {
    const claims = all.slice(0, MAX_CLAIMS_PER_REQUEST);
    const omitted = all.slice(MAX_CLAIMS_PER_REQUEST).map((c) => c.claimRecordId);
    return { claims, ...(omitted.length ? { omittedClaimRecordIds: omitted.slice(0, 500) } : {}) };
  }
  function buildRequest(
    dossierId: string,
    group: AcceptedClaim[],
    pass: number,
    previousJobId: string | undefined,
    targeted: boolean,
    question?: string,
  ): ResearchRequest {
    const canonical = canonicalMode && group.every((c) => !!c.need);
    const needs = canonical
      ? [...new Map(group.map((c) => [canonicalNeedId(c.need!), c.need!])).values()].sort((a, b) =>
          canonicalNeedId(a).localeCompare(canonicalNeedId(b)),
        )
      : undefined;
    return {
      ...(needs ? { canonicalNeeds: { version: "canonical-theme-needs-v1" as const, needs } } : {}),
      schemaVersion: RESEARCH_JOB_SCHEMA_VERSION,
      origin: canonical || targeted ? "theme" : "extraction",
      pass,
      ...(previousJobId ? { previousJobId } : {}),
      ...(canonical || targeted ? {} : { post: postRefs }),
      ...boundedClaims(
        needs
        ? needs.map((n) => ({
            claimRecordId: canonicalNeedId(n),
            statement: n.proposition.statement,
            themeIds: [dossierId],
          }))
        : group
            .flatMap((c) => c.extracted)
            .map((e) => ({
              claimRecordId: e.claimRecordId,
              statement: e.statement,
              themeIds: [dossierId],
            })),
      ),
      question: canonical
        ? (question ?? CANONICAL_RESEARCH.instructions.replaceAll("{{theme}}", dossierId))
        : targeted
          ? (question ?? THEME_ENHANCEMENT.instructions.replaceAll("{{theme}}", dossierId))
          : pass === 1
            ? `What do independent, authoritative sources establish about these claims concerning ${subjects.get(dossierId)}?`
            : "Targeted follow-up: find primary or authoritative sources that directly address these specific claims, which an earlier search could not support.",
      // Canonical execution contains only semantic needs and a pinned topic
      // question; the separate binding owns per-analysis provenance. Legacy
      // requests retain their original post/analysis payload and identity.
      corpusRefs: [],
    };
  }
  async function commissionAndAssess(
    dossierId: string,
    group: AcceptedClaim[],
    pass: number,
    request: ResearchRequest,
    targetedClaims?: string[],
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
    retainJob({
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
      ...(manifest?.warnings?.length ? { warnings: manifest.warnings } : {}),
      ...(targetedClaims ? { targetedClaims } : {}),
    });
    let assessedGroup = group;
    if (request.canonicalNeeds && job.status === "finished" && job.result?.outcome !== "failed") {
      if (!job.resultRef) throw new Error("research-need-result-reference-required");
      const proofs: ResearchNeedEvidence[] = [];
      for (const need of request.canonicalNeeds.needs) {
        const proof = await researchNeedEvidence(
          input.artifacts,
          job.resultRef,
          need,
          needBindingsRef!,
        );
        proofs.push(proof);
      }
      newEvidence.set(dossierId, [...(newEvidence.get(dossierId) ?? []), ...proofs]);
      assessedGroup = group.map((c) => ({
        ...c,
        extracted: [{ claimRecordId: canonicalNeedId(c.need!), statement: c.statement }],
      }));
    }
    return {
      job,
      assessed: assess(assessedGroup, job, manifest),
      partial:
        !!manifest?.retainedRecovery ||
        !!manifest?.warnings?.some((w) => w.code === "report-output-limit"),
    };
  }

  // The request plan for this analysis is decided once and saved write-once
  // before anything is commissioned or any dossier revised (#658). Every
  // retry or reassessment follows the retained plan, so a crash between a
  // dossier revision and the coverage record can never switch a request.
  const planned = new Map<string, RequestPlanEntry>();
  for (const [dossierId, all] of groups) {
    // Nothing to research when every claim is already covered.
    if (all.every((c) => outcomes.get(c.key)?.reused)) continue;
    // A theme that already has saved research is not researched again from
    // scratch because this post's byline, context, claim order or extraction
    // IDs differ: its covered claims are reused above, and only the claims
    // that still need evidence get bounded, targeted requests.
    const saved = existing.get(dossierId);
    const sortedAll = [...all].sort((a, b) =>
      canonicalMode && a.need && b.need
        ? canonicalNeedId(a.need).localeCompare(canonicalNeedId(b.need))
        : a.key.localeCompare(b.key),
    );
    const fullRequestedBefore = chunks(sortedAll).some((g) =>
      priorJobIds.has(researchJobId(buildRequest(dossierId, g, 1, undefined, false))),
    );
    if (saved && saved.metadata.claims.length > 0 && !fullRequestedBefore) {
      const replay = priorTargeted.get(dossierId);
      const needs = [...all]
        .filter((c) => !outcomes.get(c.key)?.reused)
        .sort((a, b) =>
          canonicalMode && a.need && b.need
            ? canonicalNeedId(a.need).localeCompare(canonicalNeedId(b.need))
            : a.claimRecordId.localeCompare(b.claimRecordId),
        );
      planned.set(dossierId, {
        mode: "targeted",
        batches: replay ?? chunks(needs).map((g) => g.map((c) => c.key)),
        question: (canonicalMode ? CANONICAL_RESEARCH : THEME_ENHANCEMENT).instructions.replaceAll(
          "{{theme}}",
          dossierId,
        ),
        promptVersion: (canonicalMode ? CANONICAL_RESEARCH : THEME_ENHANCEMENT).version,
      });
    } else {
      planned.set(dossierId, {
        mode: "full",
        ...(canonicalMode
          ? {
              question: CANONICAL_RESEARCH.instructions.replaceAll("{{theme}}", dossierId),
              promptVersion: CANONICAL_RESEARCH.version,
            }
          : {}),
      });
    }
  }
  const plan = await retainedPlan(
    input.artifacts,
    post,
    input.themeResult,
    input.claimResult,
    () => ({
      schemaVersion: canonicalMode ? 3 : 2,
      dossiers: Object.fromEntries([...planned].sort(([a], [b]) => a.localeCompare(b))),
      order: commissioningOrder(
        [...groups.keys()].filter((id) => planned.has(id)),
        priorOrders,
      ),
    }),
  );
  // A concurrent older worker may have won the immutable plan. Retry from
  // that authoritative version before making any research request.
  if ((plan.schemaVersion === 3) !== canonicalMode)
    throw new Error("research-plan-version-changed");
  const order = plan.schemaVersion !== 1 ? plan.order : Object.keys(plan.dossiers);
  for (const dossierId of order) {
    const entry = plan.dossiers[dossierId]!;
    const all = groups.get(dossierId);
    if (!all) continue;
    // A group covered since needs no request: existing research never takes
    // new-job allowance from groups that still need evidence.
    if (all.every((c) => outcomes.get(c.key)?.reused)) continue;
    if (entry.mode === "targeted") {
      const byKey = new Map(all.map((c) => [c.key, c]));
      for (const batch of entry.batches) {
        const group = batch.map((k) => byKey.get(k)).filter((c): c is AcceptedClaim => !!c);
        if (group.length > 0) await enhanceGroup(dossierId, group, entry.question);
      }
    } else {
      const sortedAll = [...all].sort((a, b) =>
        canonicalMode && a.need && b.need
          ? canonicalNeedId(a.need).localeCompare(canonicalNeedId(b.need))
          : a.key.localeCompare(b.key),
      );
      for (const g of chunks(sortedAll)) await assessGroup(dossierId, g, entry.question);
    }
  }

  // Every accepted claim ends with an explicit outcome, even when the
  // retained plan does not name its group (it was fully reused when planned,
  // and a later claim merge has since changed what matches).
  for (const [dossierId, all] of groups) {
    for (const claim of all) {
      if (outcomes.has(claim.key)) continue;
      outcomes.set(claim.key, {
        claimRecordId: claim.claimRecordId,
        statement: claim.statement,
        dossierId,
        status: "not-commissioned",
        reused: false,
        jobIds: [],
        citations: [],
        reason: "not part of this analysis's retained research plan; reassess as a new analysis",
      });
    }
  }

  // One initial request per theme (#533): the request itself is bounded to
  // MAX_CLAIMS_PER_REQUEST claims, with the rest recorded as omitted, instead
  // of fanning a large theme out into several paid requests.
  function chunks(list: AcceptedClaim[]): AcceptedClaim[][] {
    return list.length ? [list] : [];
  }

  async function enhanceGroup(dossierId: string, group: AcceptedClaim[], question?: string) {
    const targeted = await run(dossierId, group, 1, undefined, true, question);
    for (const claim of group) {
      // Replaying the identical request must not replace evidence found since.
      if (outcomes.get(claim.key)?.reused) continue;
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
    // The same single follow-up as a full first pass (#597), kept targeted.
    await secondPass(dossierId, group, targeted, (followUp) =>
      run(dossierId, followUp, 2, targeted.job.jobId, true, question),
    );
  }

  /** One targeted second pass for consequential claims the first left unsupported. */
  async function secondPass(
    dossierId: string,
    group: AcceptedClaim[],
    first: Awaited<ReturnType<typeof run>>,
    commission: (followUp: AcceptedClaim[]) => ReturnType<typeof run>,
  ) {
    // Derived from the first job's saved result only (never from reuse in
    // the dossier), so reassessment rebuilds the identical second request.
    const followUp = group.filter(
      (c) =>
        first.assessed.get(c.key)?.status === "no-independent-evidence" &&
        (input.consequential?.(c) ?? false),
    );
    if (followUp.length === 0 || first.job.status !== "finished") return;
    // A partial report is usable work, not permission to buy missing prose.
    // Retain its unsupported claims as gaps; an explicit operator can request
    // another research attempt, but incompleteness alone never schedules one.
    if (first.partial) return;
    const second = await commission(followUp);
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
          : a.status === "pending" || a.status === "research-failed" || a.status === "claimant-only"
            ? { status: a.status, citations: [], reason: `second pass: ${a.reason ?? a.status}` }
            : {}),
      });
    }
  }

  async function assessGroup(dossierId: string, group: AcceptedClaim[], question?: string) {
    const first = await run(dossierId, group, 1, undefined, false, question);
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
    await secondPass(dossierId, group, first, (followUp) =>
      run(dossierId, followUp, 2, first.job.jobId),
    );
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
        (m) => ({
          ...mergeCoverage(m, items, now),
          ...(newEvidence.has(dossierId)
            ? {
                researchNeeds: [
                  ...new Map(
                    [...(m.researchNeeds ?? []), ...newEvidence.get(dossierId)!].map((p) => [
                      canonicalNeedId(p.need),
                      p,
                    ]),
                  ).values(),
                ].slice(0, 1000),
              }
            : {}),
        }),
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
    ...(needBindingsRef ? { needBindings: toRef(needBindingsRef) } : {}),
    ...(reuseLimitations.length ? { reuseLimitations } : {}),
    source: themes.artifact,
    ...((claimRecord.sourceContext ?? themes.sourceContext)
      ? { sourceContext: claimRecord.sourceContext ?? themes.sourceContext }
      : {}),
    themeResult: toRef(input.themeResult),
    claimResult: toRef(input.claimResult),
    mappings,
    ...(unresolvedProposals.length ? { unresolvedProposals } : {}),
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

/** One ranked research candidate for an article (#533). */
export interface RankedResearchRequest {
  request: ResearchRequest;
  jobId: string;
  rank: number;
  /** Claims in the request that still need evidence. */
  claimsNeedingEvidence: number;
  rationale: string;
}

/**
 * Order an article's candidate research requests by usefulness (#533): the
 * gap with the most claims still needing evidence first, so a small new-job
 * allowance buys the most coverage. Ties break on the stable job ID, so the
 * order (and therefore the selected job) is deterministic on every retry.
 * Requests only ever contain claims that need evidence: reused coverage is
 * never re-requested.
 */
/** The original commissioning order, kept for analyses planned before ranking (#533). */
export function originalOrder(requests: ResearchRequest[]): RankedResearchRequest[] {
  return requests.map((request, i) => ({
    request,
    jobId: researchJobId(request),
    rank: i + 1,
    claimsNeedingEvidence: request.claims.length,
    rationale: "planned before ranking existed; the original commissioning order is kept",
  }));
}

/**
 * The research ordering for one analysis, decided once and saved write-once
 * (#533): the first decision is kept, so retries never switch between the
 * original and the ranked order.
 */
export async function retainedOrdering(
  artifacts: GitArtifactStore,
  post: { publicationId: string; postId: string },
  themeResult: ArtifactRef,
  claimResult: ArtifactRef,
  decide: () => Promise<"ranked" | "original">,
): Promise<"ranked" | "original"> {
  const key = createHash("sha256")
    .update(JSON.stringify([toRef(themeResult), toRef(claimResult)]))
    .digest("hex")
    .slice(0, 32);
  const path = `librarian/research-ordering/${post.publicationId}/${post.postId}/${key}.json`;
  const Saved = z
    .object({ schemaVersion: z.literal(1), ordering: z.enum(["ranked", "original"]) })
    .strict();
  const existing = await artifacts.lookup(path);
  if (existing) return Saved.parse(JSON.parse(await artifacts.read(existing))).ordering;
  const ref = await writeOnce(artifacts, path, { schemaVersion: 1, ordering: await decide() });
  return Saved.parse(JSON.parse(await artifacts.read(ref))).ordering;
}

/** True when this exact analysis was already assessed (any saved coverage record). */
export async function analysedBefore(
  artifacts: GitArtifactStore,
  post: { publicationId: string; postId: string },
  themeResult: ArtifactRef,
  claimResult: ArtifactRef,
): Promise<boolean> {
  const planKey = createHash("sha256")
    .update(JSON.stringify([toRef(themeResult), toRef(claimResult)]))
    .digest("hex")
    .slice(0, 32);
  const plan = await artifacts.lookup(
    `librarian/request-plans/${post.publicationId}/${post.postId}/${planKey}.json`,
  );
  if (plan) {
    RequestPlanSchema.parse(JSON.parse(await artifacts.read(plan)));
    return true;
  }
  const prefix = `librarian/coverage/${post.publicationId}/${post.postId}`;
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const paths = await artifacts.list(prefix, 1000, after);
    for (const path of paths) {
      const ref = await artifacts.lookup(path);
      if (!ref) continue;
      const parsed = CoverageRecordSchema.safeParse(JSON.parse(await artifacts.read(ref)));
      if (!parsed.success) throw new Error("analysis history record invalid");
      const r = parsed.data;
      const exact = (saved: z.infer<typeof Ref>, supplied: ArtifactRef) =>
        saved.repository === supplied.repository &&
        saved.commit === supplied.commit &&
        saved.path === supplied.path &&
        saved.hash === `sha256:${supplied.sha256}`;
      if (exact(r.themeResult, themeResult) && exact(r.claimResult, claimResult)) return true;
    }
    if (paths.length < 1000) return false;
    after = paths.at(-1);
  }
  throw new Error("analysis history scan incomplete");
}

export function rankResearchRequests(requests: ResearchRequest[]): RankedResearchRequest[] {
  return requests
    .map((request) => ({ request, jobId: researchJobId(request), n: request.claims.length }))
    .sort((a, b) => b.n - a.n || a.jobId.localeCompare(b.jobId))
    .map((r, i) => ({
      request: r.request,
      jobId: r.jobId,
      rank: i + 1,
      claimsNeedingEvidence: r.n,
      rationale:
        i === 0
          ? `most claims still needing evidence (${r.n})`
          : `${r.n} claim(s) still needing evidence; ranked below larger gaps (job ID breaks ties)`,
    }));
}

/**
 * Save the ranked candidates for one analysis, write-once (#533): which
 * requests were considered, in which order and why. The workflow commissions
 * the first `researchRequestLimit` of them; the coverage record shows which
 * were commissioned and marks the rest as not selected.
 */
export async function saveResearchSelection(
  artifacts: GitArtifactStore,
  post: { publicationId: string; postId: string },
  themeResult: ArtifactRef,
  claimResult: ArtifactRef,
  ranked: RankedResearchRequest[],
  ordering: "ranked" | "original" = "ranked",
): Promise<ArtifactRef> {
  // Keyed by the analysis and its exact candidate set: a later attempt with
  // fewer remaining gaps gets its own record, never an earlier one's.
  const key = createHash("sha256")
    .update(
      JSON.stringify([toRef(themeResult), toRef(claimResult), ranked.map((r) => r.jobId).sort()]),
    )
    .digest("hex")
    .slice(0, 32);
  return writeOnce(
    artifacts,
    `librarian/research-selection/${post.publicationId}/${post.postId}/${key}.json`,
    {
      schemaVersion: 1,
      themeResult: toRef(themeResult),
      claimResult: toRef(claimResult),
      ordering,
      candidates: ranked.map((r) => ({
        rank: r.rank,
        jobId: r.jobId,
        origin: r.request.origin,
        themeIds: [...new Set(r.request.claims.flatMap((c) => c.themeIds))],
        claimsNeedingEvidence: r.claimsNeedingEvidence,
        rationale: r.rationale,
      })),
    },
  );
}

/** Read the write-once selection as authority, never substitute a recomputed ranking. */
export async function readResearchSelection(
  artifacts: GitArtifactStore,
  ref: ArtifactRef,
  themeResult: ArtifactRef,
  claimResult: ArtifactRef,
  proposed: RankedResearchRequest[],
  ordering: "ranked" | "original",
): Promise<ResearchRequest[]> {
  const saved = z
    .object({
      schemaVersion: z.literal(1),
      themeResult: Ref,
      claimResult: Ref,
      ordering: z.enum(["ranked", "original"]),
      candidates: z
        .array(
          z
            .object({
              rank: z.number().int().positive(),
              jobId: z.string().min(1),
              origin: z.string().min(1),
              themeIds: z.array(z.string()),
              claimsNeedingEvidence: z.number().int().nonnegative(),
              rationale: z.string(),
            })
            .strict(),
        )
        .max(1000),
    })
    .strict()
    .parse(JSON.parse(await artifacts.read(ref)));
  const exact = (a: z.infer<typeof Ref>, b: ArtifactRef) =>
    a.repository === b.repository &&
    a.commit === b.commit &&
    a.path === b.path &&
    a.hash === `sha256:${b.sha256}`;
  const byId = new Map(proposed.map((r) => [r.jobId, r.request]));
  if (
    !exact(saved.themeResult, themeResult) ||
    !exact(saved.claimResult, claimResult) ||
    saved.ordering !== ordering ||
    byId.size !== proposed.length ||
    saved.candidates.length !== byId.size ||
    new Set(saved.candidates.map((c) => c.jobId)).size !== byId.size
  )
    throw new Error("research selection binding mismatch");
  return saved.candidates.map((candidate, index) => {
    const request = byId.get(candidate.jobId);
    if (!request || candidate.rank !== index + 1 || candidate.origin !== request.origin)
      throw new Error("research selection candidate mismatch");
    return request;
  });
}
