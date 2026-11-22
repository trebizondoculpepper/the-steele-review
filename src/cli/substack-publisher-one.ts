import { draftDeliveryConfiguration } from "../publishing/draft-delivery-configuration.js";
/** Explicit one-event draft delivery; never enables the continuous publisher. */
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { natsConnection } from "../config/credentials.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { OperationStore } from "../controllers/operation-store.js";
import { NatsController } from "../controllers/nats.js";
import { PUBLICATION_STREAM } from "../events/article-approved-event.js";
import { SubstackClient } from "../publishing/substack/client.js";
import { SubstackDraftDestination } from "../publishing/substack/destination.js";
import {
  runSelectedPublisher,
  SelectedPublisherError,
  SelectedPublisherInputSchema,
} from "../publishing/selected-publisher.js";

const USAGE = "Usage: substack-publisher-one --event-id ID --sequence N [--wait-ms N]";
const Env = z.object({
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
  STEELE_STATE_PATH: z.string().min(1),
  STEELE_SUBSTACK_ORIGIN: z.url({ protocol: /^https$/ }),
  STEELE_SUBSTACK_SESSION_FILE: z.string().min(1),
  STEELE_SUBSTACK_BYLINE_ID: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
  STEELE_PUBLISHER_DESTINATION: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .default("substack"),
  STEELE_PUBLICATION_STREAM: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .default(PUBLICATION_STREAM),
  STEELE_PUBLISHER_DELAY_MS: z.coerce.number().int().min(0).default(0),
  STEELE_PUBLISHER_RETRY_DELAY_MS: z.coerce.number().int().positive().default(30_000),
});
async function main() {
  let selection;
  try {
    const { values } = parseArgs({
      options: {
        "event-id": { type: "string" },
        sequence: { type: "string" },
        "wait-ms": { type: "string" },
      },
      strict: true,
    });
    selection = SelectedPublisherInputSchema.parse({
      eventId: values["event-id"],
      sequence: Number(values.sequence),
      ...(values["wait-ms"] ? { waitMs: Number(values["wait-ms"]) } : {}),
    });
  } catch {
    console.error(USAGE);
    return 2;
  }
  const env = Env.safeParse(
    Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")),
  );
  if (!env.success) {
    console.error("selected publisher: invalid configuration");
    return 2;
  }
  const c = env.data;
  let nats: NatsController | undefined, operations: OperationStore | undefined;
  try {
    const connection = natsConnection();
    const session = async () => (await readFile(c.STEELE_SUBSTACK_SESSION_FILE, "utf8")).trim();
    if (!(await session())) throw new Error();
    const deliveryControl = draftDeliveryConfiguration().control;
    const destination = new SubstackDraftDestination(
      new SubstackClient({ origin: c.STEELE_SUBSTACK_ORIGIN, session }),
      {
        name: c.STEELE_PUBLISHER_DESTINATION,
        deliveryControl,
        ...(c.STEELE_SUBSTACK_BYLINE_ID ? { bylineId: c.STEELE_SUBSTACK_BYLINE_ID } : {}),
      },
    );
    operations = new OperationStore({ path: c.STEELE_STATE_PATH });
    const content = new GitArtifactStore({
      repoPath: c.STEELE_CONTENT_PATH,
      repository: c.STEELE_CONTENT_REPOSITORY,
    });
    nats = new NatsController(connection.url, connection.token);
    await nats.connect("steele-selected-publisher");
    const result = await runSelectedPublisher({
      selection,
      nats,
      stream: c.STEELE_PUBLICATION_STREAM,
      content,
      operations,
      destination,
      deliveryControl,
      owner: `selected-publisher:${process.pid}`,
      delayMs: c.STEELE_PUBLISHER_DELAY_MS,
      retryDelayMs: c.STEELE_PUBLISHER_RETRY_DELAY_MS,
    });
    console.log(JSON.stringify({ event: "selected-publisher", ...result }));
    return result.status === "stopped" ? 1 : 0;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "selected-publisher",
        reason: error instanceof SelectedPublisherError ? error.code : "unavailable",
      }),
    );
    return 1;
  } finally {
    await nats?.close();
    operations?.close();
  }
}
process.exitCode = await main();
