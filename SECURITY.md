> **Rebuild status:** confidentiality, credential handling, least privilege, untrusted-input validation and safe diagnostics below remain current requirements. Sections describing specific archived publication flows are historical reference; the replacement's delivery policy and implementation have not been selected. See [rebuild principles](doc/architecture/rebuild-principles.md).

# Security principles

## Public repository, private configuration

The Steele Review is open source. No code change may disclose configuration information about the owner's home setup. Infrastructure details belong in the separate Mind of Steele project, outside this repository.

Protect credentials, API tokens, keys, real internal hostnames and network addresses, private service URLs, account names, home network topology, deployment inventories, and host-specific operational instructions. This applies to code, documentation, comments, fixtures, snapshots, logs, exceptions, HTTP responses, image layers, source maps, release bundles, CI artifacts, tickets, and pull requests.

Generic configuration variable names, synthetic placeholders, controller interfaces, and application deployment requirements are appropriate public material. Do not derive public examples from actual private values.

## Local development exception

The user explicitly permits an unversioned local `.env` containing development connection configuration. It must be Git-ignored, owner-readable only, and excluded from Docker build contexts and every distributed artifact. Do not upload it to CI, embed its values in compiled code, or expose it through frontend environment substitution. Runtime configuration must be supplied separately from application images.

An ignore rule alone is insufficient: check whether sensitive files are already tracked and whether packaging scripts explicitly include them. Never force-add a private configuration file.

## Boundaries and least privilege

External controllers own service authentication and connections. Grant each component only the permissions needed for its role. A connectivity probe must remain read-only; it must not create indices, streams, or publications. Keep publishing credentials and capabilities outside research and extraction components.

Treat source pages, transcripts, research material, and model responses as untrusted input. Validate structured data at runtime and prevent source text from changing tool permissions, credentials, verification rules, or publishing policy. Validate destinations before implementing arbitrary URL fetching so untrusted content cannot reach internal services or metadata endpoints.

## Secret persistence and live configuration

Persist secret values only in canonical private configuration supplied through the configuration handler. Do not create derived key files, per-worker credential copies, configuration caches or durable snapshots containing secrets. Run records, workflow journals, Git artifacts, events, prompts, receipts and telemetry must never contain keys. Temporary request authentication belongs inside the owning adapter and is not a second persisted credential source.

Read current validated configuration through the handler before new decisions and outbound requests. Apply edits at the next applicable boundary; never silently continue from a stale cached credential after a read or validation failure. Audit only the non-secret values actually applied and their configuration revision. Preserve historical decisions for replay, and recheck live delivery permissions before future external effects.

## Safe diagnostics

Return bounded operational status without private endpoints or credentials. Client exceptions may contain request URLs, headers, and authentication details; do not serialize them directly to logs or API responses. Use sanitised error categories and correlation IDs. Apply the same controls to telemetry and third-party error tracking.

## Automated publication

Bind publication to the exact reviewed revision. The owner-authorized completed-cycle policy may release that revision after one correction cycle with a decided REVISE verdict when the retained assessment, judgment, provenance and integrity checks pass. Preserve the actual verdict. See [publishing after one correction cycle](doc/architecture/06-substack-integration.md#publishing-after-one-correction-cycle-820). Preserve evidence provenance, safe retry behaviour, and reconciliation of uncertain publication outcomes. Never let untrusted input bypass verification or directly invoke the publisher.

Explicit owner-authorized draft rehearsals are a separate, limited exception: one mechanically valid revision may be delivered as an **unpublished editable draft without subscriber email**, while its unresolved editorial findings and REVISE verdicts remain intact. A Git-backed exact-version owner authorization and matching typed durable operator binding are required; it is never a factual approval or a model-controlled switch. Only the two designated dummy destinations and one pinned Substack draft target may consume that authority. Destination capabilities, target identity and safe readback are checked independently of cached receipts and retries. Public publication and email actions must refuse draft rehearsal authority.

## Review and incident handling

Any concrete configuration leak or violation of these principles is a blocking review finding, even when tests pass. Findings identify the location and exposure category without quoting sensitive values. Reviewers must inspect relevant generated outputs and packaging behaviour, not only source text.

If private information is discovered, stop propagating it and remove it from working files. If it reached Git history or an external service, tell the owner without repeating it and coordinate removal and credential rotation where applicable. Do not assume deleting the current file removes historical exposure. Do not open a public issue containing private details.

## Live configured normal-flow draft authority

The owner also authorizes NEW versioned normal article attempts to apply the current
configured revision allowance and exhaustion action. When that action is
`create-unpublished-draft`, an initial approving judgment or editorial exhaustion
may produce the same capability-limited unpublished draft authority. Keep the
actual judgment and all unresolved findings; do not call that authority factual
verification. Technical/provider failures, invalid mechanical output, broken
citation references and mismatched provenance cannot use this exception.

This normal-flow proof binds the recorded attempt, exact source context, package,
body and generated metadata, complete assessment/judgment chain, mechanical
provenance, and the non-secret policy observation actually applied. It does not
forge a completed retained-recovery parent. Only the two designated dummies and
one immutable Substack draft target are allowed. Re-read current stop/target
permissions before future delivery effects, including cached receipt and intent
reuse. No publishing credentials are granted to the article worker.
