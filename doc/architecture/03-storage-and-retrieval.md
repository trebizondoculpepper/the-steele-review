# Storage and retrieval

## Responsibilities

Use the existing Elasticsearch service for searchable source text, extracted claims and themes, historical retrieval, and analysis records. Use a durable archive for retained source text and transcripts. Do not retain audio or video originals; media is temporary transcription input. Workflow state uses SQLite with conditional updates for the initial collector; search indexing is a derived concern.

The official Node client, `@elastic/elasticsearch`, includes TypeScript support. Select its version against the actual server version: [Elastic TypeScript documentation](https://www.elastic.co/docs/reference/elasticsearch/clients/javascript/typescript).

## Proposed record types

| Record            | Important fields                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Source post       | Publication ID, post ID, canonical URL, title, publication time                          |
| Source version    | Source key, version hash, retrieval time, original references, completeness              |
| Extracted content | Source version, extractor version, text, paragraph IDs, transcript timestamps            |
| Claim             | Exact source passage, normalised claim, entities, relevant dates, source version         |
| Analysis          | Claims, themes, historical matches, evidence references, model and prompt versions       |
| Article           | Source versions, draft versions, verification results, destination ID, publication state |

Exact Elasticsearch indices and mappings are not yet selected. Use stable logical IDs and explicit schema versions; avoid coupling event consumers to an index layout.

## Historical questions

Retrieval should support:

- How often has this publication discussed a topic, and over what observed period?
- Is it returning to a topic after an absence in the indexed material?
- Has the framing or a specific factual assertion changed?
- Does a new statement conflict with an earlier statement about the same subject and time?

Start with publication, date, entity, and text filters. Semantic retrieval is optional and requires a later decision about embeddings and server capabilities. Broad similarity alone is not evidence of contradiction.

Every historical comparison retains both passages, URLs, dates, and source versions. Distinguish an actual contradiction from a changed prediction, newly available evidence, or different circumstances. Frequency statements describe the indexed corpus and must acknowledge gaps in historical coverage.

## Independent evidence

Keep monitored-source material distinguishable from independently researched evidence. Store evidence URLs, retrieval times, relevant passages, and the claims they support or contradict. A source repeating an assertion is evidence that it made the assertion, not independent confirmation that the assertion is true.

## Initial collector persistence decision

Use SQLite on a persistent local volume for collection workflow state, conditional work claims, retry status, and pending downstream event handoff. Store retained article text, supplied transcripts, generated transcripts, and provenance as files on a persistent volume. Elasticsearch receives a searchable derived copy in a later indexing stage. SQLite is the initial collector choice; Restate remains a possible later evaluation, not a prerequisite.

Use publication/post identity to deduplicate initial collection. Atomically claim work, use recoverable leases for interrupted attempts, and mark completion only after the text artifact is durable. Write artifacts atomically under predictable keys, reconcile orphaned artifacts after crashes, and keep pending event records in SQLite so indexing handoff can be retried. Acknowledge discovery after durable completion/handoff, not before. The SQLite file and archive must reside on storage with supported local locking semantics; do not assume shared network filesystem compatibility. Backup, restore tooling, and disaster recovery are deferred beyond the proof of concept.

Acquisition prefers existing source transcripts, otherwise temporary audio for transcription, with temporary video as the last fallback. Retain text and provenance only. Media cleanup runs after durable transcript storage and expires abandoned/failed inputs within configured bounds. Live and backfill share the collector, while preserving ingestion reason so backfill cannot enable automatic article publication.

## Proof-of-concept artifact versioning

Use a private Git repository on the persistent artifact volume to version text, provenance, evidence briefs, drafts and verification results as Markdown/JSON. Keep it separate from the public application code repository. One archive-writing component serialises commits; stages reference exact commit IDs and paths. Verification approval also identifies the draft content hash so changed content cannot inherit approval. SQLite remains the store for operation claims, retry state, pending handoffs and publication status; Git is not a task queue. Never commit temporary media or credentials.

No backup/restore implementation or disaster-recovery system is required for this proof of concept. Consider that work only after the end-to-end experiment succeeds. Ordinary retry correctness and duplicate-publication prevention remain in scope.
