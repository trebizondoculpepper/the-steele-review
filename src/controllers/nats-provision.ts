import { AckPolicy } from "@nats-io/jetstream";
import type { NatsController } from "./nats.js";

/**
 * Explicit, opt-in provisioning of the application's own JetStream stream.
 * Separate from publishing: run it from an operator command or test setup,
 * never implicitly. It creates the stream if absent and refuses to modify an
 * existing stream whose subjects differ, so unrelated streams are never
 * changed or reused.
 */

export interface DiscoveryStreamConfig {
  /** Dedicated stream name, e.g. STEELE_DISCOVERY. */
  name: string;
  /** Subjects this stream captures, e.g. ["steele.v1.source.detected"]. */
  subjects: string[];
  /** JetStream duplicate window for message-ID deduplication, in ms. */
  duplicateWindowMs?: number;
}

export type ProvisionResult = "created" | "unchanged";

export class StreamConflictError extends Error {
  constructor() {
    super("existing stream has different subjects; refusing to modify it");
    this.name = "StreamConflictError";
  }
}

const STREAM_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export async function provisionDiscoveryStream(
  nats: Pick<NatsController, "manager">,
  config: DiscoveryStreamConfig,
): Promise<ProvisionResult> {
  if (!STREAM_NAME.test(config.name)) throw new Error("invalid stream name");
  if (config.subjects.length === 0) throw new Error("stream needs at least one subject");
  const jsm = await nats.manager();
  let existing;
  try {
    existing = await jsm.streams.info(config.name);
  } catch (error) {
    if (!(error instanceof Error) || !/not found/i.test(error.message)) throw error;
  }
  if (existing) {
    const current = [...(existing.config.subjects ?? [])].sort();
    const wanted = [...config.subjects].sort();
    if (current.join("\n") !== wanted.join("\n")) throw new StreamConflictError();
    return "unchanged";
  }
  await jsm.streams.add({
    name: config.name,
    subjects: config.subjects,
    duplicate_window: (config.duplicateWindowMs ?? 2 * 60 * 1000) * 1_000_000,
  });
  return "created";
}

export interface DurableConsumerConfig {
  stream: string;
  /** Durable consumer name, e.g. steele-collector. */
  name: string;
  filterSubject: string;
  /** How long a delivered message may stay unacknowledged before redelivery. */
  ackWaitMs?: number;
  /** Bound on deliveries per message. */
  maxDeliver?: number;
}

export class ConsumerConflictError extends Error {
  constructor() {
    super("existing consumer has a different filter; refusing to modify it");
    this.name = "ConsumerConflictError";
  }
}

/**
 * Explicitly create a durable pull consumer with explicit acknowledgment if
 * it does not exist. An existing consumer is never modified.
 */
export async function provisionDurableConsumer(
  nats: Pick<NatsController, "manager">,
  config: DurableConsumerConfig,
): Promise<ProvisionResult> {
  if (!STREAM_NAME.test(config.stream) || !STREAM_NAME.test(config.name)) {
    throw new Error("invalid stream or consumer name");
  }
  const jsm = await nats.manager();
  let existing;
  try {
    existing = await jsm.consumers.info(config.stream, config.name);
  } catch (error) {
    if (!(error instanceof Error) || !/not found/i.test(error.message)) throw error;
  }
  if (existing) {
    if (existing.config.filter_subject !== config.filterSubject) throw new ConsumerConflictError();
    return "unchanged";
  }
  await jsm.consumers.add(config.stream, {
    durable_name: config.name,
    filter_subject: config.filterSubject,
    ack_policy: AckPolicy.Explicit,
    ack_wait: (config.ackWaitMs ?? 5 * 60 * 1000) * 1_000_000,
    max_deliver: config.maxDeliver ?? 10,
  });
  return "created";
}
