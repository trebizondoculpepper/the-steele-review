import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  jetstream,
  jetstreamManager,
  type JetStreamManager,
  type JetStreamPublishOptions,
  type PubAck,
} from "@nats-io/jetstream";

/**
 * NATS controller: the only place that talks to the NATS/JetStream clients.
 * Provides the read-only connectivity probe, an explicit connection
 * lifecycle, and acknowledged JetStream publishing with bounded retries that
 * keep the same message ID. Stream provisioning lives elsewhere and is never
 * performed implicitly by publishing.
 *
 * Errors are sanitised: no server addresses, credentials or raw client
 * exceptions are exposed or logged.
 */

export type NatsPublishErrorCode =
  | "not-connected"
  | "timeout"
  | "no-stream"
  | "rejected"
  | "cancelled"
  | "failed";

export class NatsPublishError extends Error {
  constructor(
    readonly code: NatsPublishErrorCode,
    readonly retryable: boolean,
  ) {
    super(`NATS publish ${code}`);
    this.name = "NatsPublishError";
  }
}

/** One delivered JetStream message, with acknowledgment controls. */
export interface DeliveredMessage {
  data: Uint8Array;
  /** Broker-owned position, supplied by the controller for selected delivery. */
  streamSequence?: number;
  /** 1 on first delivery, incremented on each redelivery. */
  deliveryCount: number;
  /** Acknowledge and wait for the server to confirm. */
  ack(): Promise<void>;
  /** Ask for redelivery after a delay. */
  nak(delayMs?: number): void;
  /** Stop redelivering this message. */
  term(): void;
  /** Extend the acknowledgment deadline while work continues. */
  working(): void;
}

/** A missing confirmation is uncertainty even if the server may have ACKed. */
export async function confirmNatsAck(message: { ackAck(): Promise<boolean> }): Promise<void> {
  try {
    if ((await message.ackAck()) === true) return;
  } catch {
    /* Never expose transport diagnostics. */
  }
  throw new NatsPublishError("timeout", true);
}

export interface PublishReceipt {
  stream: string;
  seq: number;
  /** True when JetStream recognised the message ID as already stored. */
  duplicate: boolean;
  attempts: number;
}

export interface PublishOptions {
  /** Deduplication ID; reuse it for every retry of the same logical message. */
  msgId: string;
  /** Reject unless the subject is captured by this stream. */
  expectStream?: string;
  /** Wait for each acknowledgment, in milliseconds. */
  timeoutMs?: number;
  /** Total attempts including the first. */
  maxAttempts?: number;
  /** Base backoff; doubles per retry. */
  retryDelayMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

/** Minimal JetStream publish surface, injectable for tests. */
export interface JetStreamPublisherLike {
  publish(
    subject: string,
    payload: Uint8Array,
    options: Partial<JetStreamPublishOptions>,
  ): Promise<PubAck>;
}

const SUBJECT_TOKEN = /^[A-Za-z0-9_-]+$/;

/** Validate a literal publish subject: dot-separated tokens, no wildcards. */
export function assertPublishSubject(subject: string): string {
  if (subject.length > 255 || !subject.split(".").every((token) => SUBJECT_TOKEN.test(token))) {
    throw new Error("invalid NATS publish subject");
  }
  return subject;
}

/** Map a client error to a sanitised error; never forwards its message. */
export function classifyPublishError(error: unknown): NatsPublishError {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (name === "TimeoutError" || message.includes("timeout")) {
    return new NatsPublishError("timeout", true);
  }
  if (name === "NoRespondersError" || message.includes("no responders")) {
    return new NatsPublishError("no-stream", true);
  }
  if (name === "JetStreamApiError" || message.includes("expected stream")) {
    return new NatsPublishError("rejected", false);
  }
  if (name === "ClosedConnectionError" || message.includes("closed")) {
    return new NatsPublishError("not-connected", true);
  }
  return new NatsPublishError("failed", true);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Publish with bounded retries, reusing the same msgID so JetStream
 * deduplicates a retry whose earlier attempt was stored but not acknowledged.
 */
export async function publishWithRetry(
  js: JetStreamPublisherLike,
  subject: string,
  payload: Uint8Array,
  options: PublishOptions,
): Promise<PublishReceipt> {
  const attempts = Math.max(1, options.maxAttempts ?? 3);
  const sleep = options.sleep ?? defaultSleep;
  const publishOptions: Partial<JetStreamPublishOptions> = {
    msgID: options.msgId,
    timeout: options.timeoutMs ?? 5_000,
    ...(options.expectStream ? { expect: { streamName: options.expectStream } } : {}),
  };
  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) throw new NatsPublishError("cancelled", false);
    try {
      const ack = await js.publish(subject, payload, publishOptions);
      return { stream: ack.stream, seq: ack.seq, duplicate: ack.duplicate, attempts: attempt };
    } catch (error) {
      const failure = classifyPublishError(error);
      if (!failure.retryable || attempt >= attempts) throw failure;
      if (options.signal?.aborted) throw new NatsPublishError("cancelled", false);
      await sleep((options.retryDelayMs ?? 500) * 2 ** (attempt - 1));
    }
  }
}

export class NatsController {
  private connection?: NatsConnection;
  private connecting?: Promise<void>;
  private connectionName?: string;
  private closedDeliberately = false;

  constructor(
    private readonly servers: string,
    private readonly token?: string,
  ) {}

  /**
   * Read-only connectivity probe; opens and closes its own connection.
   * Aborting closes the socket, so a broker that accepts a connection and then
   * stops answering cannot keep a diagnostic invocation alive past its budget.
   */
  async check(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new NatsPublishError("cancelled", false);
    const connection = await connect({
      servers: this.servers,
      token: this.token,
      timeout: 5000,
      reconnect: false,
      name: "steele-connectivity",
    });
    const close = () => connection.close().catch(() => undefined);
    signal?.addEventListener("abort", close, { once: true });
    try {
      await connection.flush();
    } finally {
      signal?.removeEventListener("abort", close);
      await close();
    }
  }

  /** Open the long-lived connection used for publishing. Idempotent and safe to call concurrently. */
  async connect(name = "steele-discovery"): Promise<void> {
    this.connectionName = name;
    this.closedDeliberately = false;
    if (this.connection && !this.connection.isClosed()) return;
    this.connecting ??= connect({
      servers: this.servers,
      token: this.token,
      timeout: 5000,
      name,
      // Keep trying through long broker outages instead of giving up after
      // the client's default reconnect budget.
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2_000,
    })
      .then((connection) => {
        this.connection = connection;
      })
      .catch(() => {
        throw new NatsPublishError("not-connected", true);
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  /** Drain in-flight work and close. Safe to call more than once. */
  async close(): Promise<void> {
    this.closedDeliberately = true;
    await this.connecting?.catch(() => undefined);
    const connection = this.connection;
    this.connection = undefined;
    if (!connection || connection.isClosed()) return;
    try {
      await connection.drain();
    } catch {
      await connection.close().catch(() => undefined);
    }
  }

  /**
   * Re-establish a long-lived connection that closed unexpectedly (for
   * example after an outage outlasted reconnection). A deliberate close() is
   * respected.
   */
  private async ensureConnected(): Promise<void> {
    if (this.connection && !this.connection.isClosed()) return;
    if (this.closedDeliberately || this.connectionName === undefined) return;
    await this.connect(this.connectionName);
  }

  private requireConnection(): NatsConnection {
    if (!this.connection || this.connection.isClosed()) {
      throw new NatsPublishError("not-connected", false);
    }
    return this.connection;
  }

  /** Publish bytes to JetStream and await durable acknowledgment. */
  async publish(
    subject: string,
    payload: Uint8Array,
    options: PublishOptions,
  ): Promise<PublishReceipt> {
    await this.ensureConnected();
    const js = jetstream(this.requireConnection());
    return publishWithRetry(js, assertPublishSubject(subject), payload, options);
  }

  /**
   * Consume a provisioned durable consumer one message at a time until the
   * signal aborts. The handler owns acknowledgment; a handler error naks the
   * message for redelivery. Never creates the stream or consumer.
   */
  async consume(
    stream: string,
    durable: string,
    handler: (message: DeliveredMessage) => Promise<void>,
    signal: AbortSignal,
    options?: { once: boolean },
  ): Promise<void> {
    if (signal.aborted) return;
    const js = jetstream(this.requireConnection());
    let consumer;
    try {
      consumer = await js.consumers.get(stream, durable);
    } catch {
      throw new NatsPublishError("no-stream", false);
    }
    if (signal.aborted) return;
    const messages = options?.once
      ? await consumer.fetch({ max_messages: 1, expires: 1000 })
      : await consumer.consume({ max_messages: 1 });
    // The signal may have aborted while the subscription was being set up.
    if (signal.aborted) {
      await messages.close().catch(() => undefined);
      return;
    }
    const stop = () => void messages.stop();
    signal.addEventListener("abort", stop, { once: true });
    try {
      for await (const m of messages) {
        const delivered: DeliveredMessage = {
          data: m.data,
          streamSequence: m.info.streamSequence,
          deliveryCount: m.info.deliveryCount,
          ack: () => confirmNatsAck(m),
          nak: (delayMs) => m.nak(delayMs),
          term: () => m.term(),
          working: () => m.working(),
        };
        try {
          await handler(delivered);
        } catch {
          m.nak(1_000);
        }
        if (signal.aborted) break;
      }
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
    }
  }

  /** JetStream manager for explicit provisioning tools; never used by publish(). */
  async manager(): Promise<JetStreamManager> {
    return jetstreamManager(this.requireConnection());
  }

  /** Read one retained message without delivery or acknowledgement. */
  async readMessage(
    stream: string,
    sequence: number,
  ): Promise<{
    sequence: number;
    subject: string;
    data: Uint8Array;
    messageId?: string;
  }> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(stream) || !Number.isSafeInteger(sequence) || sequence < 1)
      throw new NatsPublishError("rejected", false);
    try {
      const message = await (await this.manager()).streams.getMessage(stream, { seq: sequence });
      if (!message || message.seq !== sequence || message.data.byteLength > 1_000_000)
        throw new NatsPublishError("rejected", false);
      const messageId = message.header?.get("Nats-Msg-Id");
      return {
        sequence: message.seq,
        subject: message.subject,
        data: message.data,
        ...(messageId ? { messageId } : {}),
      };
    } catch (error) {
      if (error instanceof NatsPublishError) throw error;
      throw new NatsPublishError("failed", true);
    }
  }

  /** Allowlisted consumer position; no mutable broker handle escapes. */
  async consumerPosition(stream: string, consumer: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(stream) || !/^[A-Za-z0-9_-]{1,64}$/.test(consumer))
      throw new NatsPublishError("rejected", false);
    try {
      const info = await (await this.manager()).consumers.info(stream, consumer);
      if (
        ![
          info.num_pending,
          info.num_ack_pending,
          info.delivered.stream_seq,
          info.ack_floor.stream_seq,
        ].every((n) => Number.isSafeInteger(n) && n >= 0)
      )
        throw new Error();
      return {
        pending: info.num_pending,
        ackPending: info.num_ack_pending,
        deliveredSequence: info.delivered.stream_seq,
        ackFloorSequence: info.ack_floor.stream_seq,
      };
    } catch {
      throw new NatsPublishError("failed", true);
    }
  }
}
