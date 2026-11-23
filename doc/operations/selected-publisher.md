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
more than one outstanding delivery: a selected event waiting after a delayed NAK
cannot be bypassed by a later unrelated event, including on reconnect. A reused
scoped consumer with a wider outstanding-delivery policy is refused, not silently
modified. Continuous consumer defaults are unchanged. It never uses
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

## Live publication with subscriber email (#789)

Owner decision: future approved posts are published automatically to Substack, and subscribers get them by email. The reviewed Facial Recognition draft and the existing backlog are left out: the owner handles those manually.

**Activation.** On the `substack-publisher` service, set both:
- `STEELE_SUBSTACK_DELIVERY=publish-with-email`
- `STEELE_SUBSTACK_PUBLISH_FROM=<ISO time>`, the activation instant. Only approvals made at or after this time are published.

The service refuses to start in publish mode without the cutoff. `STEELE_SUBSTACK_DELIVERY=live` keeps the draft-only behaviour, and any other value leaves delivery off.

**Eligibility.** The publish destination (`SubstackPublishDestination`, action `publish`) ends these as `not-eligible` before reading, rendering or sending anything:
- approvals made before the cutoff (the backlog);
- owner draft rehearsals.

**Delivery.** For an eligible approval, the destination does three things:
1. It creates and verifies the draft exactly as draft delivery does: title, subtitle, body fingerprint and byline must match on read-back.
2. It publishes the draft with `send: true`.
3. It reads the draft back and requires it to be published.

The receipt records `publicationSafety: { published: true, subscriberEmail: "requested" }`. Delivery uses the existing operation identity and receipts, keyed by action `publish`.

**Uncertainty.** Once the draft exists, any doubt sends the delivery to an operator, and it is never retried automatically, because a retry could publish or email twice. That includes a rejected or uncertain publish call and a read-back that isn't published. `reconcile` never infers a publication on its own.

**API caveat.** Substack has no official publishing API. The publish call uses the same private web API as draft creation: `POST /api/v1/drafts/{id}/publish` with `send` and `share_automatically: false`. It is covered by tests against a fake Substack only. The first real publication after activation is the live check, and it emails real subscribers.


## Default byline (#814)

Substack does **not** give a draft its author automatically. A draft created through the API without a byline is saved with none (checked live on an unpublished draft).
- **Setting the author:** for a single-author publication, set `STEELE_SUBSTACK_BYLINE_ID` to that author's user ID, the only user on the publication. An explicit byline is saved and reads back.
- **Where Substack reports it:** saved bylines come back in the draft's `postBylines` field. The client reads them from there, so the read-back byline check works.
- **Ambiguous or missing selection:** if no byline is configured, drafts stay without one, and that shows in the editor.
