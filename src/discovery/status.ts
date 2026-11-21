import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";

/**
 * Sanitised discovery-runner status on disk (#376).
 *
 * The live discovery runner is a separate process from the dashboard, so its
 * last poll must be observable somewhere both can read. It writes one small
 * JSON file atomically after each run; the dashboard reads it. Counts, states
 * and outcome names only: no feed URLs, hosts or credentials.
 */

export const DISCOVERY_STATUS_SCHEMA_VERSION = 1;

export const DiscoveryStatusSchema = z
  .object({
    schemaVersion: z.literal(DISCOVERY_STATUS_SCHEMA_VERSION),
    /** When this status was written (after the latest run completed). */
    at: z.iso.datetime({ offset: true }),
    state: z.enum(["idle", "running", "waiting", "stopping", "stopped"]),
    runs: z.number().int().min(0),
    consecutiveFailures: z.number().int().min(0),
    lastOutcome: z.string().min(1).max(100).optional(),
    lastPublished: z.number().int().min(0).optional(),
    nextDelayMs: z.number().int().min(0).optional(),
  })
  .strict();
export type DiscoveryStatus = z.infer<typeof DiscoveryStatusSchema>;

export type DiscoveryStatusInput = Omit<DiscoveryStatus, "schemaVersion" | "at"> & {
  at?: string;
};

/**
 * One write chain per path. The runner emits two updates in the same tick
 * (outcome, then waiting), so concurrent writes must not share a temp file or
 * publish an older state after a newer one.
 */
const writes = new Map<string, Promise<void>>();
let counter = 0;

/** Write the status atomically so a reader never sees a partial file. */
export function writeDiscoveryStatus(
  path: string,
  status: DiscoveryStatusInput,
): Promise<void> {
  const previous = writes.get(path) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => writeAtomic(path, status));
  writes.set(path, next);
  return next.finally(() => {
    if (writes.get(path) === next) writes.delete(path);
  });
}

async function writeAtomic(path: string, status: DiscoveryStatusInput): Promise<void> {
  const record: DiscoveryStatus = {
    schemaVersion: DISCOVERY_STATUS_SCHEMA_VERSION,
    at: status.at ?? new Date().toISOString(),
    state: status.state,
    runs: status.runs,
    consecutiveFailures: status.consecutiveFailures,
    ...(status.lastOutcome === undefined ? {} : { lastOutcome: status.lastOutcome }),
    ...(status.lastPublished === undefined ? {} : { lastPublished: status.lastPublished }),
    ...(status.nextDelayMs === undefined ? {} : { nextDelayMs: status.nextDelayMs }),
  };
  const temporary = `${path}.${process.pid}.${++counter}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  await rename(temporary, path);
}

/**
 * Read the status, or undefined when the file is absent or unreadable. A
 * malformed file is treated as absent: the dashboard reports it as
 * unavailable rather than trusting fields.
 */
export async function readDiscoveryStatus(path: string): Promise<DiscoveryStatus | undefined> {
  try {
    const parsed = DiscoveryStatusSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
