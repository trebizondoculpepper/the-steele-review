import { GitArtifactStore } from "../controllers/artifact-store.js";
import { prepareCapturedArticleSubmission } from "../workflow/captured-article-submission.js";
import { editorialPolicyFromEnv } from "../workflow/editorial-contract.js";
/**
 * Captured-content bridge (#270): consume `steele.v1.content.captured` from a
 * provisioned durable JetStream consumer and submit one `ArticleRun` workflow
 * per live captured item revision. Composition only; the logic lives in
 * workflow/captured-bridge.ts.
 *
 * Configuration (environment):
 *   NATS_URL, NATS_TOKEN?                 broker
 *   STEELE_STATE_PATH                    dedicated bridge failure state
 *   STEELE_CONTENT_STREAM                 stream holding captured-content events (STEELE_CONTENT)
 *   STEELE_CAPTURED_CONSUMER              durable consumer name (provisioned separately)
 *   RESTATE_INGRESS_URL                   Restate ingress, e.g. http://restate:8080
 *   STEELE_ARTICLE_SOURCES                comma-separated source namespaces allowed to start
 *                                         runs, e.g. "substack/saveusnow". Empty: none.
 *   STEELE_RESEARCH_DEADLINE_MS?          research batch deadline (default 1800000)
 *   STEELE_BRIDGE_RETRY_DELAY_MS?         redelivery delay when Restate is unreachable
 *
 * Backfill and reprocess captures never start runs here; use article-run.
 * Status lines are sanitised JSON. SIGTERM/SIGINT stop after the in-flight message.
 */
import * as clients from "@restatedev/restate-sdk-clients";
import { z } from "zod";
import { describeSetupError, natsConnection } from "../config/credentials.js";
import { NatsController } from "../controllers/nats.js";
import { OperationStore } from "../controllers/operation-store.js";
import { ResearchRequestLimitSchema, type ArticleRunApi } from "../workflow/article-run.js";
import { handleCapturedContent, settleCapturedDelivery } from "../workflow/captured-bridge.js";

const EnvSchema = z.object({
  STEELE_STATE_PATH: z.string().min(1),
  STEELE_CONTENT_PATH: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  STEELE_CONTENT_REPOSITORY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  STEELE_CONTENT_STREAM: z.string().min(1),
  STEELE_CAPTURED_CONSUMER: z.string().min(1),
  RESTATE_INGRESS_URL: z.url(),
  STEELE_ARTICLE_SOURCES: z.string().default(""),
  STEELE_RESEARCH_REQUEST_LIMIT: z.preprocess(
    (raw) => (raw === "" ? undefined : raw),
    z.coerce.number().pipe(ResearchRequestLimitSchema).optional(),
  ),
  STEELE_RESEARCH_DEADLINE_MS: z.coerce.number().int().min(1_000).max(86_400_000).optional(),
  STEELE_BRIDGE_RETRY_DELAY_MS: z.coerce.number().int().positive().optional(),
});

async function main(): Promise<number> {
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`captured-bridge: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const c = env.data;
  if (!!c.STEELE_CONTENT_PATH !== !!c.STEELE_CONTENT_REPOSITORY) {
    console.error("captured-bridge: incomplete article artifact configuration");
    return 2;
  }
  const content =
    c.STEELE_CONTENT_PATH && c.STEELE_CONTENT_REPOSITORY
      ? new GitArtifactStore({
          repoPath: c.STEELE_CONTENT_PATH,
          repository: c.STEELE_CONTENT_REPOSITORY,
        })
      : undefined;
  let natsConn;
  try {
    natsConn = natsConnection();
  } catch (error) {
    console.error(`captured-bridge: ${describeSetupError(error)}`);
    return 2;
  }
  const enabledSources = new Set(
    c.STEELE_ARTICLE_SOURCES.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const ingress = clients.connect({ url: c.RESTATE_INGRESS_URL });
  const nats = new NatsController(natsConn.url, natsConn.token);
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort());
  process.once("SIGINT", () => abort.abort());
  let operations: OperationStore | undefined;
  try {
    const state = (operations = new OperationStore({ path: c.STEELE_STATE_PATH }));
    await nats.connect("steele-captured-bridge");
    console.log(
      JSON.stringify({
        event: "captured-bridge",
        state: "consuming",
        enabledSources: [...enabledSources],
      }),
    );
    await nats.consume(
      c.STEELE_CONTENT_STREAM,
      c.STEELE_CAPTURED_CONSUMER,
      async (message) => {
        const decision = await handleCapturedContent(new TextDecoder().decode(message.data), {
          enabledSources,
          researchRequestLimit: c.STEELE_RESEARCH_REQUEST_LIMIT,
          editorialPolicy: editorialPolicyFromEnv(process.env),
          researchDeadlineMs: c.STEELE_RESEARCH_DEADLINE_MS ?? 30 * 60_000,
          ...(c.STEELE_BRIDGE_RETRY_DELAY_MS
            ? { retryDelayMs: c.STEELE_BRIDGE_RETRY_DELAY_MS }
            : {}),
          submit: async (key, input) => {
            if (content) {
              const prepared = await prepareCapturedArticleSubmission({
                article: input,
                content,
                operations: state,
              });
              if (prepared.workflowKey !== key)
                throw new Error("captured article identity mismatch");
              input = prepared.input;
            }
            const wf = ingress.workflowClient<ArticleRunApi>({ name: "ArticleRun" }, key);
            // Restate reports an existing run for this key as PreviouslyAccepted.
            const submission = await wf.workflowSubmit(input);
            return submission.status === "PreviouslyAccepted" ? "already-running" : "started";
          },
        });
        console.log(JSON.stringify({ event: "captured-bridge", ...decision }));
        await settleCapturedDelivery(message, decision, state);
      },
      abort.signal,
    );
    return 0;
  } catch {
    console.error(JSON.stringify({ event: "captured-bridge", state: "failed" }));
    return 1;
  } finally {
    operations?.close();
    await nats.close();
    console.log(JSON.stringify({ event: "captured-bridge", state: "stopped" }));
  }
}

process.exitCode = await main();
