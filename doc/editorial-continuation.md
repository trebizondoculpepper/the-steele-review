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
