# Extraction-first checkpoint and refined contracts

## Immediate acceptance target

The next owner checkpoint is approximately ten already captured posts with inspectable, clean themes and claims that could be handed to a research agent. Validate one post first, then increase the sample after inspection. Pause on quality defects, fix and revalidate before expanding. Neither research execution, drafting, automatic coordination, nor publishing is required for this checkpoint. One aggregate completion event is the first event integration; finer per-theme/per-claim fan-out is later.

These owner refinements supersede earlier requirements that theme acceptance needs an exact quote, that every extractor label is a canonical corpus identity, or that unclassified assertions are accepted claims. Implementations must version changed contracts and preserve historical artifacts.

## Theme proposals

A post theme proposal has a stable result-local ID, title, optional description, and source post/version provenance. Quotations are not mandatory. Propose broad recognised researchable topics; Wikipedia-style notability is a scope heuristic, not evidence of truth. Do not create a theme for every unusual assertion.

The downstream librarian owns later mapping to existing corpus themes, potentially using embedding proximity to shortlist candidates and semantic comparison to decide. Proposed wording may differ from the canonical title. Preserve original proposals and the mapping so linked claims remain traceable. No embedding implementation or librarian mapping is required for the extraction checkpoint.

## Accepted claims and refinement candidates

Each accepted claim references a specific post/version and its available publication date, at least one extracted theme proposal, an exact quotation with source location or timestamp, and a self-contained summary of the assertion. Speaker attribution is separate from publisher identity; unknown information is never invented. Preserve qualifiers, dates, quantities and negation.

A summary should attempt the best interpretation of the speaker’s intended assertion using whole-post context. Resolve pronouns where possible; qualify uncertain readings and state important assumptions rather than silently treating an inference as explicit speech. Preserve the exact quotation unchanged. Assertions missing a theme, required provenance, exact quotation or any defensible interpretable assertion remain explicit candidates needing refinement, with reasons. Do not index or announce those as accepted claims. The extracted assertion remains separate from any later truth/evidence assessment.

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

The owner authorises contextual interpretation even when it may be wrong: extraction should attempt a useful self-contained summary rather than merely copy unclear wording. The summary must make uncertainty about meaning explicit and must not manufacture unsupported allegations. A prompt-only implementation can express this qualification in the existing statement text; no second model or research stage is required.

## Resolved implementation questions

Extraction never writes canonical catalogue identities. It may read the existing catalogue as optional context. Theme proposals require no quotation field, quotation validation or weaker-evidence flag. Derive result-local proposal identity from source type/publication/post, source-text version, normalised title and, when one result proposes several themes under the same normalised title, a content-derived disambiguator over that proposal's own distinguishing fields. Two distinct proposals therefore keep distinct identities without relying on response order, and re-identifying a saved result stays stable; reference the exact versioned result when linking claims. Response position is not identity, and matching labels across different versions is not proof of semantic equivalence.

Accepted claims and candidates are separate outputs. Only accepted claims enter normalised claim records and, optionally, accepted-occurrence indexing. Use the new-version `statement` as the self-contained summary and keep exact source quotation separately; historical records remain readable without retroactive certification. Questions without assertions remain candidates. Concrete speculative assertions can be accepted only with all other requirements satisfied and uncertainty preserved. No new second-model verification service is required for extraction acceptance.

Use a separate private local source snapshot/content repository for the staged demo. Agent-led source inspection can advance batches; save an owner-readable report rather than waiting for owner approval after every post. Reuse the three existing geoengineering examples and add complete posts covering other themes and repetition. A cheap configurable model fallback is acceptable; production-model selection and investigating every provider failure are not prerequisites. Existing authorised credentials need operational validation, not owner reposting or rotation without evidence of exposure. Indexing is optional; one aggregate NATS completion event after durable extraction is part of the demo. Per-item fan-out and actual research remain later.

## Future boundaries: record now, implement later

The librarian exclusively curates canonical themes, names, splits and dossier organisation. Other services receive read-only access to canonical corpus content. A separate researcher accepts a brief, obtains cited research through a provider, saves an original report in its own artifact area and signals completion; the librarian imports useful results into dossiers. Manually supplied cited research reports are a valid early input, without requiring automated research production.

Retain unthemed/unclear candidates in Git as an awaiting-triage backlog. A future admin interface may assign themes, dismiss a candidate or request another attempt, recording the decision while preserving the original. Assigning a theme alone does not bypass quotation/provenance/meaning validation. This interface is low priority and not part of extraction acceptance.

Keep NATS subjects under the existing `steele.v1` application namespace. Streams collect subject patterns; durable consumers filter the events they need. Do not create a stream per blog, post, theme or claim. Git remains the backlog record even when a triage notification is acknowledged or expires.

Future ingesters may produce blog posts, Telegram posts or other source types through a common content boundary. Target source organization is type / source / item, for example Substack / publication / post. Namespaced identities prevent collisions across ingesters. A configured default author is explicit source metadata and can be overridden by authoritative item metadata; post author and quoted speaker remain distinct. Preserve unknown attribution. Multiple ingesters, storage migration and configured authorship are deferred: do not make them dependencies for the current single-source demo.
