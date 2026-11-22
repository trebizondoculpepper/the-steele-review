/**
 * Operator command: deliberately reingest one post (#558), including a post
 * whose collection already succeeded, so its capture record is rebuilt with
 * the current schema and provenance and revised in place at its stable path.
 *
 *   reingest-item --post-id <slug> --request-id <slug> [--max-scan <n>]
 *
 * The request id is the stable identity of this reingestion: repeating the
 * command with the same id does nothing new. Fresh source is fetched by the
 * running collector; an existing transcript is reused rather than paid for
 * again. Old versions stay readable at their commits.
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
import { requestReingest, REQUEST_ID } from "../collection/reingest.js";
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
  const USAGE = "Usage: reingest-item --post-id <slug> --request-id <slug> [--max-scan <n>]";
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) {
      console.error(USAGE);
      return 2;
    }
    opts.set(argv[i]!, argv[i + 1]!);
  }
  const postId = opts.get("--post-id") ?? "";
  const requestId = opts.get("--request-id") ?? "";
  const maxScan = Number.parseInt(opts.get("--max-scan") ?? "1000", 10);
  if (
    !/^[a-z0-9][a-z0-9-]{0,299}$/.test(postId) ||
    !REQUEST_ID.test(requestId) ||
    !Number.isInteger(maxScan) ||
    maxScan < 1 ||
    maxScan > 10_000 ||
    [...opts.keys()].some((k) => !["--post-id", "--request-id", "--max-scan"].includes(k))
  ) {
    console.error(USAGE);
    return 2;
  }
  const args = { postId, maxScan };
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`reingest-item: invalid or missing configuration: ${fields.join(", ")}`);
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
        event: "reingest-request",
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
        event: "reingest-request",
        postId: args.postId,
        outcome: "post-not-found",
      }),
    );
    return 1;
  }
  const operations = new OperationStore({ path: c.STEELE_STATE_PATH });
  try {
    const result = requestReingest({
      operations,
      item,
      requestId,
      ...(c.STEELE_DISCOVERY_SUBJECT ? { subject: c.STEELE_DISCOVERY_SUBJECT } : {}),
    });
    console.log(
      JSON.stringify({
        event: "reingest-request",
        publicationId: item.publicationId,
        postId: item.postId,
        ...result,
      }),
    );
    return result.outcome === "conflicting-request" ? 1 : 0;
  } finally {
    operations.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
