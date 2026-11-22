# Configured unpublished drafts

New normal operator attempts use the serialized `editorialExecution: live-policy-v1`
contract. The dashboard records a new normal attempt; the CLI uses its stable
`--request-id` for the same explicit contract. Per-run editorial override flags
are refused for these attempts: edit the canonical handler settings instead.
An absent selector retains the historical journal sequence and policy.
The existing configuration handler reads these public settings together at each
new editorial decision:

- `STEELE_EDITORIAL_MAX_REVISIONS`: substantive edits after the first review, 0–5.
- `STEELE_EDITORIAL_EXHAUSTION_ACTION`: `stop` or `create-unpublished-draft`.
- `STEELE_EDITORIAL_DEADLINE_MS`: the shared duration from the editorial start.

They use the canonical generic JSON settings file selected by `STEELE_CONFIG_PATH`,
with the handler's existing environment/file/default precedence. Saving a browser
edit affects the next applicable decision without restarting. A durable observation
records only applied non-secret values and an opaque revision. Replay uses that
completed observation rather than today's settings. Invalid or unavailable current
configuration stops new work through the existing retry boundary.

The captured-content bridge can compose the same contract when supplied with the
content artifact controller and the shared authoritative article state controller.
It retains the original base workflow key: already accepted legacy invocations
still attach to their old journals. A first-winner source submission intent pins
exact inputs for reconnect; it contains no editorial settings or credentials.
A redelivery cannot switch that saved capture or request contract. Existing bridge
installations without those composition ports retain their legacy behavior; the
release readiness check must verify the new ports before enabling automatic runs.
The explicit fresh-fetch proof still submits its normal attempt separately.

At editorial exhaustion, `stop` preserves rejection. Draft mode seals a separate
exact-output authorization while preserving REVISE findings. Initial approval need
not force a rewrite; draft mode still emits only draft authority, never a broader
verified-publication event. Model or storage failures are not exhaustion.

Authority pins the normal attempt, current exact body and metadata, source context,
package, full review/revision chain, accepted mechanical candidate and applied
policy. It is transactional with the existing durable outbox. Historical retained
adoption uses its original separate proof; it is not used for this normal flow.

The allowed destinations are exactly `dummy-a`, `dummy-b` and one real Substack
unpublished/no-email target. `STEELE_DRAFT_SUBSTACK_DESTINATION` identifies the real
target (default `substack`), separately from each consumer's own
`STEELE_PUBLISHER_DESTINATION`. The existing noncredential origin/byline settings
bind the target opaquely through the Substack adapter. They can be supplied through
the same private generic settings source; private values are never rendered in the
browser or copied into content artifacts. Model workers require no Substack
session credential.

All owner-authorized deliveries read current action and target configuration
through the handler before future effects, including receipt reuse, saved intent,
reconciliation and creation. Target drift or stop refuses delivery. The shared
V2 NATS event and consumers remain unchanged. Both dummy receipts precede the
one-event real publisher. Substack public publication and subscriber email remain
outside this capability. The internal excerpt is retained in metadata; Substack
maps title, subtitle and body, without claiming an excerpt API field.

Slow isolated proof fixtures are explicit integration tests, not additional fast
unit defaults (see #720):

```sh
npx vp test run integration/configured-draft-authorization.test.ts
TESTCONTAINERS_RYUK_DISABLED=true npx vp test run integration/normal-editorial-draft-policy.test.ts
```

These use synthetic models/destinations and isolated Git, state, Restate and NATS;
they are not evidence of a live article or Substack draft. The separate release
proof performs capture refresh, then a distinct normal attempt, after reviewed
images and consumer compatibility are verified.
