import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Indexing checkpoints (#942), kept as one JSON file rather than in SQLite.
 *
 * For each collection the checkpoint records:
 * - `live`: the backing index its alias uses, at which mapping version, and
 *   the Git commit that index fully reflects;
 * - `touched`: every document path an unfinished pass may have written since
 *   that commit. It is saved before any write and kept until a pass succeeds,
 *   so every such path is reconciled against the current HEAD (indexed if
 *   present, deleted if absent) however many passes fail in a row, and even if
 *   the revisions those passes applied are later reset or rewritten away;
 * - `staging`: a backing index whose build has not completed. The next build
 *   at the same mapping version reuses it, so a document that keeps failing
 *   costs one retained index, not one per pass.
 *
 * Writes are atomic: a temporary file renamed over the target.
 */

const LiveIndex = z.object({
  backing: z.string(),
  mappingVersion: z.number().int(),
  /** Rebuild number at this mapping version; 0 for the first build. */
  rebuild: z.number().int().min(0),
  /** The commit the backing index fully reflects. */
  commit: z.string(),
  touched: z.array(z.string()).optional(),
});

const StagingIndex = z.object({
  backing: z.string(),
  mappingVersion: z.number().int(),
  rebuild: z.number().int().min(0),
  /** The HEAD the last build attempt indexed. */
  head: z.string(),
  /** Paths still to reconcile in this index (deleted in Git since an earlier attempt); kept until promotion. */
  touched: z.array(z.string()).optional(),
});

const CollectionState = z.object({
  directory: z.string(),
  alias: z.string(),
  live: LiveIndex.optional(),
  staging: StagingIndex.optional(),
  completedAt: z.string().optional(),
});
export type CollectionState = z.infer<typeof CollectionState>;
export type LiveIndex = z.infer<typeof LiveIndex>;
export type StagingIndex = z.infer<typeof StagingIndex>;

export const CheckpointState = z.object({
  schemaVersion: z.literal(1),
  namespace: z.string(),
  collections: z.record(z.string(), CollectionState),
});
export type CheckpointState = z.infer<typeof CheckpointState>;

export interface CheckpointStore {
  load(): Promise<CheckpointState | undefined>;
  save(state: CheckpointState): Promise<void>;
}

export function fileCheckpoint(path: string): CheckpointStore {
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("the indexing checkpoint could not be read");
      }
      const parsed = CheckpointState.safeParse((() => { try { return JSON.parse(text); } catch { return undefined; } })());
      if (!parsed.success) throw new Error("the indexing checkpoint is not valid");
      return parsed.data;
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp-${process.pid}`;
      try {
        // Flushed before the rename, so a power loss cannot leave an empty checkpoint.
        const file = await open(temporary, "w", 0o600);
        try {
          await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}

export function memoryCheckpoint(initial?: CheckpointState): CheckpointStore & { state?: CheckpointState } {
  const store = {
    state: initial,
    async load() {
      return store.state ? structuredClone(store.state) : undefined;
    },
    async save(state: CheckpointState) {
      store.state = structuredClone(state);
    },
  };
  return store;
}
