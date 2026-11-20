/**
 * Ask the research index worker to reconcile one route (#232).
 *
 *   research-reindex --route <name> [--json]
 *
 * Publishes the same typed request an external scheduler can send. The
 * worker reconciles changes since its checkpoint; this is not a forced
 * rebuild. Prints the request ID and broker acknowledgment only.
 *
 * Configuration (environment): NATS_URL, NATS_TOKEN[_FILE]?, STEELE_RESEARCH_STREAM?
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { describeSetupError, natsConnection } from "../config/credentials.js";
import { NatsController } from "../controllers/nats.js";
import { RESEARCH_STREAM } from "../events/research-completed-event.js";
import {
  RESEARCH_REINDEX_SUBJECT,
  RouteName,
  createResearchReindexEvent,
} from "../events/research-reindex-event.js";

const USAGE = "Usage: research-reindex --route <name> [--json]";

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: { route: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" } },
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
  const route = RouteName.safeParse(values.route);
  if (!route.success) {
    console.error(USAGE);
    return 2;
  }
  let conn;
  try {
    conn = natsConnection();
  } catch (error) {
    console.error(`research-reindex: ${describeSetupError(error)}`);
    return 2;
  }
  const id = `reindex-${randomUUID()}`;
  const event = createResearchReindexEvent({ route: route.data }, { id, now: () => new Date() });
  const nats = new NatsController(conn.url, conn.token);
  try {
    await nats.connect("steele-research-reindex");
    const receipt = await nats.publish(
      RESEARCH_REINDEX_SUBJECT,
      new TextEncoder().encode(JSON.stringify(event.toJSON())),
      { msgId: id, expectStream: process.env.STEELE_RESEARCH_STREAM || RESEARCH_STREAM },
    );
    const out = {
      event: "research-reindex",
      route: route.data,
      requestId: id,
      published: true,
      duplicate: receipt.duplicate ?? false,
    };
    console.log(
      values.json
        ? JSON.stringify(out)
        : `Requested reconciliation of route ${route.data} (${id}).`,
    );
    return 0;
  } catch {
    console.error(
      JSON.stringify({ event: "research-reindex", route: route.data, published: false }),
    );
    return 1;
  } finally {
    await nats.close();
  }
}

process.exitCode = await main();
