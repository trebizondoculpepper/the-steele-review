import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@elastic/elasticsearch";

import { fileCheckpoint } from "./checkpoint.js";
import { GitRepository } from "./git.js";
import { DEFAULT_NAMESPACE, validateNamespace } from "./names.js";
import { reconcileCollections, type ReconcileReport } from "./reconcile.js";
import { ElasticsearchIndex } from "./search-index.js";

export { reconcileCollections, type ReconcileReport } from "./reconcile.js";

/**
 * Deployment wiring for collection indexing (#942). Everything comes from the
 * environment the private deployment supplies; the real paths and endpoints
 * are never in the repository.
 *
 * - STEELE_APP_DIR: the application directory. The collections root is
 *   `<STEELE_APP_DIR>/collections` (a Git repository) and the checkpoint is
 *   `<STEELE_APP_DIR>/state/collection-index.json`, unless overridden by
 *   STEELE_COLLECTIONS_ROOT or STEELE_COLLECTIONS_CHECKPOINT.
 * - STEELE_INDEX_NAMESPACE: index and alias prefix, default `steele-review`.
 * - ELASTICSEARCH_URL, and optionally ELASTICSEARCH_API_KEY or
 *   ELASTICSEARCH_API_KEY_FILE.
 */
export function collectionIndexerFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const appDir = env.STEELE_APP_DIR;
  const root = env.STEELE_COLLECTIONS_ROOT ?? (appDir ? join(appDir, "collections") : undefined);
  const checkpointPath = env.STEELE_COLLECTIONS_CHECKPOINT ?? (appDir ? join(appDir, "state", "collection-index.json") : undefined);
  if (!root || !checkpointPath) throw new Error("set STEELE_APP_DIR, or STEELE_COLLECTIONS_ROOT and STEELE_COLLECTIONS_CHECKPOINT");
  if (!env.ELASTICSEARCH_URL) throw new Error("set ELASTICSEARCH_URL");
  const namespace = validateNamespace(env.STEELE_INDEX_NAMESPACE || DEFAULT_NAMESPACE);
  const apiKey = env.ELASTICSEARCH_API_KEY_FILE ? readFileSync(env.ELASTICSEARCH_API_KEY_FILE, "utf8").trim() : env.ELASTICSEARCH_API_KEY;
  const client = new Client({ node: env.ELASTICSEARCH_URL, ...(apiKey ? { auth: { apiKey } } : {}) });
  const options = {
    repo: new GitRepository(root),
    index: new ElasticsearchIndex(client, namespace),
    checkpoint: fileCheckpoint(checkpointPath),
    namespace,
  };
  return {
    namespace,
    /** One pass; call it after each commit notification and on a schedule. */
    reconcile: (rebuild?: readonly string[] | "all"): Promise<ReconcileReport> => reconcileCollections({ ...options, rebuild }),
  };
}
