import { createHash } from "node:crypto";
import {
  parseDiscoveryEvent,
  serializeDiscoveryEvent,
  type DiscoveryEvent,
} from "../events/discovery-event.js";
import { assertPublishSubject, type NatsController, type PublishReceipt } from "./nats.js";

/**
 * Discovery-event publisher over the NATS controller. Validates the
 * CloudEvents envelope and Zod payload by round-tripping the exact wire bytes
 * before sending, then awaits JetStream acknowledgment. The JetStream message
 * ID is derived from the event's (source, id), so every retry of the same
 * event is deduplicated by the stream's duplicate window.
 *
 * Broker deduplication covers redelivery of one event only. Distinct
 * discovery events for the same post are deduplicated downstream by content
 * key, not here.
 */

export const DEFAULT_DISCOVERY_SUBJECT = "steele.v1.source.detected";

export interface NatsDiscoveryPublisherConfig {
  /** Application-specific literal subject; defaults to steele.v1.source.detected. */
  subject?: string;
  /** Require the subject to be captured by this stream. */
  expectStream?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

const encoder = new TextEncoder();

/**
 * Collision-free JetStream message ID for an event's (source, id) identity:
 * SHA-256 of the JSON-encoded pair, so no delimiter can make two distinct
 * identities share a key.
 */
export function discoveryMessageId(event: Pick<DiscoveryEvent, "source" | "id">): string {
  return createHash("sha256")
    .update(JSON.stringify([event.source, event.id]))
    .digest("hex");
}

/** Satisfies the DiscoveryPublisher interface of the single discovery run (#9). */
export class NatsDiscoveryPublisher {
  private readonly subject: string;
  /** Receipt of the most recent acknowledged publication, for diagnostics. */
  lastReceipt?: PublishReceipt;

  constructor(
    private readonly nats: Pick<NatsController, "publish">,
    private readonly config: NatsDiscoveryPublisherConfig = {},
  ) {
    this.subject = assertPublishSubject(config.subject ?? DEFAULT_DISCOVERY_SUBJECT);
  }

  async publish(event: DiscoveryEvent, signal?: AbortSignal): Promise<void> {
    const wire = serializeDiscoveryEvent(event);
    parseDiscoveryEvent(wire); // throws InvalidDiscoveryEventError before anything is sent
    this.lastReceipt = await this.nats.publish(this.subject, encoder.encode(wire), {
      msgId: discoveryMessageId(event),
      expectStream: this.config.expectStream,
      timeoutMs: this.config.timeoutMs,
      maxAttempts: this.config.maxAttempts,
      retryDelayMs: this.config.retryDelayMs,
      signal,
    });
  }
}
