# Extraction-first checkpoint and refined contracts

## Immediate acceptance target

The next owner checkpoint is approximately ten already captured posts with inspectable, clean themes and claims that could be handed to a research agent. Validate one post first, then increase the sample after inspection. Pause on quality defects, fix and revalidate before expanding. Neither research execution, drafting, automatic coordination, nor publishing is required for this checkpoint. One aggregate completion event is the first event integration; finer per-theme/per-claim fan-out is later.

These owner refinements supersede earlier requirements that theme acceptance needs an exact quote, that every extractor label is a canonical corpus identity, or that unclassified assertions are accepted claims. Implementations must version changed contracts and preserve historical artifacts.

## Theme proposals

A post theme proposal has a stable result-local ID, title, optional description, and source post/version provenance. Quotations are not mandatory. Propose broad recognised researchable topics; Wikipedia-style notability is a scope heuristic, not evidence of truth. Do not create a theme for every unusual assertion.

The researcher owns later mapping to existing corpus themes, potentially using embedding proximity to shortlist candidates and semantic comparison to decide. Proposed wording may differ from the canonical title. Preserve original proposals and the mapping so linked claims remain traceable. No embedding implementation or researcher mapping is required for the extraction checkpoint.

## Accepted claims and refinement candidates

Each accepted claim references a specific post/version and its available publication date, at least one extracted theme proposal, an exact quotation with source location or timestamp, and a self-contained summary of the assertion. Speaker attribution is separate from publisher identity; unknown information is never invented. Preserve qualifiers, dates, quantities and negation.

A summary may resolve a pronoun from unambiguous source context, but must not guess. Assertions missing a theme, required provenance, exact quotation or clear meaning remain explicit candidates needing refinement, with reasons. Do not index or announce those as accepted claims. The extracted assertion remains separate from any later truth/evidence assessment.

Schema validation checks structure; quotation checks establish source grounding. Neither proves semantic accuracy. Inspect real outputs for meaning and theme fit before declaring a batch clean.

## Diagnostics and delivery

Preserve bounded rejected/candidate labels or summaries and validation reasons in private artifacts, not only array positions. Distinguish schema failure, missing source quotation and semantic refinement. Operational output stays allowlisted counts/codes and never exposes raw provider payloads, private configuration or source prose. Explicit private inspection can show the evidence and candidate reasons.

Save versioned themes and claims in private Git first. The aggregate event points to their exact repository/commit/path/hash and source/model/prompt versions, with minimal post/event/schema context. Use the state-controller outbox and stable event identity for reliable NATS delivery. A stage completion may include reported candidates; it is not itself clean-batch acceptance. Invalid/incomplete runs do not announce successful analysis.

Application Git operations remain behind the typed artifact controller. SQLite owns operational state only through the state controller; Elasticsearch is a derived search index. The private archive may later gain its own private remote. Never push or merge corpus contents into the public code repository or use its public remote for archive synchronization. Setting up the owner's private remote is outside this tranche.

## Downstream design context

The intended corpus is a directory per canonical theme with metadata and any number of Markdown reports. Initially retain each hosted research report whole and add a small source-backed findings index rather than requiring report splitting. Research checks theme existence, then claim-specific evidence coverage; it reuses existing work or expands genuine gaps. A per-post brief in Git points to the original source, mapped themes, covered claims, exact research versions/passages and explicit gaps. Drafts and reviews are also versioned artifacts. These are future interfaces, not claims that the current single-file dossier implementation already has this layout.

Hosted research can be submitted asynchronously, tracked by provider job/session ID and polled before importing the report. Provider adapters remain swappable. This does not block extraction; no hosted research job, new API credential or full research loop is required now.

## First live experiment: limited evidence

One stored post produced one accepted weather-modification theme and seventeen structurally grounded claims using an experimental clarified prompt and a cheap model fallback. Three claims were unclassified, several summaries retained vague references, and rejected-theme names were not retained. Consequently those seventeen records are not accepted as clean under this refined contract. Reruns reused results without model calls. No NATS, index writes, research or publishing was triggered in that isolated experiment.
