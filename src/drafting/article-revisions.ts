import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import { articlePaths, type ArticleKey } from "./article-identity.js";

/**
 * Commit draft generations into one logical article in place (#579).
 *
 * Every generation keeps its exact write-once files (the generation result,
 * used for caching, retries and exact-version verification). This step then
 * edits the article's canonical body and metadata paths through
 * `GitArtifactStore.revise`, so the initial draft and each revision are
 * distinct commits of the same documents, with earlier bytes readable at
 * their commits.
 *
 * Safety:
 * - Each generation's canonical result is recorded write-once under the
 *   article. Retrying a completed generation returns that exact record and
 *   never writes again, so an old retry cannot overwrite or roll back newer
 *   content.
 * - Each canonical write names the version it expects to replace. A
 *   concurrent change fails as a conflict instead of being overwritten.
 * - A crash after a canonical write but before its record is reconciled on
 *   retry: identical content already in place is adopted, not rewritten.
 */

const Ref = z
  .object({
    repository: z.string(),
    commit: z.string(),
    path: z.string(),
    sha256: z.string(),
  })
  .strict();

const CommitRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    article: z.string(),
    generation: z.object({ draft: Ref, metadata: Ref }).strict(),
    base: z.object({ body: z.string().nullable(), metadata: z.string().nullable() }).strict(),
    body: Ref,
    metadata: Ref,
  })
  .strict();
export type ArticleCommitRecord = z.infer<typeof CommitRecordSchema>;

/** Expected canonical versions to replace: exact hashes, null for "absent", or the current head. */
export type ArticleBase = { body: string | null; metadata: string | null } | "current";

export type ArticleCommitOutcome =
  | {
      status: "committed" | "reused";
      body: ArtifactRef;
      metadata: ArtifactRef;
      record: ArtifactRef;
    }
  | { status: "conflict" };

type Store = Pick<GitArtifactStore, "lookup" | "read" | "revise" | "write">;

const plainRef = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  sha256: r.sha256,
});

export async function commitArticleRevision(input: {
  content: Store;
  article: ArticleKey;
  generation: { draft: ArtifactRef; metadata: ArtifactRef };
  base: ArticleBase;
}): Promise<ArticleCommitOutcome> {
  const paths = articlePaths(input.article);
  const generationId = createHash("sha256")
    .update(
      JSON.stringify([
        input.generation.draft.path,
        input.generation.draft.sha256,
        input.generation.metadata.path,
        input.generation.metadata.sha256,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  const recordPath = `${paths.dir}/commits/${generationId}.json`;

  const existing = async () => {
    const ref = await input.content.lookup(recordPath);
    if (!ref) return undefined;
    const record = CommitRecordSchema.parse(JSON.parse(await input.content.read(ref)));
    return { status: "reused" as const, body: record.body, metadata: record.metadata, record: ref };
  };
  const done = await existing();
  if (done) return done;

  const body = await input.content.read(input.generation.draft);
  const metadata = await input.content.read(input.generation.metadata);
  const base =
    input.base === "current"
      ? {
          body: (await input.content.lookup(paths.body))?.sha256 ?? null,
          metadata: (await input.content.lookup(paths.metadata))?.sha256 ?? null,
        }
      : input.base;

  let bodyRef: ArtifactRef;
  let metadataRef: ArtifactRef;
  try {
    // `revise` adopts identical content already in place (a crashed retry)
    // and rejects any other unexpected version as stale.
    bodyRef = await input.content.revise(paths.body, body, base.body);
    metadataRef = await input.content.revise(paths.metadata, metadata, base.metadata);
  } catch (error) {
    if (error instanceof ArtifactStoreError && error.code === "stale-revision") {
      // A concurrent writer may have completed this same generation first.
      return (await existing()) ?? { status: "conflict" };
    }
    throw error;
  }

  const record: ArticleCommitRecord = {
    schemaVersion: 1,
    article: paths.id,
    generation: {
      draft: plainRef(input.generation.draft),
      metadata: plainRef(input.generation.metadata),
    },
    base,
    body: plainRef(bodyRef),
    metadata: plainRef(metadataRef),
  };
  try {
    const recordRef = await input.content.write(
      recordPath,
      `${JSON.stringify(CommitRecordSchema.parse(record), null, 2)}\n`,
    );
    return { status: "committed", body: bodyRef, metadata: metadataRef, record: recordRef };
  } catch (error) {
    if (error instanceof ArtifactStoreError && error.code === "immutable-conflict") {
      const winner = await existing();
      if (winner) return winner;
    }
    throw error;
  }
}
