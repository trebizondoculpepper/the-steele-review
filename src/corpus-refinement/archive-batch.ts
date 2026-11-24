import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { CorpusRefinementInputSchema, type CorpusRefinementInput } from "./contracts.js";

/**
 * One reproducible archive batch for the Corpus Refinement experiment (#832).
 *
 * For each named post, in the given order, the latest librarian coverage
 * record is read, and through it the exact claim extraction it assessed. Each
 * claim carries its statement, its saved utterance (the quoted source passage)
 * and whether that record found it covered. Claims are taken in extraction
 * order until the claim or character budget is reached; the rest are recorded
 * as deferred. Read-only: nothing in the archive or content is written.
 */

type Store = Pick<GitArtifactStore, "list" | "read" | "lookup">;
type Ref = { repository: string; commit: string; path: string; hash: string };

const toArtifact = (ref: Ref) => ({
  repository: ref.repository,
  commit: ref.commit,
  path: ref.path,
  sha256: ref.hash.replace(/^sha256:/, ""),
});

interface CoverageRecord {
  claimResult: Ref;
  assessedAt: string;
  claims: { claimRecordId: string; status: string }[];
}
interface ClaimExtraction {
  claims: {
    claimRecordId?: string;
    claim?: { statement?: string };
    occurrence?: { passage?: string };
  }[];
}

export interface ArchiveBatch {
  input: CorpusRefinementInput;
  /** Per post: the coverage record and claim extraction used, by exact version. */
  sources: { post: string; coverage: string; claims: Ref }[];
  /** Posts with no coverage record (skipped, never guessed). */
  missing: string[];
}

export async function buildArchiveBatch(
  content: Store,
  options: { runId: string; posts: string[]; maxClaims: number; maxChars: number },
): Promise<ArchiveBatch> {
  const claims: CorpusRefinementInput["claims"] = [];
  const deferred: string[] = [];
  const sources: ArchiveBatch["sources"] = [];
  const missing: string[] = [];
  let chars = 0;
  for (const post of options.posts) {
    const [publicationId, postId] = post.split("/");
    if (!publicationId || !postId) {
      missing.push(post);
      continue;
    }
    const paths = await content.list(`librarian/coverage/${publicationId}/${postId}`, 200);
    let latest: { path: string; record: CoverageRecord } | undefined;
    for (const path of paths) {
      const ref = await content.lookup(path);
      if (!ref) continue;
      const record = JSON.parse(await content.read(ref)) as CoverageRecord;
      if (!latest || record.assessedAt > latest.record.assessedAt) latest = { path, record };
    }
    if (!latest) {
      missing.push(post);
      continue;
    }
    const extraction = JSON.parse(
      await content.read(toArtifact(latest.record.claimResult)),
    ) as ClaimExtraction;
    sources.push({ post, coverage: latest.path, claims: latest.record.claimResult });
    const status = new Map(latest.record.claims.map((c) => [c.claimRecordId, c.status]));
    for (const c of extraction.claims) {
      const id = c.claimRecordId;
      const statement = c.claim?.statement?.trim();
      if (!id || !statement) continue;
      const utterance = c.occurrence?.passage?.trim().slice(0, 4000);
      const size = statement.length + (utterance?.length ?? 0);
      if (claims.length >= options.maxClaims || chars + size > options.maxChars) {
        deferred.push(id);
        continue;
      }
      chars += size;
      claims.push({
        id,
        statement: statement.slice(0, 2000),
        ...(utterance ? { utterance } : {}),
        covered: status.get(id) === "covered",
        post,
      });
    }
  }
  const input = CorpusRefinementInputSchema.parse({
    runId: options.runId,
    mode: "archive",
    claims,
    deferred,
  });
  return { input, sources, missing };
}
