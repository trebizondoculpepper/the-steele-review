/**
 * Operator command: deliberately retry one post whose collection ended in a
 * retryable terminal outcome (today only transcription-unavailable), #137.
 *
 *   retry-collection --post-id <slug> [--max-scan <n>]
 *
 * Configuration (environment), matching the collector it runs beside:
 *   STEELE_PUBLICATION_URL   public HTTPS publication base URL
 *   STEELE_PUBLICATION_ID    the publication the post belongs to
 *   STEELE_STATE_PATH        absolute path of the collector's SQLite state file
 *   STEELE_DISCOVERY_SUBJECT optional; must match the subject the collector consumes
 *
 * The post's metadata is re-read from the public archive (bounded scan), so
 * the redelivered discovery event carries validated source metadata. The
 * state controller reopens the operation and records the event in one
 * transaction; the running collector publishes it. One post per invocation;
 * repeating the command is safe. Output is one JSON line with identities and
 * the outcome only.
 */
import { z } from "zod";
import { RETRY_USAGE, parseRetryArgs, retryCollection } from "../collection/retry.js";
import type { SubstackItem } from "../content/substack-item.js";
import { OperationStore } from "../controllers/operation-store.js";
import { SubstackArchiveDiscovery } from "../controllers/substack/archive.js";

const EnvSchema = z.object({
  STEELE_PUBLICATION_URL: z.url({ protocol: /^https$/ }),
  STEELE_PUBLICATION_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
  STEELE_STATE_PATH: z.string().min(1),
  STEELE_DISCOVERY_SUBJECT: z.string().min(1).optional(),
});

async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseRetryArgs(argv);
  } catch {
    console.error(RETRY_USAGE);
    return 2;
  }
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`retry-collection: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const c = env.data;
  const host = new URL(c.STEELE_PUBLICATION_URL).hostname;
  const discovery = new SubstackArchiveDiscovery({
    publicationUrl: c.STEELE_PUBLICATION_URL,
    publicationId: c.STEELE_PUBLICATION_ID,
  });
  let item: SubstackItem | undefined;
  try {
    for await (const candidate of discovery.getHistoricalItems({
      maxItems: args.maxScan,
    })) {
      if (candidate.postId === args.postId) {
        item = candidate;
        break;
      }
    }
  } catch {
    console.error(
      JSON.stringify({
        event: "collection-retry",
        postId: args.postId,
        outcome: "lookup-failed",
      }),
    );
    return 1;
  }
  if (
    !item ||
    new URL(item.url).hostname !== host ||
    item.publicationId !== c.STEELE_PUBLICATION_ID
  ) {
    console.error(
      JSON.stringify({
        event: "collection-retry",
        postId: args.postId,
        outcome: "post-not-found",
      }),
    );
    return 1;
  }
  const operations = new OperationStore({ path: c.STEELE_STATE_PATH });
  try {
    const result = retryCollection({
      operations,
      item,
      ...(c.STEELE_DISCOVERY_SUBJECT ? { subject: c.STEELE_DISCOVERY_SUBJECT } : {}),
    });
    console.log(
      JSON.stringify({
        event: "collection-retry",
        publicationId: item.publicationId,
        postId: item.postId,
        ...result,
      }),
    );
    return result.outcome === "reopened" || result.outcome === "already-reopened" ? 0 : 1;
  } finally {
    operations.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
