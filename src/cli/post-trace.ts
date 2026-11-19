/**
 * Per-post diagnostic trace (#174; contract in doc/architecture/16-diagnostic-cli.md).
 *
 *   post-trace <publication-id> <post-id> [--json]
 *
 * Configuration (environment), each optional; an unconfigured source is
 * reported as `not-configured` rather than guessed:
 *   STEELE_STATE_PATH                                state controller (read-only inspection)
 *   STEELE_ARCHIVE_PATH, STEELE_ARCHIVE_REPOSITORY   captured-source archive
 *   STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY   private content repository
 *   ELASTICSEARCH_URL[_FILE], ELASTICSEARCH_API_KEY[_FILE]   full-text index
 *
 * Read-only: no writes, provisioning, retries, events, model or research
 * calls. Output is allowlisted: statuses, counts, versions and logical
 * references; never source text, payloads, paths, URLs or credentials.
 *
 * Exit: 0 inspected (including failed or stale stages, shown as such);
 * 1 a configured source was unavailable or nothing exists for the post;
 * 2 invalid usage.
 */
import { renderPostTrace, tracePost, traceIncomplete } from "../diagnostics/post-trace.js";
import { stateProbeFor } from "../diagnostics/runtime-status.js";
import { elasticsearchConnection } from "../config/credentials.js";
import { FULLTEXT_INDEX_V1 } from "../content/fulltext-document.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { ElasticsearchController } from "../controllers/elasticsearch.js";

const USAGE = "Usage: post-trace <publication-id> <post-id> [--json]";
const ID = /^[a-z0-9][a-z0-9-]{0,299}$/;

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const json = argv.includes("--json");
  const ids = argv.filter((a) => a !== "--json");
  if (ids.length !== 2 || !ids.every((i) => ID.test(i))) {
    console.error(USAGE);
    return 2;
  }
  const post = { publicationId: ids[0], postId: ids[1] };
  const env = process.env;
  const store = (path?: string, repository?: string) =>
    path && repository ? new GitArtifactStore({ repoPath: path, repository }) : undefined;

  let es: ElasticsearchController | undefined;
  if (env.ELASTICSEARCH_URL || env.ELASTICSEARCH_URL_FILE) {
    try {
      const conn = elasticsearchConnection();
      es = new ElasticsearchController(conn.url, conn.apiKey);
    } catch {
      es = undefined; // reported as unavailable below
    }
  }
  const searchConfigured = Boolean(env.ELASTICSEARCH_URL || env.ELASTICSEARCH_URL_FILE);
  try {
    const trace = await tracePost({
      post,
      ...(env.STEELE_STATE_PATH ? { state: stateProbeFor(env.STEELE_STATE_PATH) } : {}),
      ...(store(env.STEELE_ARCHIVE_PATH, env.STEELE_ARCHIVE_REPOSITORY)
        ? { archive: store(env.STEELE_ARCHIVE_PATH, env.STEELE_ARCHIVE_REPOSITORY)! }
        : {}),
      ...(store(env.STEELE_CONTENT_PATH, env.STEELE_CONTENT_REPOSITORY)
        ? { content: store(env.STEELE_CONTENT_PATH, env.STEELE_CONTENT_REPOSITORY)! }
        : {}),
      ...(searchConfigured
        ? {
            search: {
              fulltextSourceVersion: async (publicationId: string, postId: string) => {
                if (!es) throw new Error("unavailable");
                const hits = await es.search(
                  FULLTEXT_INDEX_V1,
                  { bool: { filter: [{ term: { publicationId } }, { term: { postId } }] } },
                  { size: 1 },
                );
                const v = (hits[0]?.source as { sourceVersion?: unknown } | undefined)
                  ?.sourceVersion;
                return typeof v === "string" ? v : null;
              },
            },
          }
        : {}),
    });
    console.log(json ? JSON.stringify(trace) : renderPostTrace(trace));
    return traceIncomplete(trace) ? 1 : 0;
  } finally {
    await es?.close();
  }
}

// Exit explicitly: a stalled repository read was abandoned after its
// deadline, and its child process must not keep the command alive.
process.exit(await main(process.argv.slice(2)));
