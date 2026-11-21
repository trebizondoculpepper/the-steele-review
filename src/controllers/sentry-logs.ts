import { initWithoutDefaultIntegrations, logger } from "@sentry/node";
import { readCredential } from "../config/credentials.js";

const message = "article.pipeline";
// The SDK may print malformed DSNs. Validate the hosted HTTPS format first.
const hostedDsn = /^https:\/\/[a-z0-9]+@[a-z0-9.-]+\/[0-9]+$/i;
type Milestone = {
  correlation_id: string;
  stage: string;
  outcome: string;
  revision?: string;
  destination_id?: string;
};

let enabled: boolean | undefined;

export function exportPipelineLog(attributes: Milestone, level: "info" | "warn" = "info"): void {
  try {
    if (enabled === undefined) {
      enabled = false;
      const dsn = readCredential("SENTRY_DSN");
      if (!dsn) return;
      if (!hostedDsn.test(dsn) || dsn.trim() !== dsn) throw new Error("invalid DSN");
      enabled = Boolean(
        initWithoutDefaultIntegrations({
          dsn,
          enableOpenTelemetrySetup: false,
          spotlight: false,
          debug: false,
          tracesSampleRate: 0,
          sendClientReports: false,
          beforeSend: () => null,
          beforeSendLog: (log) => {
            if (log.message !== message) return null;
            const { correlation_id, stage, outcome, revision, destination_id } =
              log.attributes ?? {};
            log.attributes = {
              correlation_id,
              stage,
              outcome,
              ...(revision ? { revision } : {}),
              ...(destination_id ? { destination_id } : {}),
            };
            return log;
          },
        }),
      );
      if (!enabled) console.warn(JSON.stringify({ event: "sentry-logs", outcome: "disabled" }));
    }
    if (enabled) logger[level](message, attributes);
  } catch {
    enabled = false;
    console.warn(JSON.stringify({ event: "sentry-logs", outcome: "disabled" }));
  }
}
