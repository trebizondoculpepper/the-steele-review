import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Indexing checkpoints (#942), kept as one JSON file rather than in SQLite.
 *
 * For each collection the checkpoint records which backing index its alias
 * uses, at which mapping version, and the Git commit that index fully
 * reflects. A pass records `pending` before writing and only moves `commit`
 * after every change succeeded, so an interrupted or failed pass is retried
 * from the last good commit (the pattern of the earlier catch-up indexer,
 * #250). Writes are atomic: a temporary file renamed over the target.
 */

const CollectionState = z.object({
  directory: z.string(),
  alias: z.string(),
  backing: z.string(),
  mappingVersion: z.number().int(),
  /** Number of rebuilds at this mapping version; 0 for the first build. */
  rebuild: z.number().int().min(0),
  /** The commit the backing index fully reflects. */
  commit: z.string().optional(),
  /** A head a pass began applying and has not finished. */
  pending: z.string().optional(),
  completedAt: z.string().optional(),
});
export type CollectionState = z.infer<typeof CollectionState>;

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
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
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
