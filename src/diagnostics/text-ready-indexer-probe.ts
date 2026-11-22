import type { ElasticsearchConnection, NatsConnection } from "../config/credentials.js";
import { brokerCheck, consumerCheck, searchCheck } from "./probe-checks.js";
import { runRoleProbe, type RoleProbeReport } from "./role-probe.js";

/**
 * Legacy text-ready indexer readiness (#325), while this role remains
 * deployed: the broker answers, its own durable text-ready consumer exists,
 * and the logical full-text index answers a read. Read-only.
 */
export async function probeTextReadyIndexer(config: {
  nats?: NatsConnection;
  stream?: string;
  consumer?: string;
  elasticsearch?: ElasticsearchConnection;
  index?: string;
  timeoutMs?: number;
}): Promise<RoleProbeReport> {
  const { nats, elasticsearch: es } = config;
  return runRoleProbe(
    "text-ready-indexer",
    [
      { name: "broker", ...(nats ? { run: brokerCheck(nats) } : {}) },
      {
        name: "consumer",
        ...(nats && config.stream && config.consumer
          ? { run: consumerCheck(nats, config.stream, config.consumer, "steele-index-probe") }
          : {}),
      },
      { name: "search", ...(es && config.index ? { run: searchCheck(es, config.index) } : {}) },
    ],
    config.timeoutMs,
  );
}
