import { parseCapturedContentEvent } from "../events/captured-content-event.js";
import { articleRunKey, articleRunTarget, type ArticleRunInput } from "./article-run.js";

/**
 * Captured content to the writing engine (#270).
 *
 * Consumes one `steele.v1.content.captured` event (#269) and submits the
 * `ArticleRun` workflow for that exact item revision. The workflow key comes
 * from the source, item and source version, so a redelivered event, a
 * re-emitted event and a Substack replay from the CLI all attach to the same
 * run instead of starting another.
 *
 * Only `live` captures start runs automatically, and only for sources that
 * are switched on: a backfill or reprocess of an archive would otherwise
 * launch one paid run per post. Those go through the explicit replay CLI.
 *
 * The message is acknowledged only after Restate has durably accepted the
 * submission (or reports the run already exists). Any failure to reach
 * Restate is retried by redelivery.
 */

export const CAPTURE_BRIDGE_MAX_DELIVER = 10;

export type SubmitResult = "started" | "already-running";

export interface CapturedBridgeOptions {
  /** Source namespaces allowed to start runs, e.g. `substack/saveusnow`. */
  enabledSources: ReadonlySet<string>;
  /** Research batch deadline for submitted runs. */
  researchDeadlineMs: number;
  researchRequestLimit?: number;
  /** Submit (or attach to) the workflow with this key. Throws when Restate is unreachable. */
  submit(key: string, input: ArticleRunInput): Promise<SubmitResult>;
  retryDelayMs?: number;
}

export type BridgeDecision =
  | { action: "ack"; outcome: SubmitResult; key: string }
  | {
      action: "ack";
      outcome: "skipped";
      reason: "not-live" | "source-disabled" | "incomplete";
    }
  | { action: "nak"; delayMs: number; reason: "submission-failed"; key: string }
  | { action: "term"; reason: "invalid-event" };

/** The workflow input for one captured item revision. */
export function articleRunInputFor(
  event: ReturnType<typeof parseCapturedContentEvent>,
  researchDeadlineMs: number,
  researchRequestLimit?: number,
): ArticleRunInput {
  const target = articleRunTarget(event.source.namespace, event.itemId);
  return {
    ...target,
    sourceVersion: event.sourceVersion,
    sourceUrl: event.originalUrl,
    researchDeadlineMs,
    ...(researchRequestLimit === undefined ? {} : { researchRequestLimit }),
    source: {
      namespace: event.source.namespace,
      itemId: event.itemId,
      artifact: {
        repository: event.artifact.repository,
        commit: event.artifact.commit,
        path: event.artifact.path,
        sha256: event.artifact.hash.replace(/^sha256:/, ""),
      },
    },
  };
}

export async function handleCapturedContent(
  payload: string,
  options: CapturedBridgeOptions,
): Promise<BridgeDecision> {
  let event;
  try {
    event = parseCapturedContentEvent(payload);
  } catch {
    return { action: "term", reason: "invalid-event" };
  }
  if (event.ingestionReason !== "live")
    return { action: "ack", outcome: "skipped", reason: "not-live" };
  if (!options.enabledSources.has(event.source.namespace))
    return { action: "ack", outcome: "skipped", reason: "source-disabled" };
  if (!event.complete) return { action: "ack", outcome: "skipped", reason: "incomplete" };

  const input = articleRunInputFor(event, options.researchDeadlineMs, options.researchRequestLimit);
  const key = articleRunKey(input);
  try {
    const outcome = await options.submit(key, input);
    return { action: "ack", outcome, key };
  } catch {
    return {
      action: "nak",
      delayMs: options.retryDelayMs ?? 30_000,
      reason: "submission-failed",
      key,
    };
  }
}

/** Record exhausted submission retries before the broker can discard the handoff. */
export async function settleCapturedDelivery(
  message: Pick<
    import("../controllers/nats.js").DeliveredMessage,
    "deliveryCount" | "ack" | "nak" | "term"
  >,
  decision: BridgeDecision,
  state: Pick<import("../controllers/operation-store.js").OperationStore, "recordPermanentFailure">,
): Promise<void> {
  if (decision.action === "term") {
    message.term();
    return;
  }
  if (decision.action === "nak") {
    if (message.deliveryCount < CAPTURE_BRIDGE_MAX_DELIVER) {
      message.nak(decision.delayMs);
      return;
    }
    state.recordPermanentFailure(
      `capture-bridge:${decision.key}`,
      "retries-exhausted:submission-failed",
    );
  }
  await message.ack();
}
