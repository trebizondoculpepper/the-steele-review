# Retained incomplete research recovery

`recover-research --input <private-reference-json-file>` processes one already retained discovery response. The input object contains `discovery` and `failedResult`, each an immutable artifact reference (`repository`, `commit`, `path`, and `hash`). Keep real corpus references and deployment configuration private.

This is an explicit `retained-length-limit-v1` recovery, not another discovery attempt. The entry point has no Sonar capability. It accepts only a transport-complete, structurally valid response whose sole completion limitation is the provider output limit. The discovery must have its original accepted state-controller fence and matching returned-body hashes. Malformed, truncated, resource-limited, unfenced or quarantined responses remain ineligible.

The original failed job and response stay unchanged. The recovery creates a distinct job with the next pass, original job identity, and exact discovery/failed-result references. Those references and the source context participate in the recovery identity. The saved report, manifest, covering note and result retain the incomplete-report limitation; the result always remains `complete-with-gaps`. No missing prose is reconstructed and the old discovery charge is not charged again as a new discovery call.

The existing public-page fetcher retrieves the retained citation and annotation URLs. The support checker independently identifies verbatim passages in archived sources; the report itself is never independent evidence. Source failures, unsupported findings and missing report text remain gaps. `--max-sources` bounds retrieval to 1–20 sources (default 20).

After durable completion, the state controller accepts one exact original-request-to-recovery-result binding under the current recovery owner and lease. The normal research composition reads and revalidates that binding before returning the distinct recovered job and exact result reference. It does not overwrite the failed result, spoof its job ID, or perform general theme matching. A changed post, claim list, context or question cannot inherit the binding. A different recovery candidate cannot silently replace an accepted one.

Restarting the same operation reuses the saved result. A saved Git candidate alone does not activate a recovery: expired/stale owners cannot publish its binding. Storage interruption between saving the result and accepting its binding can be resumed without discovery, retrieval or support calls repeating once the child result is complete.

Normal librarian curation and writer-package assembly still determine which claims have independently supported evidence. This command does not draft, approve, reset an article workflow, or publish. Subsequent article runs retain the ordinary exact-version assessor/judge and delivery gates.

## Continuing the normal article pipeline

After both required recoveries are accepted, submit a new explicitly named article attempt using `article-run --request-id <new-request> --recovery-generation 1 --retained-research-file <private-job-id-json-file>`, together with the ordinary publication/post and research-cap options. The file is a bounded JSON array of the original research job IDs in the configured plan order.

The CLI verifies every accepted binding against the exact current capture and configured source context before recording or submitting the attempt. The existing serialized recovery generation changes the Research service idempotency key: the original failed service invocation and article attempt remain untouched. Without that generation, Restate correctly returns the old cached failure.

The workflow checks its selected research-request prefix against the supplied IDs before dispatch. A changed plan stops with an explicit gap, so this saved-report continuation cannot silently buy replacement discovery. Successful matching calls return the distinct recovered job references through normal research, coverage and package composition. No special writer-package or editorial workflow bypass is introduced. With these flags absent, prior submission and journal identities stay compatible.

### Commissioning priority across planner upgrades

The normal planner records an explicit ordered dossier list in version-2 plans;
sorting the mode map for serialization does not change which requests consume
the article allowance first. A new plan preserves compatible first-pass dossier
order from coverage of the exact same analysis, then appends unrecorded groups
in extraction order. Conflicting historical orders stop with an explicit
compatibility error. Existing version-1 plans retain their serialized order,
and every saved plan remains immutable. The retained-research prefix guard still
refuses a plan that would select different jobs; do not bypass it by shuffling
operator input or increasing the allowance.

## Readable output limits are warnings (#755)

For normal, still-unfinished whole-job and local-subject research, the
`warning-v1` curation policy accepts nonempty report text only when the saved
provider envelope is structurally valid, transport-complete and durably fenced,
and its sole limitation is `length-limit`. The original discovery record stays
`invalid/length-limit`: this is a curation policy, not a rewrite of that audit.
Its exact reference accompanies the machine-readable `report-output-limit`
warning in the report snapshot, manifest, result, coverage and writer package.
The writer receives the warning; the research browser labels the partial result.
Normal retrieval and independent passage checks still apply. Missing prose is
never reconstructed, and the outcome stays `complete-with-gaps`.

Terminal results and existing Restate outputs remain immutable, including older
`failed/invalid-report` outcomes. Recover those through the explicit retained
entry point above, which emits the same warning and creates a distinct result
without another discovery call. This change adds no workflow steps or new
scheduler. Existing completed steps and terminal invocations replay their saved
results. Empty content, corrupt or unparseable transport, lost fences, resource
limits and artifact failures do not qualify as a partial-report warning.

### Reuse and diagnostics

The ordinary exact-request terminal cache and accepted retained-recovery binding
reuse partial results on subsequent runs. Incompleteness does not invalidate the
saved result. The librarian does not automatically commission its consequential
follow-up from a `report-output-limit` result; unsupported claims remain gaps.
Explicit operator reprocessing remains distinct. General cross-post semantic
matching is separate from this exact-request reuse contract.

A best-effort Sentry warning uses the existing allowlisted pipeline-log adapter:
only opaque research job ID, discovery digest, fixed stage and category. The
state controller reserves one diagnostic per exact discovery digest, including
across restarts and recovered aliases. It reserves before export to avoid
retry floods; a crash or unavailable Sentry can lose that telemetry, while the
warning remains durable in the research artifacts and browser. Diagnostic
storage or Sentry failure never blocks research. Live Sentry arrival is an
operational verification after reviewed deployment, not a synthetic-test claim.
