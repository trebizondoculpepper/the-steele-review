import { join } from "node:path";
import { Client } from "@elastic/elasticsearch";
import { z } from "zod";

import { ConfigDirectory, ConfigError, type ConfigSection } from "../common/config/index.js";
import { fileCheckpoint } from "./checkpoint.js";
import { GitRepository } from "./git.js";
import { DEFAULT_NAMESPACE, validateNamespace } from "./names.js";
import { reconcileCollections, type ReconcileReport } from "./reconcile.js";
import { ElasticsearchIndex } from "./search-index.js";

export { reconcileCollections, type ReconcileReport } from "./reconcile.js";

/**
 * Deployment wiring for collection indexing (#942).
 *
 * The Elasticsearch connection comes from the canonical configuration
 * directory (STEELE_CONFIG_PATH, see src/common/config) and is read again on
 * every pass, with a new client each time: a rotated or removed key takes
 * effect on the next pass and is never kept in memory between passes.
 *
 *   elasticsearch/connection.json   {"url": "...", "apiKeyFile": "elasticsearch/api.key"}
 *
 * `apiKeyFile` is optional and relative to the configuration root.
 *
 * Paths and naming come from the environment the private deployment supplies;
 * the real paths are never in the repository:
 * - STEELE_APP_DIR: the application directory. The collections root is
 *   `<STEELE_APP_DIR>/collections` (a Git repository) and the checkpoint is
 *   `<STEELE_APP_DIR>/state/collection-index.json`, unless overridden by
 *   STEELE_COLLECTIONS_ROOT or STEELE_COLLECTIONS_CHECKPOINT.
 * - STEELE_INDEX_NAMESPACE: index and alias prefix, default `steele-review`.
 */

const HttpUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}, "must be an http(s) URL without credentials");

export const ElasticsearchConnectionSection: ConfigSection<{ url: string; apiKeyFile?: string }> = {
  file: "elasticsearch/connection.json",
  schema: z.strictObject({ url: HttpUrl, apiKeyFile: z.string().min(1).optional() }),
};

/** A client built from the configuration as it is now. */
export async function elasticsearchClient(config: ConfigDirectory): Promise<Client> {
  const connection = await config.read(ElasticsearchConnectionSection);
  let apiKey: string | undefined;
  if (connection.apiKeyFile) {
    const text = await config.readText(connection.apiKeyFile);
    if (text === undefined) throw new ConfigError("missing", connection.apiKeyFile);
    apiKey = text.trim();
    if (!apiKey) throw new ConfigError("malformed", connection.apiKeyFile, [], "the file is empty");
  }
  return new Client({ node: connection.url, ...(apiKey ? { auth: { apiKey } } : {}) });
}

export function collectionIndexerFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const config = ConfigDirectory.fromEnv(env);
  const appDir = env.STEELE_APP_DIR;
  const root = env.STEELE_COLLECTIONS_ROOT ?? (appDir ? join(appDir, "collections") : undefined);
  const checkpointPath = env.STEELE_COLLECTIONS_CHECKPOINT ?? (appDir ? join(appDir, "state", "collection-index.json") : undefined);
  if (!root || !checkpointPath) throw new Error("set STEELE_APP_DIR, or STEELE_COLLECTIONS_ROOT and STEELE_COLLECTIONS_CHECKPOINT");
  const namespace = validateNamespace(env.STEELE_INDEX_NAMESPACE || DEFAULT_NAMESPACE);
  const repo = new GitRepository(root);
  const checkpoint = fileCheckpoint(checkpointPath);
  return {
    namespace,
    /** One pass; call it after each commit notification and on a schedule. */
    async reconcile(rebuild?: readonly string[] | "all"): Promise<ReconcileReport> {
      const client = await elasticsearchClient(config);
      try {
        return await reconcileCollections({ repo, index: new ElasticsearchIndex(client, namespace), checkpoint, namespace, rebuild });
      } finally {
        await client.close();
      }
    },
  };
}
