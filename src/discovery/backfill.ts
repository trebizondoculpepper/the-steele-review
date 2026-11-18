import { parseArgs } from "node:util";
import { z } from "zod";
import type { SubstackItem } from "../content/substack-item.js";
import type { EnumerationSummary, HistoricalOptions } from "../controllers/substack/archive.js";
import { runDiscovery, type DiscoveryEventFactory, type DiscoveryPublisher } from "./run.js";

/**
 * One-shot bounded backfill: enumerate historical posts within explicit
 * bounds and publish one `backfill` discovery event per post through the
 * shared single-run function. Success means the enumeration ended normally
 * (archive exhausted or a bound reached) and every event was acknowledged.
 *
 * Rerunning an overlapping range is safe: content identity is stable, and
 * downstream collection deduplicates by content key. This command does not
 * itself deduplicate fetching, download content, or make anything eligible
 * for automatic publication.
 */

export const MAX_BACKFILL_ITEMS = 10_000;

const OptionsSchema = z
  .object({
    publicationUrl: z.url({ protocol: /^https$/ }),
    publicationId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
    maxItems: z.coerce.number().int().positive().max(MAX_BACKFILL_ITEMS),
    since: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((o) => !o.since || !o.until || Date.parse(o.since) <= Date.parse(o.until), {
    message: "since must not be after until",
  });

export interface BackfillOptions {
  publicationUrl: string;
  publicationId: string;
  maxItems: number;
  since?: Date;
  until?: Date;
}

export class BackfillUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackfillUsageError";
  }
}

export const BACKFILL_USAGE = `Usage: backfill --publication-url <https URL> --publication-id <id> --max-items <n> [--since <ISO date>] [--until <ISO date>]

Publishes one "backfill" discovery event per historical post, newest first.
--max-items is required (1-${MAX_BACKFILL_ITEMS}) so a run can never be unbounded.
Dates are inclusive ISO 8601 timestamps with an offset, e.g. 2025-01-01T00:00:00Z.
Exit status: 0 only if enumeration completed and every event was acknowledged.`;

/** Parse and validate command-line options. Error messages never echo values. */
export function parseBackfillArgs(argv: string[]): BackfillOptions {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        "publication-url": { type: "string" },
        "publication-id": { type: "string" },
        "max-items": { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
      },
    }));
  } catch {
    throw new BackfillUsageError("unknown or malformed option");
  }
  const parsed = OptionsSchema.safeParse({
    publicationUrl: values["publication-url"],
    publicationId: values["publication-id"],
    maxItems: values["max-items"],
    since: values.since,
    until: values.until,
  });
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "options"))];
    throw new BackfillUsageError(`invalid or missing: ${fields.join(", ")}`);
  }
  const o = parsed.data;
  return {
    publicationUrl: o.publicationUrl,
    publicationId: o.publicationId,
    maxItems: o.maxItems,
    ...(o.since ? { since: new Date(o.since) } : {}),
    ...(o.until ? { until: new Date(o.until) } : {}),
  };
}

/** Historical source, as provided by SubstackArchiveDiscovery. */
export interface HistoricalSource {
  getHistoricalItems(options: HistoricalOptions): AsyncIterable<SubstackItem>;
}

export interface BackfillReport {
  ok: boolean;
  /** Why enumeration ended normally, if it did. */
  enumeration?: EnumerationSummary["reason"];
  discovered: number;
  published: number;
  runStatus: "complete" | "failed" | "cancelled";
  failureStage?: "source" | "event" | "publish";
  failureError?: string;
  correlationId: string;
}

export async function runBackfill(input: {
  options: BackfillOptions;
  source: HistoricalSource;
  createEvent: DiscoveryEventFactory;
  publisher: DiscoveryPublisher;
  signal?: AbortSignal;
}): Promise<BackfillReport> {
  let enumeration: EnumerationSummary | undefined;
  const items = input.source.getHistoricalItems({
    maxItems: input.options.maxItems,
    since: input.options.since,
    until: input.options.until,
    signal: input.signal,
    onComplete: (summary) => {
      enumeration = summary;
    },
  });
  const summary = await runDiscovery({
    source: items,
    reason: "backfill",
    createEvent: input.createEvent,
    publisher: input.publisher,
    signal: input.signal,
  });
  return {
    ok: summary.status === "complete" && enumeration !== undefined,
    enumeration: enumeration?.reason,
    discovered: summary.discovered,
    published: summary.published,
    runStatus: summary.status,
    ...(summary.failure
      ? { failureStage: summary.failure.stage, failureError: summary.failure.errorName }
      : {}),
    correlationId: summary.correlationId,
  };
}
