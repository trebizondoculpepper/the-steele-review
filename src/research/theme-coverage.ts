import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { DossierStore, type Dossier } from "./dossier.js";
import { ThemeStore, type CanonicalTheme } from "./theme-store.js";

/**
 * Research coverage of a canonical theme (#528), resolved through its stable
 * theme ID and derived only from actual dossier evidence.
 *
 * A theme can exist with no research at all. Existence of a dossier is not
 * coverage either: a dossier with no cited, covered claim is still
 * unresearched, and one with gaps or uncited claims is only partially
 * researched. Claim-level questions ("is this claim covered?") are answered
 * from the dossier's per-claim records, never from the theme as a whole.
 */

export type ResearchState =
  "unresearched" | "partially-researched" | "researched";

export interface ThemeCoverage {
  theme: CanonicalTheme;
  state: ResearchState;
  /** Present only when a dossier exists for the theme. */
  dossier?: {
    commit: string;
    hash: string;
    covered: number;
    gaps: number;
    citations: number;
  };
}

export type ClaimCoverageState = "covered" | "gap" | "not-in-dossier";

/** Research state from a dossier's own claim and citation records. */
export function researchState(dossier?: Dossier): ResearchState {
  if (!dossier) return "unresearched";
  const { claims, citations, gaps } = dossier.metadata;
  const covered = claims.filter((c) => c.status === "covered").length;
  if (covered === 0 || citations.length === 0) return "unresearched";
  const uncovered = claims.length - covered;
  return uncovered > 0 || gaps.length > 0
    ? "partially-researched"
    : "researched";
}

/** Per-claim coverage in a theme's dossier; a missing dossier covers nothing. */
export function claimCoverage(
  dossier: Dossier | undefined,
  claimIds: string[],
): Map<string, ClaimCoverageState> {
  const saved = new Map(
    (dossier?.metadata.claims ?? []).map((c) => [c.claimId, c.status]),
  );
  return new Map(claimIds.map((id) => [id, saved.get(id) ?? "not-in-dossier"]));
}

const RANK: Record<ResearchState, number> = {
  unresearched: 0,
  "partially-researched": 1,
  researched: 2,
};

/** Least-researched first; ties keep stable theme-ID order. */
export function rankForResearch(coverage: ThemeCoverage[]): ThemeCoverage[] {
  return [...coverage].sort(
    (a, b) =>
      RANK[a.state] - RANK[b.state] || a.theme.id.localeCompare(b.theme.id),
  );
}

type Store = Pick<
  GitArtifactStore,
  "lookup" | "read" | "write" | "list" | "revise"
>;

/** Coverage of one canonical theme, resolving its research by theme ID. */
export async function themeCoverage(
  artifacts: Store,
  id: string,
): Promise<ThemeCoverage | undefined> {
  const theme = await new ThemeStore(artifacts).get(id);
  if (!theme) return undefined;
  const stored = await new DossierStore(artifacts as never).current(id);
  if (!stored) return { theme, state: "unresearched" };
  const claims = stored.metadata.claims;
  return {
    theme,
    state: researchState(stored),
    dossier: {
      commit: stored.ref.commit,
      hash: stored.ref.sha256,
      covered: claims.filter((c) => c.status === "covered").length,
      gaps: claims.filter((c) => c.status === "gap").length,
      citations: stored.metadata.citations.length,
    },
  };
}
