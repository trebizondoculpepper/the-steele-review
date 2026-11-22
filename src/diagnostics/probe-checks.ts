import type { ElasticsearchConnection, NatsConnection } from "../config/credentials.js";
import { ElasticsearchController } from "../controllers/elasticsearch.js";
import { NatsController } from "../controllers/nats.js";

/**
 * Shared read-only dependency checks for role probes (#323). Each opens its
 * own client and closes it; none creates, consumes or acknowledges anything.
 */

/** The broker answers. */
export const brokerCheck = (nats: NatsConnection) => (signal: AbortSignal) =>
  new NatsController(nats.url, nats.token).check(signal);

/** The role's own durable consumer exists on its stream (info only; never recreated). */
export const consumerCheck =
  (nats: NatsConnection, stream: string, consumer: string, name: string) =>
  async (signal: AbortSignal) => {
    const controller = new NatsController(nats.url, nats.token);
    const close = () => void controller.close().catch(() => undefined);
    signal.addEventListener("abort", close, { once: true });
    try {
      await controller.connect(name);
      await controller.consumerPosition(stream, consumer);
    } finally {
      signal.removeEventListener("abort", close);
      await controller.close().catch(() => undefined);
    }
  };

/** The logical search index answers a one-document read. */
export const searchCheck = (es: ElasticsearchConnection, index: string) => async () => {
  const controller = new ElasticsearchController(es.url, es.apiKey);
  try {
    await controller.search(index, { match_all: {} }, { size: 1 });
  } finally {
    await controller.close().catch(() => undefined);
  }
};
