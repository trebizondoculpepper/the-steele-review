# One approved event through the real draft consumer

`substack-publisher-one` is an explicit bounded operator entrypoint. It does not
publish an approval, activate the continuous Substack publisher, change its
consumer, or drain an unrelated backlog. Supply an actual verified event ID and
its retained sequence on the configured publication stream:

```sh
npm run substack-publisher-one -- --event-id approved-synthetic-example --sequence 42 --wait-ms 30000
```

The example identifiers are synthetic. Use the existing publisher role's private
NATS, content/state, Substack session/origin, destination and optional byline
configuration. The command requires no model credentials. Configuration variables
are the same as `substack-publisher`; `STEELE_SUBSTACK_DELIVERY` remains unchanged.
This command itself authorizes only the explicitly selected draft attempt.

Before creating its scoped durable consumer, it validates the exact outbox event
and dispatched status, retained message subject/message ID/sequence/payload,
immutable approval and publication fields, and both dummy destination receipts.
Missing or mismatched proof stops without provisioning or destination effects.

Explicit provisioning uses a stable `selected-<digest>` durable derived from the
stream, event, sequence and destination/action, starting at that exact retained
sequence. It refuses incompatible existing consumer configuration. It never uses
new-only delivery (which would miss an event already retained), changes the
continuous durable, or creates a stream. Reconnect with the same event, sequence
and destination; do not invent another identity to bypass uncertainty.

The normal publisher service and approved-article handler run on one fetched
message. The expected event ID, exact payload and broker sequence are checked
again before handler effects. A mismatch stops without ACK, NAK or termination.
The one-message fetch does not auto-prefetch the next unrelated message. The
receive wait is bounded; the existing Substack adapter bounds its external calls.
A deadline does not establish whether a draft exists.

The handler reuses normal ownership, exact-version approval, saved intent/preview,
schedule, receipt and uncertain-create reconciliation. No content is regenerated
at delivery. The result is successful only after the real/non-simulated receipt
has been checked and the broker confirms the ACK. A false/missing ACK response is
`ack-uncertain`, not success. If the ACK was committed before the process lost its
response, reconnect verifies the broker ACK position and exact real receipt and
returns reuse without another create. A simulated receipt with the real
destination's name cannot establish real delivery.

A pending/uncertain result ends this invocation. Do not blindly create again:
repeat only the same recorded selection through normal reconciliation, respecting
the existing destination attempt limits. An incomplete or ambiguous reconciliation
stays unknown. The real consumer ACK occurs after durable completion; the command
never claims an unknown side effect did not happen.

Substack receives the exact approved title/subtitle and converted body, with the
frozen configured destination byline if present. The adapter reads those fields
back and requires an unpublished editable draft. Excerpt stays in the private
approved publication artifact and is not mapped to an invented platform field.
There is no publish or subscriber-email operation. Receipt and draft references
belong in private operational records; public diagnostics expose no endpoints,
credentials or response bodies.
