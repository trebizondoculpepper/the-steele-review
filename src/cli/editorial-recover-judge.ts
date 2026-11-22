import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { OperationStore } from "../controllers/operation-store.js";
import { EditorialIngressError } from "../controllers/editorial-continuation-ingress.js";
import {
  restateRecoveryParentCompletion,
  restateJudgeRecovery,
} from "../controllers/editorial-recovery-ingress.js";
import { sourceMetadataFromEnv } from "../content/source-metadata.js";
import { EditorialRecoveryCheckpointSchema } from "../drafting/editorial-recovery-checkpoint.js";
import { ContinuationRequestIdSchema } from "../content/editorial-continuation-contract.js";
import {
  RecoveryGenerationSchema,
  JudgeRecoveryResultSchema,
} from "../content/editorial-judge-recovery-contract.js";
import { editorialPolicyFromEnv } from "../workflow/editorial-contract.js";
import { prepareJudgeRecovery } from "../workflow/editorial-judge-recovery-submission.js";
import { openRouterModelVersion } from "../controllers/openrouter.js";
const USAGE =
  "Usage: editorial-recover-judge --input <private-seed-json> --request-id <stable-id> --generation <number> [--wait-ms <bounded-ms>] [--json]";
const Env = z.object({
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
  STEELE_ARCHIVE_PATH: z.string().min(1),
  STEELE_ARCHIVE_REPOSITORY: z.string().min(1),
  STEELE_STATE_PATH: z.string().min(1),
  RESTATE_INGRESS_URL: z.url(),
});
async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        input: { type: "string" },
        "request-id": { type: "string" },
        generation: { type: "string" },
        "wait-ms": { type: "string" },
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
  const id = ContinuationRequestIdSchema.safeParse(values["request-id"]),
    wait = z.coerce.number().int().min(1).max(3_600_000).optional().safeParse(values["wait-ms"]);
  const generation = RecoveryGenerationSchema.safeParse(Number(values.generation));
  if (!values.input || !id.success || !wait.success || !generation.success) {
    console.error(USAGE);
    return 2;
  }
  let seed;
  try {
    const raw = await readFile(values.input, "utf8");
    if (Buffer.byteLength(raw) > 128 * 1024) throw new Error();
    seed = EditorialRecoveryCheckpointSchema.parse(JSON.parse(raw));
  } catch {
    console.error("editorial judge recovery: invalid-input");
    return 2;
  }
  const env = Env.safeParse(process.env);
  if (!env.success) {
    console.error("editorial judge recovery: invalid configuration");
    return 2;
  }
  let operations: OperationStore | undefined;
  try {
    const c = env.data;
    const configuredWindow = {
      version: "editorial-recovery-window-v1" as const,
      deadlineMs: editorialPolicyFromEnv(process.env).deadlineMs,
    };
    const currentJudge = {
      modelVersion: openRouterModelVersion(
        process.env.STEELE_MODEL_VERIFIER || process.env.STEELE_MODEL || "",
      ),
    };
    const sourceMetadata = sourceMetadataFromEnv(process.env);
    const ingress = restateJudgeRecovery(c.RESTATE_INGRESS_URL);
    const content = new GitArtifactStore({
        repoPath: c.STEELE_CONTENT_PATH,
        repository: c.STEELE_CONTENT_REPOSITORY,
      }),
      archive = new GitArtifactStore({
        repoPath: c.STEELE_ARCHIVE_PATH,
        repository: c.STEELE_ARCHIVE_REPOSITORY,
      });
    operations = new OperationStore({ path: c.STEELE_STATE_PATH });
    const prepared = await prepareJudgeRecovery({
      seed,
      requestId: id.data,
      generation: generation.data,
      window: configuredWindow,
      currentJudge,
      content,
      archive,
      operations,
      sourceMetadata,
      parentCompletion: restateRecoveryParentCompletion(c.RESTATE_INGRESS_URL),
    });
    let submitted;
    try {
      submitted = await ingress.submit(prepared.workflowKey, prepared.input);
    } catch {
      console.error(
        JSON.stringify({
          event: "editorial-judge-recovery",
          key: prepared.workflowKey,
          outcome: "submission-uncertain",
          instruction: "retry-the-same-request-id",
        }),
      );
      return 1;
    }
    const out = {
      event: "editorial-judge-recovery",
      key: prepared.workflowKey,
      invocationId: submitted.invocationId,
      repeated: submitted.repeated,
      repeatedIntent: prepared.repeatedIntent,
    };
    if (!wait.data) {
      console.log(JSON.stringify(out));
      return 0;
    }
    try {
      const result = JudgeRecoveryResultSchema.parse(
        await ingress.attach(prepared.workflowKey, wait.data),
      );
      console.log(JSON.stringify({ ...out, ...result }));
      return result.outcome === "verified" ? 0 : 1;
    } catch (error) {
      if (error instanceof EditorialIngressError && error.code === "timeout") {
        console.log(JSON.stringify({ ...out, waitEnded: "timeout" }));
        return 0;
      }
      throw error;
    }
  } catch {
    console.error("editorial judge recovery: unavailable-or-invalid-input");
    return 1;
  } finally {
    operations?.close();
  }
}
process.exitCode = await main();
