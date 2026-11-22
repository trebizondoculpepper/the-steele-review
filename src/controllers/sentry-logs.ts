import { captureEvent, initWithoutDefaultIntegrations, logger } from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
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

/** Initialise once from the configured DSN; false when unset or invalid. */
function ensureEnabled(): boolean {
  if (enabled !== undefined) return enabled;
  try {
    {
      enabled = false;
      const dsn = readCredential("SENTRY_DSN");
      if (!dsn) return false;
      if (!hostedDsn.test(dsn) || dsn.trim() !== dsn) throw new Error("invalid DSN");
      enabled = Boolean(
        initWithoutDefaultIntegrations({
          dsn,
          enableOpenTelemetrySetup: false,
          spotlight: false,
          debug: false,
          tracesSampleRate: 0,
          sendClientReports: false,
          // Only the fixed application diagnostic is sent, rebuilt from its
          // allowlisted fields; every other event (including any exception
          // an integration might capture) is dropped.
          beforeSend: (event) => sanitizeApplicationError(event),
          beforeSendTransaction: () => null,
          beforeBreadcrumb: () => null,
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
  } catch {
    enabled = false;
    console.warn(JSON.stringify({ event: "sentry-logs", outcome: "disabled" }));
  }
  return enabled;
}

export function exportPipelineLog(attributes: Milestone, level: "info" | "warn" = "info"): void {
  try {
    if (ensureEnabled()) logger[level](message, attributes);
  } catch {
    enabled = false;
    console.warn(JSON.stringify({ event: "sentry-logs", outcome: "disabled" }));
  }
}

/**
 * Application error diagnostics for Sentry Issues (#723). Only a fixed
 * message, an allowlisted operation and a fixed category are ever sent:
 * never an exception, stack, URL, query, header, user data, configuration,
 * path or host.
 */
export const APPLICATION_ERROR_MESSAGE = "dashboard.view.failed";
export const APPLICATION_ERROR_CATEGORIES = ["render-failed"] as const;
export type ApplicationErrorCategory = (typeof APPLICATION_ERROR_CATEGORIES)[number];
/** A registered dashboard view path: lower-case segments only, no query. */
const VIEW = /^\/[a-z0-9-]{1,40}(\/[a-z0-9-]{1,40}){0,3}$/;

export interface ApplicationError {
  view: string;
  category: ApplicationErrorCategory;
}

/** The allowlisted diagnostic, or undefined when a field is not permitted. */
export function applicationError(view: string, category: string): ApplicationError | undefined {
  if (!VIEW.test(view)) return undefined;
  if (!(APPLICATION_ERROR_CATEGORIES as readonly string[]).includes(category)) return undefined;
  return { view, category: category as ApplicationErrorCategory };
}

/**
 * The before-send filter: rebuild a permitted diagnostic from its tags with
 * nothing else attached, or drop the event.
 */
export function sanitizeApplicationError(event: ErrorEvent): ErrorEvent | null {
  if (event.message !== APPLICATION_ERROR_MESSAGE) return null;
  const tags = event.tags ?? {};
  const safe = applicationError(String(tags.view ?? ""), String(tags.category ?? ""));
  if (!safe) return null;
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: "error",
    message: APPLICATION_ERROR_MESSAGE,
    tags: { view: safe.view, category: safe.category },
    fingerprint: [APPLICATION_ERROR_MESSAGE, safe.view, safe.category],
  } as ErrorEvent;
}

/** Report one caught application failure; a no-op when Sentry is not configured. */
export function reportApplicationError(view: string, category: ApplicationErrorCategory): void {
  const safe = applicationError(view, category);
  if (!safe) return;
  try {
    if (!ensureEnabled()) return;
    captureEvent({
      message: APPLICATION_ERROR_MESSAGE,
      level: "error",
      tags: { view: safe.view, category: safe.category },
    });
  } catch {
    // Telemetry never affects the response.
  }
}
