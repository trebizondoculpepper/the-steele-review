# Explicit editorial continuation

An editorial continuation is a new, explicitly requested operator invocation,
linked to an immutable terminal parent. It is not an automatic retry or a silent
reset of the parent's revision allowance. Prior and new attempt counts must stay
visible. The initial edit using the parent's saved feedback consumes one of the
new invocation's configured revision turns; with the existing allowance of two,
only one further edit can follow it.

## Exact saved-artifact seed

`EditorialContinuationInputSchema` pins the parent workflow key and saved
terminal summary, package, canonical body and metadata, publication payload,
assessment, decided REVISE judgment, and bounded linked history. The read-only
`readEditorialContinuation` checks full logical repository/commit/path/hash
references, source capture and current configured context, complete role
documents, the recorded operator input identity, and the current canonical base.
It returns references and prior counts, never a model, research, approval or
publishing capability. Missing, malformed, mismatched or stale artifacts fail
closed; operational storage failures remain retryable exceptions.

Version 1 accepts an unresolved ArticleRun parent with its complete bounded
editorial chain. It does not rewrite or migrate the parent. The reader also
refuses an approved or unfinished summary. A recorded article-attempt intent is
not authoritative proof that its Restate workflow finished: the durable
continuation entrypoint must independently read the exact parent completion and
require its returned summary reference to match the selected summary before any
paid edit. Artifact validation alone must never authorize concurrent work.

## Durable workflow boundary

The workflow/CLI slice is tracked separately in #689. It must preserve existing
ArticleRun journals, use a distinct versioned contract and stable operator
request identity, and first revise the exact saved final article with its saved
required corrections and optional observations. It must not regenerate themes,
claims, research, a package or an initial draft. Recheck the expected canonical
base immediately before the paid stage; existing revision commits retain
compare-and-swap protection against a concurrent edit. Where reliable broad
writer-conflict discovery is unavailable, report that limit rather than claiming
a bounded latest-record list proves no active work.

Every resulting version still needs a fresh independent assessment and judgment.
Only approval of its exact publication payload can enter the existing approval
outbox and delivery path. Old approvals never transfer. The continuation does
not enable a publisher or drain a backlog; dummy proof and controlled real draft
delivery remain separate operational gates.

## Operator entrypoint and reconnect

The `editorial-continue` CLI accepts `--input <seed.json>` and a stable
`--request-id`, with optional bounded `--wait-ms` and `--json` output. Its
versioned `EditorialContinuation` workflow is separate from ArticleRun. The CLI
validates flags and the bounded seed file before recording an intent or making
an ingress request. `RESTATE_INGRESS_URL` is private runtime configuration for
the read-only parent-completion check and CLI submission. Missing continuation
configuration fails this workflow closed without disabling existing ArticleRun
handlers.

A new intent pins the exact seed and configured policy in Git and the typed
state controller before submission. Repeating the same request attaches to that
intent, including its frozen policy, even if configuration changes or the
continuation has already replaced its original canonical base. Reusing the
request ID with another seed is a conflict. An uncertain submission response
must be retried with the same request ID; an observation timeout does not cancel
the durable workflow.

The parent-completion and initial base checks form a journaled preflight.
Subsequent replay uses that recorded preflight and existing retained-response
recovery instead of rejecting the continuation's own successful edit as stale.
Before genuinely new writer work, the expected current body and metadata are
checked again; canonical writes retain their existing compare-and-swap guard.
This does not claim to enumerate all other active writers. A concurrent change
fails closed at the base check or commit guard.

Each summary records the immutable parent, separate prior/new counts, every
known new role/version reference, mechanical runs and retained writer attempts.
The first seed edit consumes one revision turn and shares the same deadline
with subsequent review and any remaining edit. If inner history persistence
fails, the outer diagnostic preserves known latest work and any known approval
event while marking the inner summary unavailable. That operational outcome is
neither a fabricated rejection nor proof that no approval side effect occurred.

## Denied-judge operational checkpoint

`readEditorialRecoveryCheckpoint` is a read-only validator for a failed
continuation that retained a complete assessment and a known authorization
rejection with no returned judge document. It pins the failed continuation's
exact summary, original immutable intent, current body and publication fields,
assessment, failed judgment, and capture manifest/input. Returned, late,
ambiguous or differently configured tasks are not eligible. This denial has no
returned-body fence: it requires a completed known-denial capture with no raw
response, completion header, late-response marker or response fence. An
interrupted or quarantined response is not a denial checkpoint. The
original model-facing request and lineage stay unchanged; a later execution
contract must use a distinct explicit recovery generation and independently
verify the exact failed parent's authoritative completion.

The reader derives spent and remaining edits from the original frozen allowance
and recorded version/pass counts. It neither renews an old deadline nor grants
extra edits. A separate versioned execution contract owns any new bounded window
and can start by judging the saved assessment without regenerating paid work.

Approval reconciliation checks the exact event identity of this failed judgment,
and refuses an existing or uncertain state/outbox entry. This is not a global
claim that no other judgment ever approved the same body. Authoritative parent
completion, the exact unchanged canonical base, and normal version-bound
approval/delivery controls remain required before execution. The archived
ArticleRun-history reader used here is audit-only and does not itself authorize
a new edit from that obsolete base.
