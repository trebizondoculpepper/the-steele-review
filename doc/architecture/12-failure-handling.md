# Failure handling

Use established workflow patterns with the existing controllers, state controller and JetStream. This does not introduce Temporal or another workflow platform.

## Error classification

| Failure                                                       | Action                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transient network error, timeout or temporary service failure | Retry within configured attempt and elapsed-time bounds, using capped exponential backoff and jitter.                                                  |
| Rate limit                                                    | Honour a valid provider retry-after delay within policy bounds; reduce concurrency rather than immediately retrying.                                   |
| Exhausted provider credit or missing/invalid configuration    | Persist a pending/blocked reason and pause affected provider work; avoid repeated paid calls or a hot retry loop. Other independent work may continue. |
| Malformed event or unsupported schema                         | Record a sanitised permanent failure/quarantine outcome, then stop automatic redelivery after durable recording.                                       |
| Unavailable content or unresolved evidence                    | Record an explicit editorial skip when policy says no useful processing can continue. Do not classify outages or exhausted credit as editorial skips.  |
| Attempts exhausted or implementation defect                   | Persist an inspectable failed/parked operation; do not silently drop it or retry indefinitely.                                                         |
| Uncertain publication response                                | Reconcile the stored destination draft ID; never create a replacement merely because a response was lost.                                              |

## Retry ownership

Set timeouts on every external call and bound concurrency and in-flight work. Choose one layer to own each retry budget so SDK retries, controller retries and broker redelivery do not multiply attempts unexpectedly. Record operation ID, attempt and sanitised error category; never log raw private configuration or client exceptions. A timeout does not establish that an external side effect did not happen.

Application backoff uses jitter; JetStream consumer BackOff is a separate configured redelivery schedule. JetStream BackOff applies to acknowledgment timeouts, not an ordinary negative acknowledgment. When negatively acknowledging with delay, use the client's explicit delayed form rather than assuming consumer BackOff applies.

## JetStream lifecycle

Use explicit acknowledgment, bounded MaxDeliver and a stage-appropriate AckWait/BackOff policy. For legitimate long work, extend progress acknowledgments within an overall operation deadline or persist a durable handoff before acknowledging. Never hold a delivery forever or acknowledge before durable state/artifact handoff.

JetStream does not automatically move exhausted deliveries into a dead-letter queue. MaxDeliver exhaustion leaves messages in the stream and produces advisories. Configure an application-owned failure/quarantine path or inspectable state record, and test how exhausted deliveries become visible. Do not assume a successful broker acknowledgment means business work succeeded.

## State and idempotency

A private in-process state controller owns SQLite claims, expiry, completion and pending-event transactions. Persist completed results and pending handoff before acknowledging. Dispatcher retries can emit duplicates; consumers deduplicate by stable operation/content identity and validate claim ownership. A single failed post must not block unrelated posts, but a provider-wide credit failure should pause that provider's jobs rather than fail each item independently.

Proof-of-concept tests cover duplicate delivery, transient failures, permanent malformed input, credit exhaustion, partial completion and uncertain external side effects. Backup/restore and disaster-recovery infrastructure remain deferred.

## References

- [NATS consumer configuration](https://github.com/nats-io/nats.docs/blob/master/nats-concepts/jetstream/consumers.md)
- [NATS advisory-based dead-letter handling](https://github.com/nats-io/nats.docs/blob/master/using-nats/developing-with-nats/js/consumers.md)
- [AWS Builders' Library: timeouts, retries, backoff and jitter](https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter)
- [Temporal retry-policy guidance](https://docs.temporal.io/encyclopedia/retry-policies)
