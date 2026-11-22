import { researchExecutionFromEnv } from "../workflow/research-execution.js";
import { DEFAULT_EDITORIAL_POLICY } from "../workflow/editorial-contract.js";
import { recordArticleAttempt } from "../workflow/article-attempt.js";
import { OperationStore } from "../controllers/operation-store.js";
/**
 * Start one unattended article run for a captured post (#243).
 *
 *   article-run --publication-id <id> --post-id <slug> [--deadline-ms <n>] [--research-request-limit <n>] [--request-id <id>] [--editorial-revisions <n>] [--editorial-deadline-ms <n>] [--wait] [--json]
 *
 * Reads the captured post to find its exact source version, then submits the
 * `ArticleRun` workflow keyed by publication, post and source version. A
 * repeated trigger for the same revision attaches to the existing run instead
 * of starting another. Prints the workflow key; with --wait, waits for and
 * prints the outcome and artifact references.
 *
 * Configuration (environment):
 *   STEELE_ARCHIVE_PATH, STEELE_ARCHIVE_REPOSITORY   captured sources (read only)
 *   RESTATE_INGRESS_URL                              Restate ingress, e.g. http://restate:8080
 */
import { parseArgs } from "node:util";
import * as clients from "@restatedev/restate-sdk-clients";
import { z } from "zod";
import { collectionArtifactPath, CollectionRecordSchema } from "../collection/collection-store.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import {
  articleRunKey,
  ResearchRequestLimitSchema,
  ArticleRunInputSchema,
  type ArticleRunApi,
} from "../workflow/article-run.js";

const USAGE =
  "Usage: article-run --publication-id <id> --post-id <slug> [--deadline-ms <n>] [--research-request-limit <n>] [--request-id <id>] [--editorial-revisions <n>] [--editorial-deadline-ms <n>] [--wait] [--json]";
const Env = z.object({
  STEELE_ARCHIVE_PATH: z.string().min(1),
  STEELE_ARCHIVE_REPOSITORY: z.string().min(1),
  RESTATE_INGRESS_URL: z.url(),
  STEELE_STATE_PATH: z.string().min(1).optional(),
});
const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/);

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        "publication-id": { type: "string" },
        "post-id": { type: "string" },
        "deadline-ms": { type: "string" },
        "research-request-limit": { type: "string" },
        "request-id": { type: "string" },
        "editorial-revisions": { type: "string" },
        "editorial-deadline-ms": { type: "string" },
        wait: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
      strict: true,
    }));
  } catch {
    console.error(USAGE);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const pub = Id.safeParse(values["publication-id"]);
  const postId = Id.safeParse(values["post-id"]);
  const deadline = z.coerce
    .number()
    .int()
    .min(1_000)
    .max(86_400_000)
    .default(30 * 60_000)
    .safeParse(values["deadline-ms"]);
  const requestLimit = z.coerce
    .number()
    .pipe(ResearchRequestLimitSchema)
    .optional()
    .safeParse(values["research-request-limit"]);
  if (!pub.success || !postId.success || !deadline.success || !requestLimit.success) {
    console.error(USAGE);
    return 2;
  }
  const env = Env.safeParse(process.env);
  if (!env.success) {
    console.error(
      `article-run: invalid or missing configuration: ${[...new Set(env.error.issues.map((i) => i.path.join(".")))].join(", ")}`,
    );
    return 2;
  }
  const archive = new GitArtifactStore({
    repoPath: env.data.STEELE_ARCHIVE_PATH,
    repository: env.data.STEELE_ARCHIVE_REPOSITORY,
  });
  const post = { publicationId: pub.data, postId: postId.data };
  const ref = await archive.lookup(collectionArtifactPath(post));
  if (!ref) {
    console.error(JSON.stringify({ event: "article-run", outcome: "not-captured" }));
    return 1;
  }
  const record = CollectionRecordSchema.parse(JSON.parse(await archive.read(ref)));
  const policy = {
    ...DEFAULT_EDITORIAL_POLICY,
    ...(values["editorial-revisions"] !== undefined
      ? { maxRevisions: Number(values["editorial-revisions"]) }
      : {}),
    ...(values["editorial-deadline-ms"] !== undefined
      ? { deadlineMs: Number(values["editorial-deadline-ms"]) }
      : {}),
  };
  let input = {
    ...post,
    editorial: policy,
    source: { namespace: `substack/${post.publicationId}`, itemId: post.postId, artifact: ref },
    sourceVersion: sourceVersionFor(record.text),
    sourceUrl: record.item.url,
    researchDeadlineMs: deadline.data,
    ...researchExecutionFromEnv(),
    ...(requestLimit.data === undefined ? {} : { researchRequestLimit: requestLimit.data }),
  };
  if (!ArticleRunInputSchema.safeParse(input).success) {
    console.error(USAGE);
    return 2;
  }
  let key = articleRunKey(input);
  if (values["request-id"]) {
    if (!env.data.STEELE_STATE_PATH) {
      console.error("article-run: missing configuration: STEELE_STATE_PATH");
      return 2;
    }
    const operations = new OperationStore({ path: env.data.STEELE_STATE_PATH });
    try {
      const recorded = recordArticleAttempt(operations, input, values["request-id"]);
      key = recorded.identity.workflowKey;
      input = recorded.input as typeof input;
    } catch {
      console.error("article-run: request identity conflict or invalid input");
      return 2;
    } finally {
      operations.close();
    }
  }
  const ingress = clients.connect({ url: env.data.RESTATE_INGRESS_URL });
  const wf = ingress.workflowClient<ArticleRunApi>({ name: "ArticleRun" }, key);
  let submitted: "started" | "already-running";
  try {
    // Restate reports an existing run for this key as PreviouslyAccepted.
    const submission = await wf.workflowSubmit(input);
    submitted = submission.status === "PreviouslyAccepted" ? "already-running" : "started";
  } catch {
    // Unavailable or rejected: nothing may have been started, so say so.
    console.error(JSON.stringify({ event: "article-run", key, outcome: "submission-failed" }));
    return 1;
  }
  if (!values.wait) {
    const out = { event: "article-run", key, submitted };
    console.log(values.json ? JSON.stringify(out) : `Article run ${key}: ${submitted}.`);
    return 0;
  }
  const result = await wf.workflowAttach();
  console.log(JSON.stringify({ event: "article-run", key, submitted, ...result }));
  return result.outcome === "verified" || result.outcome === "drafted-unverified" ? 0 : 1;
}

process.exitCode = await main();
