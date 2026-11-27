import { join } from "node:path";

/** The collections repository: STEELE_COLLECTIONS_ROOT, or `<STEELE_APP_DIR>/collections`. */
export function collectionsRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.STEELE_COLLECTIONS_ROOT ?? (env.STEELE_APP_DIR ? join(env.STEELE_APP_DIR, "collections") : undefined);
}
