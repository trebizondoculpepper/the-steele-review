/**
 * Bounded read-only runtime status for the application's own services (#172).
 *
 *   status [--json]
 *
 * Configuration (environment, all optional): STEELE_STATE_PATH, NATS_URL and
 * NATS_TOKEN, ELASTICSEARCH_URL and ELASTICSEARCH_API_KEY (or their `_FILE`
 * forms). An absent dependency is reported as not-configured; a configured
 * dependency that cannot be reached is unavailable. Read-only: never creates
 * or migrates state, provisions streams or indices, consumes or publishes
 * messages, acquires claims or calls a model.
 *
 * Exit: 0 every configured check healthy; 1 any configured check unavailable
 * (mount, broker or search); 2 invalid invocation.
 *
 * Output is allowlisted: no credentials, connection URLs, hosts, filesystem
 * paths or raw exception text.
 */
import {
  CredentialError,
  elasticsearchConnection,
  natsConnection,
} from "../config/credentials.js";
import { ElasticsearchController } from "../controllers/elasticsearch.js";
import { NatsController } from "../controllers/nats.js";
import {
  collectRuntimeStatus,
  renderRuntimeStatus,
  runtimeStatusExitCode,
  stateProbeFor,
  type HealthProbe,
  type RuntimeStatusDependencies,
} from "../diagnostics/runtime-status.js";

const USAGE = "Usage: status [--json]";

/** A dependency whose configuration exists but cannot be read fails its check. */
const unusable: HealthProbe = {
  check: async () => {
    throw new Error("configuration unusable");
  },
};

function natsProbe(): HealthProbe | undefined {
  try {
    const connection = natsConnection();
    const controller = new NatsController(connection.url, connection.token);
    return { check: () => controller.check() };
  } catch (error) {
    return error instanceof CredentialError && error.problem === "missing" ? undefined : unusable;
  }
}

function elasticsearchProbe(): HealthProbe | undefined {
  try {
    const connection = elasticsearchConnection();
    const controller = new ElasticsearchController(connection.url, connection.apiKey);
    return {
      check: async () => {
        try {
          await controller.check();
        } finally {
          await controller.close();
        }
      },
    };
  } catch (error) {
    return error instanceof CredentialError && error.problem === "missing" ? undefined : unusable;
  }
}

function dependencies(): RuntimeStatusDependencies {
  const statePath = process.env.STEELE_STATE_PATH;
  const state = statePath ? stateProbeFor(statePath) : undefined;
  const nats = natsProbe();
  const elasticsearch = elasticsearchProbe();
  return {
    ...(state ? { state } : {}),
    ...(nats ? { nats } : {}),
    ...(elasticsearch ? { elasticsearch } : {}),
  };
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else {
      console.error(USAGE);
      return 2;
    }
  }
  const report = await collectRuntimeStatus(dependencies());
  console.log(json ? JSON.stringify(report) : renderRuntimeStatus(report));
  return runtimeStatusExitCode(report);
}

process.exitCode = await main(process.argv.slice(2));
