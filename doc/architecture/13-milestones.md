# Agreed milestone sequence

This sequence supersedes the earlier first-milestone suggestion of three verified drafts. Features may have been implemented out of order; acceptance remains defined by observable outcomes, not ticket closure alone. No model/API credentials or live integrations are implied by this plan.

## M1: content capture and searchable text

Start with three historical posts from the configured public Substack source, one at a time. Discover metadata, acquire article text and supplied transcripts, and use local Whisper when transcription is actually needed. Evaluate whisper.cpp with one job at a time and representative audio before increasing throughput. Use externally configured fallback only if local quality/throughput proves inadequate.

Save text and provenance as immutable artifacts in private Git, record operation state through the private SQLite state controller, and index retained text in Elasticsearch so it can be inspected immediately. Temporary audio/video is removed after durable text storage; failed/abandoned input has bounded cleanup. Repeating the run must not duplicate retained content or search documents. Report unavailable, partial and failed items honestly.

Acceptance evidence: inspectable source text in Elasticsearch, source URLs/dates where provided, acquisition origin, exact Git artifact reference, clean media-retention outcome, and repeat-run behaviour. A supplied-transcript-only sample validates that path, not the untested Whisper fallback. No theme extraction, embedding, claim analysis, research, draft or publication is required to pass M1. Publishing account setup and Kagi credentials can wait.

## M2: themes, claims and observed timeline

Extract concise themes and specific claims grounded in captured passages. Index each claim occurrence with source date, attributed speaker, exact passage and artifact provenance. Support queries for when a claim was observed, how often it appears and who asserted it. Distinguish post author from quoted speaker, publication date from assertion date, occurrence count from post count, and observed coverage from complete history. Basic keyword/filter/aggregation queries suffice; embeddings are optional later.

## M3: reusable research keeper

Maintain independent evidence and small topic explanations as reusable versioned dossiers. First ask whether the existing corpus is sufficient for the current claim. Reuse established material, research gaps, and optionally run a short Kagi freshness check when a new post warrants it. No scheduled refresh or automatic dossier expiry. Repeated requests share existing research/work rather than researching each topic afresh.

Kagi is the selected search/extraction service; setup is deferred until real research testing. OpenRouter is the intended configurable text-model gateway. Rely on its key spending limit rather than build a proactive budget subsystem. When the provider reports exhausted credit, affected jobs remain pending/paused with a visible reason and bounded retry; do not call them editorial skips. Research call/page/time limits are configurable and bounded; exact numerical limits remain provisional.

## M4: coordination and drafting handoff

A small coordinator routes analysed posts to the research keeper, tracks pending work and requests relevant research documents after completion. Research keeper owns sufficiency/research decisions; coordinator owns routing and progress. Save the exact source/claims/research references in a versioned evidence brief and hand it to drafting. No duplicate research logic in the coordinator.

Drafting, verification and eventual publishing are defined later pipeline capabilities. They do not expand M1, and M4 can be accepted at a valid inspectable handoff without a working publisher account.

## Later publication and optional investigations

Publisher receives a trusted approval event containing the approved Git commit/path and logical archive identity. Check/claim state first, read the exact committed file, publish through the Substack controller, then save destination ID/URL and acknowledge. The hash fixes identity, not authority; the trusted verifier event grants approval. Do not reanalyse research inside the publisher. Persist destination identity and reconcile uncertain publication responses before retrying; no duplicate drafts/posts.

Optional embedding exploration (#73), secret-store research (#65), OpenSearch migration research (#75, low priority) and backup assessment (#47, deferred) must not block capture. External embedding computation remains the current approach; do not migrate infrastructure as part of research. Writing/reasoning models and embedding models are separate settings. Record embedding model/dimensions/version; changing the writing model does not invalidate existing vectors.

## Implementation links

- Discovery/capture: #5, #14–#17 and the source-text indexing worker #25.
- Theme schema/extraction: #77–#78.
- Claim extraction: #32–#34; indexed occurrences and timeline queries: #79–#81.
- Research keeper: #37–#40.
- Coordinator: #82, handing evidence to #41.
- Publisher tracker: #46 and its children, deferred beyond these milestones.

GitHub milestone assignments reflect these groups. Optional passage/vector work (#27–#31) can proceed separately but is not required for content-capture acceptance. Existing claims and completed tickets remain authoritative in GitHub.
