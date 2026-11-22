import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import type { ThemeMapping } from "./theme-mappings.js";

/**
 * Librarian assessment and research plan (#595).
 *
 * Planning is separated from execution: given exact, typed references to the
 * source, its configured context, the librarian configuration, the extraction
 * results and every saved mapping and dossier version assessed, this resolves reusable mappings and canonical themes
 * without requiring a dossier, inspects existing coverage, and records what
 * should be reused, created or enhanced. It commissions nothing and calls no
 * provider, so a plan existing is never a readiness decision.
 */

export const LIBRARIAN_PLAN_SCHEMA_VERSION = 2;

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);

/** An exact saved artifact version: repository, commit, path and content hash. */
export const PlanRefSchema = z
  .object({
    repository: z.string().min(1).max(200),
    commit: z.string().regex(/^[0-9a-f]{40,64}$/),
    path: z.string().min(1).max(600),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type PlanRef = z.infer<typeof PlanRefSchema>;

export const DossierActionSchema = z.enum(["reuse-existing", "create-dossier", "enhance-existing"]);
export type DossierAction = z.infer<typeof DossierActionSchema>;

const Author = z
  .object({
    name: z.string().min(1),
    basis: z.enum(["post-byline", "source-configured"]),
  })
  .strict();
const Claims = z
  .array(
    z
      .object({
        claimRecordId: z.string().min(1),
        /** Original claim statement, preserved for reconstruction. */
        statement: z.string().max(2000).optional(),
        canonicalThemeId: Id,
        /** `none` when the theme has no dossier yet. */
        coverage: z.enum(["covered", "gap", "none"]),
        action: z.enum(["reuse", "research", "targeted-enhancement"]),
      })
      .strict(),
  )
  .max(2000);
const mappingFields = {
  proposalId: z.string().min(1),
  canonicalThemeId: Id,
  source: z.enum(["catalogue", "new"]),
  /** Original proposal payload, preserved for reconstruction. */
  proposalTitle: z.string().min(1).max(300).optional(),
  proposalDescription: z.string().max(2000).optional(),
  rationale: z.string().min(1).max(1000),
};
const dossierFields = {
  canonicalThemeId: Id,
  action: DossierActionSchema,
  rationale: z.string().min(1).max(1000),
  gaps: z.array(z.string().min(1).max(500)).max(50),
};

/**
 * Plans saved before exact provenance (#595, schema 1): free-text references
 * and no source, context or configuration pins. Read-only; never written.
 */
export const LegacyLibrarianPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    inputs: z
      .object({
        publicationId: z.string().min(1),
        postId: z.string().min(1),
        sourceVersion: z.string().min(1),
        themeResult: z.string().min(1).max(400).optional(),
        claimResult: z.string().min(1).max(400).optional(),
        author: Author.optional(),
      })
      .strict(),
    mappings: z.array(z.object(mappingFields).strict()).max(200),
    dossiers: z
      .array(
        z.object({ ...dossierFields, dossierRef: z.string().min(1).max(400).optional() }).strict(),
      )
      .max(200),
    claims: Claims,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type LegacyLibrarianPlan = z.infer<typeof LegacyLibrarianPlanSchema>;

export const LibrarianPlanSchema = z
  .object({
    schemaVersion: z.literal(LIBRARIAN_PLAN_SCHEMA_VERSION),
    inputs: z
      .object({
        publicationId: z.string().min(1),
        postId: z.string().min(1),
        /** The exact analysed source revision the plan was derived from. */
        source: PlanRefSchema,
        /** Exact configured source context (author, publication), or null when none is configured. */
        sourceContext: PlanRefSchema.nullable(),
        /** Exact librarian configuration the plan was made under. */
        configuration: PlanRefSchema,
        /** Exact extraction artifacts assessed, when supplied. */
        themeResult: PlanRefSchema.optional(),
        claimResult: PlanRefSchema.optional(),
        /** Resolved post authorship, when it is known (#462). */
        author: Author.optional(),
      })
      .strict(),
    mappings: z
      .array(
        z
          .object({
            ...mappingFields,
            /** Exact saved mapping version reused; present for every catalogue decision. */
            mappingRef: PlanRefSchema.optional(),
          })
          .strict()
          .refine((m) => (m.source === "catalogue") === (m.mappingRef !== undefined), {
            message: "a catalogue mapping names its exact saved version; a new one names none",
          }),
      )
      .max(200),
    dossiers: z
      .array(
        z
          .object({
            ...dossierFields,
            /** Exact dossier revision assessed, when one exists. */
            dossierRef: PlanRefSchema.optional(),
          })
          .strict(),
      )
      .max(200),
    claims: Claims,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type LibrarianPlan = z.infer<typeof LibrarianPlanSchema>;

/** Any saved plan, current or legacy. */
export const StoredLibrarianPlanSchema = z.discriminatedUnion("schemaVersion", [
  LegacyLibrarianPlanSchema,
  LibrarianPlanSchema,
]);
export type StoredLibrarianPlan = z.infer<typeof StoredLibrarianPlanSchema>;

export interface PlanProposal {
  id: string;
  title: string;
  description?: string;
}

export interface PlanClaim {
  claimRecordId: string;
  statement?: string;
  /** Canonical theme the claim's proposal mapped to. */
  canonicalThemeId: string;
}

export interface PlanInputs {
  publicationId: string;
  postId: string;
  source: PlanRef;
  /** Null only when no source context is configured; never omitted. */
  sourceContext: PlanRef | null;
  configuration: PlanRef;
  themeResult?: PlanRef;
  claimResult?: PlanRef;
  author?: { name: string; basis: "post-byline" | "source-configured" };
  proposals: PlanProposal[];
  claims: PlanClaim[];
  /** Catalogue decisions already made for these proposals, with their exact saved versions. */
  mappings: Map<string, { mapping: ThemeMapping; ref: PlanRef }>;
  /** Canonical themes that already exist. */
  themes: Set<string>;
  /** Themes with a current dossier, and that dossier's per-claim coverage. */
  dossiers: Map<
    string,
    {
      coverage: Map<string, "covered" | "gap">;
      /** Exact dossier revision assessed, when known. */
      ref?: PlanRef;
    }
  >;
  now?: () => Date;
}

/** Deterministic fallback identity for a proposal with no saved mapping. */
export function proposedThemeId(title: string, description?: string): string {
  const slug = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  // The description separates same-titled proposals with different meanings.
  const digest = createHash("sha256")
    .update(JSON.stringify([title, description ?? ""]))
    .digest("hex")
    .slice(0, 8);
  return `${slug || "theme"}-${digest}`;
}

/**
 * Build the assessment. A catalogue decision is reused; otherwise the proposal
 * gets a deterministic candidate identity and is marked `new`, so a later
 * librarian decision can accept or change it rather than the plan guessing.
 */
export function planLibrarianAssessment(input: PlanInputs): LibrarianPlan {
  const mappings: LibrarianPlan["mappings"] = [];
  const canonicalFor = new Map<string, string>();

  for (const proposal of input.proposals) {
    const decision = input.mappings.get(proposal.id);
    const saved = decision?.mapping;
    const canonicalThemeId =
      saved?.canonicalThemeId ?? proposedThemeId(proposal.title, proposal.description);
    mappings.push({
      proposalId: proposal.id,
      proposalTitle: proposal.title,
      ...(proposal.description ? { proposalDescription: proposal.description } : {}),
      canonicalThemeId,
      source: saved ? "catalogue" : "new",
      ...(decision ? { mappingRef: decision.ref } : {}),
      rationale: saved
        ? // The key can be far longer than a rationale allows; keep it bounded.
          `reused saved catalogue decision (${saved.key.slice(0, 200)})`
        : "no saved mapping; candidate identity for librarian decision",
    });
    canonicalFor.set(proposal.id, canonicalThemeId);
  }

  const dossiers: LibrarianPlan["dossiers"] = [];
  const seenTheme = new Set<string>();
  for (const mapping of mappings) {
    if (seenTheme.has(mapping.canonicalThemeId)) continue;
    seenTheme.add(mapping.canonicalThemeId);
    const dossier = input.dossiers.get(mapping.canonicalThemeId);
    if (!dossier) {
      dossiers.push({
        canonicalThemeId: mapping.canonicalThemeId,
        action: "create-dossier",
        rationale: input.themes.has(mapping.canonicalThemeId)
          ? "canonical theme exists but has no dossier research yet"
          : "new canonical theme with no research yet",
        gaps: ["no dossier research recorded for this theme"],
      });
      continue;
    }
    // Count only this article's claims: a historical gap on another claim is
    // not a gap for the piece being planned.
    const uncovered = input.claims.filter(
      (c) =>
        c.canonicalThemeId === mapping.canonicalThemeId &&
        dossier.coverage.get(c.claimRecordId) !== "covered",
    ).length;
    dossiers.push({
      canonicalThemeId: mapping.canonicalThemeId,
      action: uncovered > 0 ? "enhance-existing" : "reuse-existing",
      ...(dossier.ref ? { dossierRef: dossier.ref } : {}),
      rationale:
        uncovered > 0
          ? `existing dossier leaves ${uncovered} claim(s) without covering evidence`
          : "existing dossier covers the recorded claims",
      gaps: uncovered > 0 ? [`${uncovered} claim(s) recorded as gaps in the dossier`] : [],
    });
  }

  const resolvedThemes = new Set(mappings.map((m) => m.canonicalThemeId));
  const claims: LibrarianPlan["claims"] = input.claims.map((claim) => {
    // A claim pointing at a theme this plan never resolved gets no coverage
    // from that theme: it is unresolved work, not inherited evidence.
    if (!resolvedThemes.has(claim.canonicalThemeId)) {
      return {
        claimRecordId: claim.claimRecordId,
        ...(claim.statement ? { statement: claim.statement } : {}),
        canonicalThemeId: claim.canonicalThemeId,
        coverage: "none" as const,
        action: "research" as const,
      };
    }
    const dossier = input.dossiers.get(claim.canonicalThemeId);
    const coverage = dossier?.coverage.get(claim.claimRecordId) ?? (dossier ? "gap" : "none");
    return {
      claimRecordId: claim.claimRecordId,
      ...(claim.statement ? { statement: claim.statement } : {}),
      canonicalThemeId: claim.canonicalThemeId,
      coverage,
      action:
        coverage === "covered" ? "reuse" : coverage === "gap" ? "targeted-enhancement" : "research",
    };
  });

  return LibrarianPlanSchema.parse({
    schemaVersion: LIBRARIAN_PLAN_SCHEMA_VERSION,
    inputs: {
      publicationId: input.publicationId,
      postId: input.postId,
      source: input.source,
      sourceContext: input.sourceContext,
      configuration: input.configuration,
      ...(input.themeResult ? { themeResult: input.themeResult } : {}),
      ...(input.claimResult ? { claimResult: input.claimResult } : {}),
      ...(input.author ? { author: input.author } : {}),
    },
    mappings,
    dossiers,
    claims,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  });
}

/**
 * Content-addressed identity of a plan: the same inputs and context produce the
 * same path, and a changed input or mapping set produces a new result without
 * overwriting the earlier one.
 */
export function librarianPlanPath(
  post: { publicationId: string; postId: string },
  plan: LibrarianPlan,
): string {
  // Every exact input version is part of the identity, so a change to the
  // source context, configuration or a mapping's metadata alone is a new plan.
  const pin = (r: PlanRef | null | undefined) =>
    r ? [r.repository, r.commit, r.path, r.sha256] : null;
  const identity = JSON.stringify([
    plan.schemaVersion,
    pin(plan.inputs.source),
    pin(plan.inputs.sourceContext),
    pin(plan.inputs.configuration),
    pin(plan.inputs.themeResult),
    pin(plan.inputs.claimResult),
    plan.inputs.author ? [plan.inputs.author.name, plan.inputs.author.basis] : null,
    plan.dossiers.map((d) => [d.canonicalThemeId, d.action, d.gaps, pin(d.dossierRef)]),
    plan.mappings
      .map((m) => JSON.stringify([m.proposalId, m.canonicalThemeId, m.source, pin(m.mappingRef)]))
      .sort(),
    // The theme a claim belongs to is material even when its coverage and
    // action are unchanged by the reassignment.
    plan.claims.map((c) => [c.claimRecordId, c.canonicalThemeId, c.coverage, c.action]).sort(),
  ]);
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `librarian/plans/${post.publicationId}/${post.postId}/${key}.json`;
}

/**
 * Save the plan write-once, so an earlier plan stays readable. Returns the
 * authoritative saved version: on reuse, that is the plan already stored
 * (whose `createdAt` may differ from the one passed in), not this copy.
 */
export async function saveLibrarianPlan(
  artifacts: Pick<GitArtifactStore, "write" | "lookup" | "read">,
  plan: LibrarianPlan,
): Promise<{ path: string; reused: boolean; ref: ArtifactRef; plan: LibrarianPlan }> {
  const valid = LibrarianPlanSchema.parse(plan);
  const path = librarianPlanPath(
    { publicationId: valid.inputs.publicationId, postId: valid.inputs.postId },
    valid,
  );
  const stored = async () => {
    const ref = await artifacts.lookup(path);
    if (!ref) return undefined;
    const saved = LibrarianPlanSchema.parse(JSON.parse(await artifacts.read(ref)));
    return { path, reused: true, ref, plan: saved };
  };
  const existing = await stored();
  if (existing) return existing;
  try {
    const ref = await artifacts.write(path, `${JSON.stringify(valid, null, 2)}\n`);
    return { path, reused: false, ref, plan: valid };
  } catch (error) {
    // A concurrent assessment of the same inputs may have written first; that
    // stored plan is the authoritative one.
    if (error instanceof ArtifactStoreError && error.code === "immutable-conflict") {
      const raced = await stored();
      if (raced) return raced;
    }
    throw error;
  }
}

/** Read one exact saved plan, current or legacy (schema 1 stays readable). */
export async function readLibrarianPlan(
  artifacts: Pick<GitArtifactStore, "read">,
  ref: ArtifactRef,
): Promise<StoredLibrarianPlan> {
  return StoredLibrarianPlanSchema.parse(JSON.parse(await artifacts.read(ref)));
}
