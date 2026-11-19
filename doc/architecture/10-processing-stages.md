# Processing stages and proof-of-concept contracts

This records the subsequent architecture discussion. Implement independently testable modules with narrow interfaces, then compose workers. TypeScript is required for application/test code; operational scripts may use suitable local languages. Private configuration stays out of public artifacts.

## Collection and artifacts

Discovery sends metadata events; collection is a separate consumer. Prefer supplied transcripts/captions, then temporary audio transcription, then temporary video only as a fallback. Persist retained text and provenance, not media. Use a private Git repository on the persistent artifact volume for revision history and SQLite for claims, retry status and pending handoffs. One writer serialises commits. Normal retries and duplicate prevention are required; backup, restore tooling and disaster recovery are deferred beyond the proof of concept.

The artifact reference contract should include a logical repository identifier, commit ID, relative artifact path, content hash and artifact/schema version. Never emit actual mount paths, hostnames or credentials. Validate relative paths and constrain reads to the configured archive root; consumers must read the referenced commit rather than mutable working-tree contents. An archive controller exposes immutable reads so callers do not shell out to Git or inspect arbitrary filesystem locations.

SQLite and Git do not share a transaction. Use deterministic operation IDs and saved artifact references to recognise a committed result on retry; record completion and pending event together in SQLite after the artifact commit succeeds. A crash after a commit but before state update must not lead to duplicate external effects. This is normal processing correctness, not a disaster-recovery implementation.

## Full-text indexing

The indexer receives a text-ready event, reads the exact retained artifact, validates its contents and writes through the Elasticsearch controller. Use a stable document ID derived from source identity and the deliberate source-version policy; repeated delivery updates the same document rather than adding duplicates. Store publication/post identity, URL, title, dates, text, transcript origin and artifact provenance. A replay command rebuilds derived documents from the archive without refetching media. Define the mapping, one-document controller operation, worker and bounded replay as small deliverables.

## Embeddings and retrieval

Embedding generation is separate from ordinary full-text indexing. Split archived text into deterministic passages, keeping source/version identity, character or paragraph position and available transcript timestamps. An embedding controller calls an externally configured provider; record model, dimensions, chunking version and input hash. Never invent missing timestamps. Model or chunking changes require a deliberate new index version/rebuild; do not mix incompatible vector spaces.

Prefer existing Elasticsearch for vectors if its actual capabilities and selected embedding model are compatible. Validate those capabilities before committing to a vector mapping; do not add another database without a concrete limitation. Retrieval combines keyword and semantic candidates filtered by publication/date, returning passages with provenance. Similarity is a retrieval signal, not proof that claims contradict. Full-text-only retrieval remains usable if embeddings are not configured.

## Claim extraction

Claim extraction consumes source text and returns structured claims, each anchored to an exact passage and source location. Classify factual assertions, opinions, predictions and ambiguous statements; preserve qualifications, people, relevant dates and subjects. Keep extraction separate from truth assessment. Validate model output with Zod and check that quoted passages exist in the input. Save model/prompt and source versions. Missing or unsupported extraction output fails validation rather than becoming a fact.

## Historical comparison

Retrieve earlier passages from the same publication, then analyse them separately. Return repetition, changed framing, possible contradiction or insufficient-context findings, citing both passages and dates. Changes in circumstances or newly available evidence may explain changed wording. Frequency and absence statements are limited to observed corpus coverage. Do not present semantic proximity as contradiction.

## Reusable independent research corpus

Keep research distinct from monitored-source assertions and generated commentary. A research entry includes the question/claims addressed, a supported explanation, underlying sources and relevant passages, publication/retrieval dates, last-checked time, limitations and versioned provenance. Existing generated explanations can seed prose; underlying evidence remains the basis of factual conclusions.

Research first retrieves existing entries, assesses whether they match the actual claim and remain current, then investigates only missing or outdated evidence. Save new evidence and revised explanations for reuse. Reuse assessment must explain applicability and gaps rather than accept a model confidence number. Stable explanations may be reused while incident-specific details receive fresh research. Evidence source selection/freshness thresholds and an external search provider remain implementation choices to establish, not grounds to pretend evidence is verified.

## Evidence selection and drafting

Evidence selection produces a saved versioned brief referencing the exact source, extracted claims, applicable research and any historical comparisons. It sends a metadata event pointing to that brief. Insufficient evidence yields a gap/skip result; do not prompt drafting to make up support.

The writer receives that brief and follows the agreed simple format:

1. Summary of the source post, with its original link.
2. Related conspiratorial themes and supported context.
3. Factual errors and underlying reasoning errors, with citations and material uncertainty.

Detailed editorial voice/style is deferred until drafts can be evaluated. Do not invent historical origins merely to fill a template section.

The writer does not browse or publish. Missing support is reported as an evidence gap. Criticism may be firm but must demonstrate its claims rather than rely on calling the source obviously false. Save the exact draft, citations, model/prompt/template versions and input references in Git.

## Verification and revision

A separate LLM role/prompt reviews the exact draft against its supplied evidence brief; a different model provider is not required. It performs no new research. Combine semantic review with deterministic checks for quotations, reference identity, artifact hashes and schema validity. LLM approval alone cannot establish correctness beyond the evidence supplied.

The verifier returns publish approval, targeted redraft instructions, or a skip. Redraft instructions identify unsupported passages and the required correction/removal; the writer receives the same evidence and feedback. Bound revision attempts with a configurable limit, initially two revisions. After exhaustion or irreparable evidence gaps, save an explicit skip reason. Approval identifies the exact draft artifact/hash and evidence version; any text change invalidates approval.

## Publishing

One small publisher worker receives a trusted verifier event referencing approved Git commit/path and logical archive. Validate message shape, then check and atomically claim the publication through the state controller before reading any article bytes. Already published means return the saved receipt; active ownership means defer; an uncertain earlier attempt means reconcile first. Load the exact approved file through archive controller, send through the Substack adapter, save destination ID/URL and acknowledge after durable outcome/handoff.

Git hashes identify content; trusted event origin grants approval. The publisher does not repeat research or model verification. Keep state transitions, archive reads and vendor API calls in their existing narrow controllers, not separate services. Persist the destination draft ID before the publish call; reconcile an uncertain response against that same draft rather than create another. No public posting is authorised by automated tests, and publishing account setup is deferred beyond the initial milestones.

## Unresolved deployment dependencies

Provider direction is local Whisper first, OpenRouter for text-model access/configurable hosted fallback and Kagi for research search/extraction. Exact model IDs, embedding model/dimensions and live credentials remain configuration to validate; chosen services are not yet proven integrations. Storage and schema work, fake-adapter tests, full-text-only indexing, and supplied-transcript acquisition can proceed without them. Downstream tickets should distinguish an implementable interface from an unproven live integration and retain the existing security and review gates.
