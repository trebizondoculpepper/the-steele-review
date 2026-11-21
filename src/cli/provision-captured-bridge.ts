import { z } from "zod";
import { natsConnection } from "../config/credentials.js";
import { NatsController } from "../controllers/nats.js";
import { provisionDurableConsumer } from "../controllers/nats-provision.js";
import { CAPTURED_CONTENT_SUBJECT } from "../events/captured-content-event.js";

import { CAPTURE_BRIDGE_MAX_DELIVER } from "../workflow/captured-bridge.js";

const Env = z.object({
  STEELE_CONTENT_STREAM: z.string().min(1).default("STEELE_CONTENT"),
  STEELE_CAPTURED_CONSUMER: z.string().min(1),
});

async function main(): Promise<number> {
  const config = Env.safeParse(process.env);
  if (!config.success) {
    console.error("capture bridge provisioning: invalid stream or consumer configuration");
    return 2;
  }

  let nats: NatsController | undefined;
  try {
    const { url, token } = natsConnection();
    nats = new NatsController(url, token);
    await nats.connect("steele-provision-captured-bridge");
    const result = await provisionDurableConsumer(nats, {
      stream: config.data.STEELE_CONTENT_STREAM,
      name: config.data.STEELE_CAPTURED_CONSUMER,
      filterSubject: CAPTURED_CONTENT_SUBJECT,
      newOnly: true,
      maxDeliver: CAPTURE_BRIDGE_MAX_DELIVER,
    });
    console.log(JSON.stringify({ event: "capture-bridge-provisioned", result }));
    return 0;
  } catch {
    console.error("capture bridge provisioning: failed or conflicting consumer");
    return 1;
  } finally {
    await nats?.close();
  }
}

process.exitCode = await main();
