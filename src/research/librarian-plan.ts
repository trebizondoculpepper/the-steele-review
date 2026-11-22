import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactStoreError, type GitArtifactStore } from "../controllers/artifact-store.js";
import type { ThemeMapping } from "./theme-mappings.js";

/**
 * Librarian assessment and research plan (#595).
 *
 * Planning is separated from execution: given the exact post, proposals,
 * claims and author, this resolves reusable mappings and canonical themes
 * without requiring a dossier, inspects existing coverage, and records what
 * should be reused, created or enhanced. It commissions nothing and calls no
 * provider, so a plan existing is never a readiness decision.
 */

export const LIBRARIAN_PLAN_SCHEMA_VERSION = 1;

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);

export const DossierActionSchema = z.enum(["reuse-existing", "create-dossier", "enhance-existing"]);
export type DossierAction = z.infer<typeof DossierActionSchema>;

export const LibrarianPlanSchema = z
  .object({
    schemaVersion: z.literal(LIBRARIAN_PLAN_SCHEMA_VERSION),
    inputs: z
      .object({
        publicationId: z.string().min(1),
        postId: z.string().min(1),
        /** The analysed revision the plan was derived from. */
        sourceVersion: z.string().min(1),
        /** Resolved post authorship, when it is known (#462). */
        author: z
          .object({
            name: z.string().min(1),
            basis: z.enum(["post-byline", "source-configured"]),
          })
          .strict()
          .optional(),
      })
      .strict(),
    mappings: z
      .array(
        z
          .object({
            proposalId: z.string().min(1),
            canonicalThemeId: Id,
            source: z.enum(["catalogue", "new"]),
            rationale: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(200),
    dossiers: z
      .array(
        z
          .object({
            canonicalThemeId: Id,
            action: DossierActionSchema,
            /** Exact dossier revision assessed, when one exists. */
            dossierRef: z.string().min(1).max(400).optional(),
            rationale: z.string().min(1).max(1000),
            gaps: z.array(z.string().min(1).max(500)).max(50),
          })
          .strict(),
      )
      .max(200),
    claims: z
      .array(
        z
          .object({
            claimRecordId: z.string().min(1),
            canonicalThemeId: Id,
            /** `none` when the theme has no dossier yet. */
            coverage: z.enum(["covered", "gap", "none"]),
            action: z.enum(["reuse", "research", "targeted-enhancement"]),
          })
          .strict(),
      )
      .max(2000),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type LibrarianPlan = z.infer<typeof LibrarianPlanSchema>;

export interface PlanProposal {
  id: string;
  title: string;
  description?: string;
}

export interface PlanClaim {
  claimRecordId: string;
  /** Canonical theme the claim's proposal mapped to. */
  canonicalThemeId: string;
}

export interface PlanInputs {
  publicationId: string;
  postId: string;
  sourceVersion: string;
  author?: { name: string; basis: "post-byline" | "source-configured" };
  proposals: PlanProposal[];
  claims: PlanClaim[];
  /** Catalogue decisions already made for these proposals, by proposal id. */
  mappings: Map<string, ThemeMapping>;
  /** Canonical themes that already exist. */
  themes: Set<string>;
  /** Themes with a current dossier, and that dossier's per-claim coverage. */
  dossiers: Map<
    string,
    {
      coverage: Map<string, "covered" | "gap">;
      /** Exact dossier artifact reference (repository@commit:path), when known. */
      ref?: string;
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
    const saved = input.mappings.get(proposal.id);
    const canonicalThemeId =
      saved?.canonicalThemeId ?? proposedThemeId(proposal.title, proposal.description);
    mappings.push({
      proposalId: proposal.id,
      canonicalThemeId,
      source: saved ? "catalogue" : "new",
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
        canonicalThemeId: claim.canonicalThemeId,
        coverage: "none" as const,
        action: "research" as const,
      };
    }
    const dossier = input.dossiers.get(claim.canonicalThemeId);
    const coverage = dossier?.coverage.get(claim.claimRecordId) ?? (dossier ? "gap" : "none");
    return {
      claimRecordId: claim.claimRecordId,
      canonicalThemeId: claim.canonicalThemeId,
      coverage,
      action:
        coverage === "covered"
          ? "reuse"
          : coverage === "gap"
            ? "targeted-enhancement"
            : "research",
    };
  });

  return LibrarianPlanSchema.parse({
    schemaVersion: LIBRARIAN_PLAN_SCHEMA_VERSION,
    inputs: {
      publicationId: input.publicationId,
      postId: input.postId,
      sourceVersion: input.sourceVersion,
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
  const identity = JSON.stringify([
    plan.inputs.sourceVersion,
    plan.inputs.author ? [plan.inputs.author.name, plan.inputs.author.basis] : null,
    plan.dossiers.map((d) => [d.canonicalThemeId, d.action, d.gaps, d.dossierRef ?? null]),
    plan.mappings.map((m) => [m.proposalId, m.canonicalThemeId, m.source]).sort(),
    // The theme a claim belongs to is material even when its coverage and
    // action are unchanged by the reassignment.
    plan.claims
      .map((c) => [c.claimRecordId, c.canonicalThemeId, c.coverage, c.action])
      .sort(),
  ]);
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `librarian/plans/${post.publicationId}/${post.postId}/${key}.json`;
}

/** Save the plan; write-once, so an earlier plan stays readable. */
export async function saveLibrarianPlan(
  artifacts: Pick<GitArtifactStore, "write" | "lookup">,
  plan: LibrarianPlan,
): Promise<{ path: string; reused: boolean }> {
  const path = librarianPlanPath(
    { publicationId: plan.inputs.publicationId, postId: plan.inputs.postId },
    plan,
  );
  if (await artifacts.lookup(path)) return { path, reused: true };
  try {
    await artifacts.write(path, `${JSON.stringify(plan, null, 2)}\n`);
    return { path, reused: false };
  } catch (error) {
    // A concurrent assessment of the same inputs may have written first; the
    // stored plan is equivalent, so report reuse rather than failing.
    if (error instanceof ArtifactStoreError && error.code === "immutable-conflict") {
      return { path, reused: true };
    }
    throw error;
  }
}
