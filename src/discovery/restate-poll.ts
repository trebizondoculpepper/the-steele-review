import { createHash } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import type { SubstackItem } from "../content/substack-item.js";
import { createDiscoveryEvent } from "../events/discovery-event.js";
import type { DiscoveryPublisher } from "./run.js";

const STEP = { maxRetryAttempts: 3 } as const;

/**
 * Article discovery polls as durable Restate jobs (#823).
 *
 * One keyed virtual object per configured source. Its handlers are exclusive
 * per key, so polls of the same source never overlap: a second call waits for
 * the first and, when it arrives soon after a completed poll, is coalesced
 * into that result instead of polling again. Scheduled and on-demand calls
 * use the same `poll` entry point; every poll and its outcome is an
 * invocation visible in Restate.
 *
 * The schedule is a chain of delayed self-calls. `start` begins a new chain
 * under a fresh generation; a scheduled call from an older generation ends
 * without polling. Calling `start` on every process start therefore always
 * leaves exactly one effective schedule per source.
 *
 * Deduplication: the object remembers the content keys it has already
 * published (bounded), so one newly discovered article produces one event.
 * Each event's ID is derived from the source and the post, so a publish that
 * Restate retries is deduplicated by JetStream's message ID as well.
 */

export const DISCOVERY_POLL = "DiscoveryPoll";

/** A poll within this long after a completed one is coalesced into it. */
export const COALESCE_MS = 30_000;
/** Content keys remembered per source; the feed returns far fewer. */
export const SEEN_LIMIT = 2_000;
/** Feed items considered per poll. */
export const MAX_ITEMS = 500;

export interface PollRequest {
  reason: "scheduled" | "manual";
  /** Scheduled calls only: the schedule chain this call belongs to. */
  generation?: string;
}

export interface PollOutcome {
  status: "complete" | "failed" | "coalesced" | "superseded";
  /** Items the feed returned. */
  discovered: number;
  /** Events published by this poll: new items only. */
  published: number;
  /** Present when status is "failed": the stage and the error class name only. */
  failure?: { stage: "source" | "publish"; errorName: string };
  /** Delay before the next scheduled poll, when this poll scheduled one. */
  nextDelayMs?: number;
}

/** Sanitised status for the dashboard: counts, states and outcome names only. */
export interface PollStatus {
  state: "waiting" | "stopped";
  runs: number;
  consecutiveFailures: number;
  lastOutcome: PollOutcome["status"];
  lastPublished: number;
  lastPollAt: string;
  nextDelayMs?: number;
}

export interface DiscoveryPollDeps {
  /** Normalised items from the source, newest first; must honour the signal. */
  fetchItems: (key: string) => AsyncIterable<SubstackItem>;
  publisher: DiscoveryPublisher;
  /** Delay after a successful scheduled poll. */
  intervalMs: number;
  /** Upper bound on the delay after repeated failures. */
  maxBackoffMs: number;
  /** Sources this endpoint serves; any other key is refused. */
  sources: string[];
  /** Best effort: a status that cannot be written must not fail the poll. */
  writeStatus?: (key: string, status: PollStatus) => Promise<void>;
}

/** The content key of one post: what "already discovered" means. */
export const contentKey = (item: Pick<SubstackItem, "publicationId" | "postId">) =>
  `${item.publicationId}/${item.postId}`;

/** A stable event ID for one post from one source. */
export const discoveryEventId = (source: string, item: SubstackItem) =>
  createHash("sha256")
    .update(JSON.stringify([source, contentKey(item)]))
    .digest("hex");

/** Delay before the next run: the interval, doubled per consecutive failure, bounded. */
export function nextDelay(
  deps: Pick<DiscoveryPollDeps, "intervalMs" | "maxBackoffMs">,
  failures: number,
): number {
  if (failures === 0) return deps.intervalMs;
  return Math.min(deps.maxBackoffMs, deps.intervalMs * 2 ** Math.min(failures, 30));
}

/**
 * Run a step with bounded retries, keeping the last error's class name: a
 * step that gives up surfaces as a TerminalError without its original class.
 */
async function step<T>(
  ctx: restate.ObjectContext,
  name: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; errorName: string }> {
  let lastError = "RetriesExhausted";
  try {
    const value = await ctx.run(
      name,
      async () => {
        try {
          return await fn();
        } catch (error) {
          lastError = error instanceof Error ? error.name : "UnknownError";
          throw error;
        }
      },
      STEP,
    );
    return { ok: true, value };
  } catch (error) {
    if (!(error instanceof restate.TerminalError)) throw error;
    return { ok: false, errorName: lastError };
  }
}

export function discoveryPollObject(deps: DiscoveryPollDeps) {
  const served = new Set(deps.sources);
  const self = (ctx: restate.ObjectContext) =>
    ctx.objectSendClient<typeof object>({ name: DISCOVERY_POLL }, ctx.key);

  const object = restate.object({
    name: DISCOVERY_POLL,
    handlers: {
      /** Begin a new schedule chain; any older chain stops at its next call. */
      start: async (ctx: restate.ObjectContext): Promise<{ generation: string }> => {
        if (!served.has(ctx.key)) throw new restate.TerminalError("discovery: unknown source");
        const generation = ctx.rand.uuidv4();
        ctx.set("generation", generation);
        self(ctx).poll({ reason: "scheduled", generation });
        return { generation };
      },

      poll: async (ctx: restate.ObjectContext, request: PollRequest): Promise<PollOutcome> => {
        if (!served.has(ctx.key)) throw new restate.TerminalError("discovery: unknown source");
        const scheduled = request.reason === "scheduled";
        if (scheduled && request.generation !== (await ctx.get<string>("generation"))) {
          return { status: "superseded", discovered: 0, published: 0 };
        }
        const now = await ctx.date.now();
        const lastAt = await ctx.get<number>("lastCompletedAt");
        if (!scheduled && lastAt !== null && now - lastAt < COALESCE_MS) {
          const last = await ctx.get<PollOutcome>("lastOutcome");
          return { ...(last ?? { discovered: 0, published: 0 }), status: "coalesced" };
        }

        const outcome = await pollOnce(ctx);
        const runs = ((await ctx.get<number>("runs")) ?? 0) + 1;
        const failures =
          outcome.status === "failed" ? ((await ctx.get<number>("failures")) ?? 0) + 1 : 0;
        ctx.set("runs", runs);
        ctx.set("failures", failures);
        ctx.set("lastCompletedAt", now);
        ctx.set("lastOutcome", outcome);

        if (scheduled) {
          outcome.nextDelayMs = nextDelay(deps, failures);
          self(ctx).poll(
            { reason: "scheduled", generation: request.generation },
            restate.rpc.sendOpts({ delay: outcome.nextDelayMs }),
          );
        }
        if (deps.writeStatus) {
          const status: PollStatus = {
            state: "waiting",
            runs,
            consecutiveFailures: failures,
            lastOutcome: outcome.status,
            lastPublished: outcome.published,
            lastPollAt: new Date(now).toISOString(),
            ...(outcome.nextDelayMs !== undefined ? { nextDelayMs: outcome.nextDelayMs } : {}),
          };
          const write = deps.writeStatus;
          await ctx.run("status", () => write(ctx.key, status).catch(() => undefined));
        }
        return outcome;
      },
    },
  });

  /** Fetch once, then publish each new item as its own durable step. */
  async function pollOnce(ctx: restate.ObjectContext): Promise<PollOutcome> {
    const fetched = await step(ctx, "fetch", async () => {
      const out: SubstackItem[] = [];
      for await (const item of deps.fetchItems(ctx.key)) {
        out.push(item);
        if (out.length >= MAX_ITEMS) break;
      }
      return out;
    });
    if (!fetched.ok) {
      return {
        status: "failed",
        discovered: 0,
        published: 0,
        failure: { stage: "source", errorName: fetched.errorName },
      };
    }
    const items = fetched.value;
    const seen = (await ctx.get<string[]>("seen")) ?? [];
    const known = new Set(seen);
    const correlationId = ctx.rand.uuidv4();
    let published = 0;
    for (const item of items) {
      const key = contentKey(item);
      if (known.has(key)) continue;
      const sent = await step(ctx, `publish:${key}`, async () => {
        const event = createDiscoveryEvent(
          item,
          { reason: "live", correlationId },
          { newId: () => discoveryEventId(ctx.key, item), now: () => new Date() },
        );
        await deps.publisher.publish(event);
      });
      if (!sent.ok) {
        // Unpublished items stay unseen, so the next poll tries them again.
        ctx.set("seen", seen.slice(-SEEN_LIMIT));
        return {
          status: "failed",
          discovered: items.length,
          published,
          failure: { stage: "publish", errorName: sent.errorName },
        };
      }
      seen.push(key);
      known.add(key);
      published++;
    }
    ctx.set("seen", seen.slice(-SEEN_LIMIT));
    return { status: "complete", discovered: items.length, published };
  }

  return object;
}

export type DiscoveryPollObject = ReturnType<typeof discoveryPollObject>;
