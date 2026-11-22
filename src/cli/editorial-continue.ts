import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { OperationStore } from "../controllers/operation-store.js";
import {
  EditorialIngressError,
  restateParentCompletion,
  restateEditorialContinuation,
} from "../controllers/editorial-continuation-ingress.js";
import { sourceMetadataFromEnv } from "../content/source-metadata.js";
import { EditorialContinuationInputSchema } from "../drafting/editorial-continuation.js";
import {
  ContinuationRequestIdSchema,
  EditorialContinuationResultSchema,
} from "../content/editorial-continuation-contract.js";
import { editorialPolicyFromEnv } from "../workflow/editorial-contract.js";
import { prepareEditorialContinuation } from "../workflow/editorial-continuation-submission.js";
const USAGE =
  "Usage: editorial-continue --input <private-seed-json> --request-id <stable-id> [--wait-ms <bounded-ms>] [--json]";
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
  if (!values.input || !id.success || !wait.success) {
    console.error(USAGE);
    return 2;
  }
  let seed;
  try {
    const raw = await readFile(values.input, "utf8");
    if (Buffer.byteLength(raw) > 128 * 1024) throw new Error();
    seed = EditorialContinuationInputSchema.parse(JSON.parse(raw));
  } catch {
    console.error("editorial continuation: invalid-input");
    return 2;
  }
  const env = Env.safeParse(process.env);
  if (!env.success) {
    console.error("editorial continuation: invalid configuration");
    return 2;
  }
  let operations: OperationStore | undefined;
  try {
    const c = env.data;
    const content = new GitArtifactStore({
        repoPath: c.STEELE_CONTENT_PATH,
        repository: c.STEELE_CONTENT_REPOSITORY,
      }),
      archive = new GitArtifactStore({
        repoPath: c.STEELE_ARCHIVE_PATH,
        repository: c.STEELE_ARCHIVE_REPOSITORY,
      });
    operations = new OperationStore({ path: c.STEELE_STATE_PATH });
    const prepared = await prepareEditorialContinuation({
      seed,
      requestId: id.data,
      policy: editorialPolicyFromEnv(process.env),
      content,
      archive,
      operations,
      sourceMetadata: sourceMetadataFromEnv(process.env),
      parentCompletion: restateParentCompletion(c.RESTATE_INGRESS_URL),
    });
    const ingress = restateEditorialContinuation(c.RESTATE_INGRESS_URL);
    let submitted;
    try {
      submitted = await ingress.submit(prepared.workflowKey, prepared.input);
    } catch {
      console.error(
        JSON.stringify({
          event: "editorial-continuation",
          key: prepared.workflowKey,
          outcome: "submission-uncertain",
          instruction: "retry-the-same-request-id",
        }),
      );
      return 1;
    }
    const out = {
      event: "editorial-continuation",
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
      const result = EditorialContinuationResultSchema.parse(
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
    console.error("editorial continuation: unavailable-or-invalid-input");
    return 1;
  } finally {
    operations?.close();
  }
}
process.exitCode = await main();
