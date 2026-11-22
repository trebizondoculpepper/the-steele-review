import { readFile } from "node:fs/promises";
import { validateRetainedArticleResearch } from "../research/retained-research-source.js";
import { sourceContextFor } from "../content/source-context.js";
import { sourceMetadataFromEnv, postAttribution } from "../content/source-metadata.js";
import {
  researchExecutionFromEnv,
  researchSelectionFor,
  NON_BLOCKING_PACKAGE,
} from "../workflow/research-execution.js";
import { editorialPolicyFromEnv } from "../workflow/editorial-contract.js";
import { recordArticleAttempt, liveEditorialInput } from "../workflow/article-attempt.js";
import { OperationStore } from "../controllers/operation-store.js";
/**
 * Start one unattended article run for a captured post (#243).
 *
 *   article-run --publication-id <id> --post-id <slug> [--deadline-ms <n>] [--research-request-limit <n>] [--request-id <id>] [--recovery-generation <1..100>] [--retained-research-file <private-job-id-json-file>] [--editorial-revisions <n>] [--editorial-deadline-ms <n>] [--wait] [--json]
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
  "Usage: article-run --publication-id <id> --post-id <slug> [--deadline-ms <n>] [--research-request-limit <n>] [--request-id <id>] [--recovery-generation <1..100>] [--retained-research-file <private-job-id-json-file>] [--editorial-revisions <n>] [--editorial-deadline-ms <n>] [--wait] [--json]";
const Env = z.object({
  STEELE_ARCHIVE_PATH: z.string().min(1),
  STEELE_ARCHIVE_REPOSITORY: z.string().min(1),
  RESTATE_INGRESS_URL: z.url(),
  STEELE_STATE_PATH: z.string().min(1).optional(),
  STEELE_CONTENT_PATH: z.string().min(1).optional(),
  STEELE_CONTENT_REPOSITORY: z.string().min(1).optional(),
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
        "recovery-generation": { type: "string" },
        "retained-research-file": { type: "string" },
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
  const generation = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .safeParse(values["recovery-generation"]);
  let retainedResearchJobIds: string[] | undefined;
  if (!generation.success || (values["recovery-generation"] && !values["request-id"])) {
    console.error(USAGE);
    return 2;
  }
  if (values["retained-research-file"]) {
    if (!generation.data || !values["request-id"]) {
      console.error(USAGE);
      return 2;
    }
    try {
      const raw = await readFile(values["retained-research-file"], "utf8");
      if (raw.length > 32_000) throw new Error();
      retainedResearchJobIds = z
        .array(z.string().regex(/^research-[0-9a-f]{32}$/))
        .min(1)
        .max(100)
        .parse(JSON.parse(raw));
      if (new Set(retainedResearchJobIds).size !== retainedResearchJobIds.length) throw new Error();
    } catch {
      console.error("Invalid retained research job selection.");
      return 2;
    }
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
    ...editorialPolicyFromEnv(process.env),
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
    ...(values["request-id"] ? { operatorRequestId: values["request-id"] } : {}),
    source: { namespace: `substack/${post.publicationId}`, itemId: post.postId, artifact: ref },
    sourceVersion: sourceVersionFor(record.text),
    sourceUrl: record.item.url,
    researchDeadlineMs: deadline.data,
    ...(generation.data ? { recoveryGeneration: generation.data } : {}),
    ...(retainedResearchJobIds ? { retainedResearchJobIds } : {}),
    ...researchExecutionFromEnv(),
    ...NON_BLOCKING_PACKAGE,
    ...(requestLimit.data === undefined ? {} : { researchRequestLimit: requestLimit.data }),
    // A retained recovery keeps its exact prefix; others use the allowance.
    ...(retainedResearchJobIds ? {} : researchSelectionFor(requestLimit.data)),
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
      if (retainedResearchJobIds) {
        if (!env.data.STEELE_CONTENT_PATH || !env.data.STEELE_CONTENT_REPOSITORY)
          throw new Error("missing-content-configuration");
        const metadata = sourceMetadataFromEnv(process.env);
        await validateRetainedArticleResearch({
          artifacts: new GitArtifactStore({
            repoPath: env.data.STEELE_CONTENT_PATH,
            repository: env.data.STEELE_CONTENT_REPOSITORY,
          }),
          operations,
          jobIds: retainedResearchJobIds,
          capture: ref,
          post,
          sourceContext: sourceContextFor(record, ref, postAttribution(metadata, record.item), {
            namespace: `substack/${post.publicationId}`,
          }),
        });
      }
      const recorded = recordArticleAttempt(
        operations,
        liveEditorialInput(input),
        values["request-id"],
      );
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
