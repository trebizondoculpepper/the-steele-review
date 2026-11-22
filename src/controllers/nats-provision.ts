import { AckPolicy, DeliverPolicy } from "@nats-io/jetstream";
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

export type ProvisionResult = "created" | "unchanged" | "updated";

export interface ProvisionOptions {
  /**
   * Allow adding subjects to an existing stream. Only strictly additive
   * changes are applied; removing or replacing a subject still conflicts.
   */
  allowAdditiveSubjects?: boolean;
}

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
  options: ProvisionOptions = {},
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
    if (current.join("\n") === wanted.join("\n")) return "unchanged";
    // A registry-defined stream may grow: an upgrade adds the new subject and
    // keeps every existing one and its retained messages. Anything else is a
    // conflict, so unrelated or repurposed streams are never modified.
    const addsOnly = current.every((subject) => wanted.includes(subject));
    if (!options.allowAdditiveSubjects || !addsOnly) throw new StreamConflictError();
    await jsm.streams.update(config.name, { subjects: [...config.subjects] });
    return "updated";
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
  /** Start at messages published after provisioning. */
  newOnly?: boolean;
  /** Explicit selected-message start; incompatible with newOnly. */
  startSequence?: number;
  /** How long a delivered message may stay unacknowledged before redelivery. */
  ackWaitMs?: number;
  /** Bound on deliveries per message. */
  maxDeliver?: number;
}

export class ConsumerConflictError extends Error {
  constructor() {
    super("existing consumer has a different filter or delivery policy; refusing to modify it");
    this.name = "ConsumerConflictError";
  }
}

/**
 * Explicitly create a durable pull consumer with explicit acknowledgment if
 * it does not exist. An existing consumer is only ever changed to apply an
 * explicitly requested delivery budget.
 */
export async function provisionDurableConsumer(
  nats: Pick<NatsController, "manager">,
  config: DurableConsumerConfig,
): Promise<ProvisionResult> {
  if (!STREAM_NAME.test(config.stream) || !STREAM_NAME.test(config.name)) {
    throw new Error("invalid stream or consumer name");
  }
  if (
    config.startSequence !== undefined &&
    (config.newOnly || !Number.isSafeInteger(config.startSequence) || config.startSequence < 1)
  )
    throw new Error("invalid consumer start sequence");
  const jsm = await nats.manager();
  let existing;
  try {
    existing = await jsm.consumers.info(config.stream, config.name);
  } catch (error) {
    if (!(error instanceof Error) || !/not found/i.test(error.message)) throw error;
  }
  if (existing) {
    // The worker acknowledges each message only after durable state; any other
    // ack policy would let unprocessed messages be treated as handled.
    if (
      existing.config.filter_subject !== config.filterSubject ||
      existing.config.ack_policy !== AckPolicy.Explicit ||
      (config.startSequence !== undefined &&
        (existing.config.deliver_policy !== DeliverPolicy.StartSequence ||
          existing.config.opt_start_seq !== config.startSequence ||
          existing.config.deliver_subject)) ||
      (config.newOnly &&
        (existing.config.deliver_policy !== DeliverPolicy.New ||
          existing.config.deliver_subject ||
          existing.config.max_deliver !== (config.maxDeliver ?? 10)))
    ) {
      throw new ConsumerConflictError();
    }
    // An explicitly requested delivery budget is enforced on an existing
    // consumer too; max_deliver is an updatable setting, and nothing else
    // (start position, filter, ack policy) changes.
    if (config.maxDeliver !== undefined && existing.config.max_deliver !== config.maxDeliver) {
      await jsm.consumers.update(config.stream, config.name, { max_deliver: config.maxDeliver });
      return "updated";
    }
    return "unchanged";
  }
  await jsm.consumers.add(config.stream, {
    durable_name: config.name,
    filter_subject: config.filterSubject,
    ack_policy: AckPolicy.Explicit,
    ...(config.newOnly ? { deliver_policy: DeliverPolicy.New } : {}),
    ...(config.startSequence === undefined
      ? {}
      : {
          deliver_policy: DeliverPolicy.StartSequence,
          opt_start_seq: config.startSequence,
        }),
    ack_wait: (config.ackWaitMs ?? 5 * 60 * 1000) * 1_000_000,
    max_deliver: config.maxDeliver ?? 10,
  });
  return "created";
}
