# Durable research and editorial review

Owner-refined design, 2026-11-22. This records the target stage boundaries,
not a claim that they are implemented. See the [module outline](18-module-outline.md)
for the surrounding pipeline.

## Execution and artifacts

Restate coordinates execution and recovery. The private content Git repository
retains reports, documents, plans, assessments and decisions. Steps consume exact
commit/path/hash references, rather than silently reading the current version of
a dossier. Git is not a task queue. SQLite and completion/outbox transactions
remain private to the state controller; external concerns retain their existing
typed controller boundaries.

Both manual and article-triggered research should submit to the same research
workflow. A command can return its request/job/invocation identifiers and
optionally wait. Disconnecting the command must not cancel accepted durable work
or cause a duplicate submission. The existing direct manual command is not yet
proof of this workflow integration.

## Research stages

1. **Discovery:** run deep research and save the report, original provider
   citation list, model/prompt identity and available usage metadata before
   processing citations. Keep returned material untrusted and exclude credentials
   and transport headers from saved artifacts.
2. **URL inventory:** derive and save a deduplicated list from the exact discovery
   result. Distinguish provider-supplied citations from URLs extracted from report
   text. Do not invent missing provider metadata when recovering an older report.
3. **Document retrieval:** give each URL an independently recoverable operation,
   with bounded retries/concurrency and a saved document or explicit failure.
   Preserve public-source validation, DNS pinning, redirect policy and response
   limits in the retrieval adapter. Successful downloads survive another URL's
   failure; exhausted or unsupported retrieval becomes an explicit gap.
4. **Assembly:** build the manifest/result from saved stage outputs. Record
   unavailable and not-attempted sources. Retrieval does not establish that a
   passage supports a claim; preserve support-assessment and librarian curation
   as distinct responsibilities. Persist completion and pending handoff durably.

Once discovery is saved, restarting retrieval or assembly must reuse it without
another paid discovery call. Restate alone cannot resolve an ambiguous external
provider side effect: a lost response with no saved result must not trigger an
unbounded rediscovery loop. Preserve the existing explicit failure/recovery
policy. A report-only legacy recovery remains honest about its missing envelope
or citation list.

Implementation: #590 discovery, #591 inventory/retrieval, #592 assembly,
#593 Restate orchestration and #594 manual submission, under researcher epic #210.

## Librarian stages

1. **Assess and plan:** resolve proposed-theme mappings to stable canonical themes;
   inspect separate dossiers against the claims and known author research subject.
   Save which material can be reused, which dossiers need creating and which
   need targeted additions, with exact inputs and reasons.
2. **Select:** apply a small deterministic prioritization policy to the saved plan.
   Record selected/deferred tasks and stable tie-breaks. The configured allowance
   is one configuration setting, currently two new research jobs per article
   across its rounds; replay must not spend the allowance again. Existing research,
   including a reused author dossier, consumes no job. New author research uses
   this same allowance, with no separate allocation. A later limit of one uses
   the same selector with a changed configuration value. OpenRouter's external key
   limit controls monetary spend; this is not a new internal monetary-budget system.
3. **Dispatch:** submit selected tasks through the shared research workflow,
   distinguishing new dossier research from targeted enhancement and reusing
   adequate existing or in-flight work.
4. **Reassess:** curate returned evidence through the dossier controller and assess
   claim coverage again. A completed job is not sufficient evidence by itself.
   Allow an initial research round and at most one follow-up research round,
   sharing the article allowance. Reassess the follow-up results without dispatching
   a third round. Retain gaps when preparing the writer's versioned brief or
   recording an unresolved/limited outcome under the existing readiness policy.

The exact initial priority ranking remains an implementation proposal for review.
Saved plans should make reuse, matching, selection, deferral and resulting coverage
visible on the article trace. Themes remain topic identities; dossiers hold their
research. Person dossiers use distinct person identities.

Implementation: #595 assessment/plan, #596 selection and #597 orchestration,
under librarian epic #139; trace integration remains #525.

## Assessor and judge

Separate evidence assessment from the decision about whether to continue:

- The **assessor** records findings about the exact publication payload, including
  title, subtitle, excerpt and body, against its pinned source and evidence.
  Findings describe what is wrong and where, with reasons/evidence, in a readable
  document; Markdown is acceptable. Keep exact identity and completion metadata
  alongside it. A malformed, incomplete or failed assessment is not an empty list
  of faults. The assessor neither recommends repairs nor decides approval.
- The **judge** reviews the article and findings, then approves or recommends
  specific changes for revision. Save its assessment reference, policy/prompt
  identity, reasons and required changes separately. Approval names the exact
  publication version; an edit needs a fresh assessment and judgment.
- Restate coordinates saved assessment, judgment and optional writer revision.
  Mechanical output repair remains a separate writer subloop. Preserve writing's
  independence from assessment, bounded editorial attempts and the existing
  exact-version approval/outbox/publishing boundary.

The judge may use a separately prompted model to interpret findings and recommend
changes. Fixed version, completion and attempt gates stay deterministic. The
earlier rule-based-only judge was a suggestion, not an owner requirement. Fault
count alone cannot decide materiality. Misquotes, wrong citations and material factual
errors remain blocking; clearly distinguishable opinion and minor stylistic notes
remain permissible. Incomplete or mismatched evidence cannot authorize publication.
Version policy inputs so a changed acceptance rule cannot silently reuse an older
approval.

Ordinary opinion does not need an explicit opinion label or a qualifier in every
sentence. The judge should request a correction for a concrete material error in
facts, quotation, paraphrase, attribution, certainty or scope, rather than for a
missing qualifier alone. Conflating separate incidents or allegations can mislead
and requires correction; an obvious evaluative judgment need not be rewritten as
hedged prose. Opinion cannot disguise an invented factual premise. Prefer concise
replacement or deletion to accumulating caveats. Within the roughly 900-word
editorial target, prioritize claims the saved evidence can address; omission of an
unresearched claim is not itself a fault unless the article claims exhaustive
coverage. Keep the legacy combined verifier stable during this replacement.

The console should retain each assessment and judgment, their reasons and the
revision they concern, while preserving legacy combined reports. A terminal
summary is not an additional model assessment.

Implementation: #598 assessor, #599 judge and #600 editorial orchestration,
under #141; history integration remains #499. Deterministic tests establish
contracts and replay behavior, not that a model will always follow feedback.

## Console and writer sequencing

Owner decisions recorded on #516, #522 and #535:

- A canonical-theme detail page uses the stable theme ID and lists research files
  whose contents can be opened. Proposal pages link through saved mappings; an
  unmatched proposal explicitly remains unmapped.
- Overview's running-work display consumes the same typed activity source as the
  Activity page. Implement the shared source (#479) before its Overview consumer
  (#522), rather than introducing a second liveness source.
- Finish the assessor/judge editorial loop (#598–#600) before changing writer
  output to Markdown/front matter (#535). Preserve bounded field-only mechanical
  repair, response retention and exact-version approval through the format change.

These are implementation requirements and ordering decisions, not deployment or
owner-browser acceptance evidence.

## Next editorial end-to-end checkpoint

After the assessor/judge corrections, exact-version approval integration (#580)
and connected Restate editorial loop (#600) pass review, deploy the reviewed
compatible build and rerun the same previously processed article through the
normal pipeline. Preserve the original terminal attempt and exact source
version; an intentional rerun needs its own durable request/attempt identity,
while retries of that same request attach to the same attempt. Do not change the
source version merely to manufacture a new run or clear failed state.

Keep the configured research allowance unchanged, currently two new jobs. The
normal librarian should reuse applicable saved mappings and evidence and may
commission new work for remaining gaps within that allowance. The earlier
zero-research/saved-package-only proposal is withdrawn for this checkpoint.
Record actual evidence/job reuse separately from newly commissioned work; do not
assume a repeated article automatically means no new research.

Before submission, confirm no conflicting active work, preserve private runtime
configuration, apply the reviewed configured-person attribution, and inspect
saved source context plus actual writer input for author identity and basis,
observed byline, original medium, supplied representation and dates. No new
capture is required solely to repeat paid research. Refresh, when needed, remains
a separate action from processing.

Follow the new attempt through saved draft, assessment, judgment, bounded revision
and exact-version approval. Prove both dummy destination receipts (#244), then
perform the already authorized controlled real editable draft proof (#386),
unpublished with subscriber email off and exact read-back. Reconcile uncertain
side effects rather than creating another draft. Keep broad automatic publishing
and unrelated backlog processing off. Retain unresolved findings on failure.

Unrelated console features, Markdown writer output and the broader standalone
research migration are not additional prerequisites for this editorial checkpoint.
Report which researcher/librarian path actually ran; this checkpoint does not
claim completion of their separate migration tickets. These are execution and
acceptance requirements, not evidence that a deployment or trial has happened.
