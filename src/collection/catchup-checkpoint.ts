import { readFile, rename, writeFile } from "node:fs/promises";
import type { CatchUpCheckpointState, CatchUpCheckpointStore } from "./index-catchup.js";

/**
 * The catch-up checkpoint as a JSON file (#249/#250): read when present,
 * written atomically through a temporary file and rename.
 */
export function fileCheckpoint(path: string): CatchUpCheckpointStore {
  return {
    async load(): Promise<CatchUpCheckpointState | undefined> {
      try {
        return JSON.parse(await readFile(path, "utf8")) as CatchUpCheckpointState;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async save(state: CatchUpCheckpointState) {
      const temporary = `${path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
      await rename(temporary, path);
    },
  };
}
