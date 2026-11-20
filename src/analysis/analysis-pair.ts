/**
 * Validation shared by the analysis handoff steps (#178, #179).
 *
 * A completion — the aggregate post-analysed event and the per-theme/claim
 * fan-out — is only valid when both saved results are readable, describe this
 * post and source version, and the claim result links to exactly this theme
 * result. Centralising it keeps the two handoffs from drifting apart.
 */
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import { ClaimExtractionRecordSchema, type ClaimExtractionRecord } from "./grounded-claims.js";
import { parseThemeProposalResult, type ThemeProposalResult } from "./theme-proposals.js";

export type AnalysisRefusal =
  | "unreadable-theme-result"
  | "unreadable-claim-result"
  | "legacy-claim-result"
  | "post-mismatch"
  | "source-version-mismatch"
  | "theme-result-not-linked";

export type AnalysisPair =
  | { status: "ok"; theme: ThemeProposalResult; claims: ClaimExtractionRecord }
  | { status: "refused"; reason: AnalysisRefusal }
  /** A transient repository failure: the same input may succeed later. */
  | { status: "unavailable" };

/** `commit:path`, the exact reference recorded inside a saved result. */
export const shortRef = (ref: ArtifactRef): string => `${ref.commit}:${ref.path}`;

/** One artifact read, distinguishing a missing result from a repository fault. */
async function readText(
  content: Pick<GitArtifactStore, "read">,
  ref: ArtifactRef,
): Promise<{ ok: true; text: string } | { ok: false; retry: boolean }> {
  try {
    return { ok: true, text: await content.read(ref) };
  } catch (error) {
    // A Git or I/O failure is operational, not evidence the result is absent.
    return {
      ok: false,
      retry: error instanceof ArtifactStoreError && error.code === "git-failed",
    };
  }
}

/** Read and validate the theme/claim pair that completes one analysis. */
export async function readAnalysisPair(
  content: Pick<GitArtifactStore, "read">,
  post: { publicationId: string; postId: string },
  themeRef: ArtifactRef,
  claimRef: ArtifactRef,
): Promise<AnalysisPair> {
  const themeText = await readText(content, themeRef);
  if (!themeText.ok) {
    return themeText.retry
      ? { status: "unavailable" }
      : { status: "refused", reason: "unreadable-theme-result" };
  }
  let theme: ThemeProposalResult;
  try {
    theme = parseThemeProposalResult(JSON.parse(themeText.text));
  } catch {
    return { status: "refused", reason: "unreadable-theme-result" };
  }
  const claimText = await readText(content, claimRef);
  if (!claimText.ok) {
    return claimText.retry
      ? { status: "unavailable" }
      : { status: "refused", reason: "unreadable-claim-result" };
  }
  let claims: ClaimExtractionRecord;
  try {
    claims = ClaimExtractionRecordSchema.parse(JSON.parse(claimText.text));
  } catch {
    return { status: "refused", reason: "unreadable-claim-result" };
  }
  // Only results under the current accepted/candidate contract complete a post.
  if (claims.schemaVersion !== 2) return { status: "refused", reason: "legacy-claim-result" };
  const samePost = (p: { publicationId: string; postId: string }) =>
    p.publicationId === post.publicationId && p.postId === post.postId;
  if (!samePost(theme.post) || !samePost(claims.post)) {
    return { status: "refused", reason: "post-mismatch" };
  }
  if (theme.sourceVersion !== claims.sourceVersion) {
    return { status: "refused", reason: "source-version-mismatch" };
  }
  if (claims.themeResult !== shortRef(themeRef)) {
    return { status: "refused", reason: "theme-result-not-linked" };
  }
  return { status: "ok", theme, claims };
}
