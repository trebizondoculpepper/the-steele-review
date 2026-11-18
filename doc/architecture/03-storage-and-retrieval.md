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

Exact Elasticsearch indices and mappings are not yet selected beyond the source-text index described below. Use stable logical IDs and explicit schema versions; avoid coupling event consumers to an index layout.

## Source text index v1

The first index is `steele-source-text-v1`, defined by `src/content/fulltext-document.ts`. It holds the retained text of one source post per document, with content identity, acquisition origin, source version and an immutable artifact reference. The document ID is derived from content identity (`substack:<publicationId>:<postId>`), so retried indexing rewrites the same document instead of appending; a changed source replaces it deliberately, and earlier bytes remain addressable through the artifact reference. The mapping is explicit and strict, and declares no vector or semantic fields: semantic retrieval remains a later decision. The index name carries the schema version, so a breaking contract change needs a new index and a deliberate re-index.

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

## Private state-controller boundary

SQLite is retained for the proof of concept, privately owned by one in-process state controller. Elasticsearch remains the search index, not a second authority for operation claims. A separate state microservice is deferred unless independently deployed workers require it.

Only the state-controller implementation imports the SQLite driver, knows its configured database path, owns migrations, or issues SQL/transactions. Workers and other controllers receive a small typed interface with domain operations: claim an operation, complete it with an artifact and pending event, inspect its status, list pending events, and conditionally mark an event sent. Add renewal/failure operations only when required by the lifecycle contract. Do not expose a generic query, arbitrary table access, raw database handle, or database-file access.

Keep transaction semantics inside the controller: completion and pending handoff are atomic. Claims and completion use ownership/version tokens so expired workers cannot overwrite newer owners. Reads return detached domain records, not driver-specific values. Unit tests may inject an in-memory interface implementation; controller integration tests use a temporary private database. Application components must not share or mount the database file as their communication mechanism. If a service boundary is added later, preserve these domain methods instead of exposing SQL remotely.
