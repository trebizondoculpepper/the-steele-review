/** Explicit operator authority; never called by model/source-driven stage selection. */
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { OperationStore } from "../controllers/operation-store.js";
import { restateJudgeRecoveryCompletion } from "../controllers/editorial-recovery-ingress.js";
import { OwnerDraftRequestSchema } from "../content/owner-draft-authorization.js";
import { DraftRehearsalError } from "../drafting/draft-rehearsal.js";
import { authorizeOwnerDraftRehearsal } from "../publishing/owner-draft-rehearsal.js";
import { SimulatedDestination } from "../publishing/approved-article.js";
import { SubstackClient } from "../publishing/substack/client.js";
import { SubstackDraftDestination } from "../publishing/substack/destination.js";

const USAGE =
  "Usage: authorize-draft-rehearsal --input <private-json> --request-id <stable-id> --owner-authorized-draft";
const Env = z.object({
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
  STEELE_STATE_PATH: z.string().min(1),
  RESTATE_INGRESS_URL: z.url(),
  STEELE_SUBSTACK_ORIGIN: z.url(),
  STEELE_PUBLISHER_DESTINATION: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .default("substack"),
  STEELE_SUBSTACK_BYLINE_ID: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
});
async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        input: { type: "string" },
        "request-id": { type: "string" },
        "owner-authorized-draft": { type: "boolean" },
      },
      strict: true,
    }));
  } catch {
    console.error(USAGE);
    return 2;
  }
  if (!values.input || !values["request-id"] || values["owner-authorized-draft"] !== true) {
    console.error(USAGE);
    return 2;
  }
  let request;
  try {
    const raw = await readFile(values.input, "utf8");
    if (Buffer.byteLength(raw) > 128 * 1024) throw new Error();
    request = OwnerDraftRequestSchema.parse(JSON.parse(raw));
    if (request.requestId !== values["request-id"]) throw new Error();
  } catch {
    console.error("draft rehearsal: invalid-input");
    return 2;
  }
  const parsed = Env.safeParse(
    Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")),
  );
  if (!parsed.success) {
    console.error("draft rehearsal: invalid-configuration");
    return 2;
  }
  let operations: OperationStore | undefined;
  try {
    const e = parsed.data;
    // Rendering needs target identity, not publishing credentials. This CLI has
    // no session or destination-write capability; the selected operator owns it.
    const client = new SubstackClient({
      origin: e.STEELE_SUBSTACK_ORIGIN,
      session: async () => {
        throw new Error("authorization has no destination session");
      },
    });
    const destination = new SubstackDraftDestination(client, {
      name: e.STEELE_PUBLISHER_DESTINATION,
      ...(e.STEELE_SUBSTACK_BYLINE_ID ? { bylineId: e.STEELE_SUBSTACK_BYLINE_ID } : {}),
    });
    const content = new GitArtifactStore({
      repoPath: e.STEELE_CONTENT_PATH,
      repository: e.STEELE_CONTENT_REPOSITORY,
    });
    operations = new OperationStore({ path: e.STEELE_STATE_PATH });
    const result = await authorizeOwnerDraftRehearsal({
      request,
      content,
      operations,
      parentCompletion: restateJudgeRecoveryCompletion(e.RESTATE_INGRESS_URL),
      destinations: [
        new SimulatedDestination("dummy-a", "draft"),
        new SimulatedDestination("dummy-b", "draft"),
        destination,
      ],
    });
    console.log(JSON.stringify({ event: "owner-draft-rehearsal", ...result }));
    return 0;
  } catch (error) {
    console.error(
      `draft rehearsal: ${error instanceof DraftRehearsalError ? error.code : "unavailable-or-invalid-input"}`,
    );
    return 1;
  } finally {
    operations?.close();
  }
}
process.exitCode = await main();
