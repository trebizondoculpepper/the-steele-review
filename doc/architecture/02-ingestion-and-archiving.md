# Ingestion and archiving

## Discovery

Maintain a configured list of source publications. Poll each publication's RSS feed to discover recent posts, retaining a checkpoint and stable source IDs. RSS is the first discovery mechanism; it is not assumed to provide a complete historical archive, full paid content, or every audio asset.

Substack documents publication feeds at `/feed`: [official RSS documentation](https://support.substack.com/hc/en-us/articles/360038239391-Is-there-an-RSS-feed-for-my-publication).

Initial discovery collects each post once using stable content identity; explicit edit detection is deferred. Preserve available update dates and content fingerprints for future version handling. Polling defaults to five minutes after each completed run, configurable at runtime; request limits are bounded configuration.

## Source metadata and authorship

Agreed target, tracked in #462: keep a validated source catalogue supplied as a read-only mounted configuration file. Each source has a stable ID, platform/type, display name and optional configured default author identity. The initial adapter can read `sources.json`; existing discovery and collection environment variables remain the implemented configuration until the catalogue integration ships. Actual source configuration stays outside this public repository. Public examples use synthetic values.

Explicit post attribution takes precedence over a source default. When a default is used, record the basis as source-configured, with the source identity and configuration version or fingerprint. This is operator-provided knowledge, not an inference from a publication name. Missing or ambiguous attribution remains unknown; an explicit multiple-author byline must not silently collapse to one default author.

**Known authors as themes (#753).** A source's `defaultAuthor` may also carry owner-configured disambiguation: a short `label`, a `description`, and `excludes` (namesakes this person must not be confused with). The resolution carries this profile when the configured author is used, or when a byline names that same author; other bylines get none. A resolved author is added to the post's theme proposals as an ordinary theme (`origin: "source-author"`). Its title is the name plus the label, so namesakes map to different themes, and its description comes from configuration only. It then goes through the normal catalogue mapping, dossier reuse, research planning (where the research question names the person with that disambiguation) and writer theme context (#748). New research for it shares the article's research allowance. An unknown author adds no theme. Authorship metadata identifies the person; it is never biographical evidence. This replaces the separate author-research design (#470–#472).

A source may explicitly configure `sourceAccountBylines`: observed publication/account labels that do not name a person. Matching uses the whole label (case and whitespace normalized), not text inference. A recognized account label uses the configured person default with `source-configured` basis; the observed account label remains separately recorded. Genuine other-person bylines still take precedence, multiple-person bylines remain ambiguous, and an account without a configured person stays unknown. This alias configuration participates in the registry fingerprint and derived source-context identity.

Post authorship and claim speaker attribution are separate. Author-voice claims can use resolved post authorship under the speaker policy, but a source default must not replace somebody else's explicitly quoted speech. The configured source author also does not determine the byline of this application's response article.

Legacy raw captures remain immutable. An attributed derived record or new analysis revision can reference the original capture and the exact source configuration used; fetching the original page again is not an authorship prerequisite. Attribution inputs belong in derived-result/cache identities. A configuration change requires an explicit new projection or reprocessing operation before it changes historical attribution. #461 consumes this capability for a bounded history pilot; it does not authorise an archive-wide claims backfill.

## Archive before transformation

Preserve retrieved article HTML or feed payload where useful, together with source URL, publication and post identifiers, retrieval time, published and updated times, content hash, and extraction status. For audio and video, retain the transcript and provenance only; do not archive the media. Preserve enough metadata to trace extracted passages back to their source.

Retained text records need durable storage independent of Elasticsearch search documents. Audio and video originals are explicitly excluded from this archive. The initial archive is a private Git repository on a persistent Docker volume; SQLite stores collector state. Record archive references rather than copying large assets into NATS messages.

## Text and audio

Extract readable article text while preserving headings, quotations, links, and paragraph boundaries. Audio ingestion obtains an accessible media asset, then delegates transcription through an interface. Preserve transcript timestamps and the transcription provider/model version where available. Mark uncertain transcription so it cannot silently become a verified direct quotation.

Save extraction version and content hash. Re-extraction can then produce a new derived record without losing the original source.

## Historical imports

Historical backfill is distinct from continuous monitoring. It uses the same archive and extraction pipeline, but must not automatically publish critiques of every imported post. Events carry an ingestion reason, such as `live`, `backfill`, or `reprocess`; policy determines eligibility for publication. Use the historical controller for bounded enumeration; initial coverage is three posts, one at a time. Verify actual access and completeness on the selected sample rather than implying complete historical coverage.

Access failures, unavailable media, and partial content are explicit outcomes. Do not analyse a partial source as though the complete article were available.

## Media retention policy

One shared fetching process accepts work from scheduled discovery and historical backfill. Both paths apply the same media policy: downloaded video and audio are temporary transcription inputs, not retained assets. Prefer obtaining an audio-only representation when possible.

Persist the transcript durably before marking transcription complete or deleting its temporary input. Retain source URL and identifiers, source dates, media fingerprint where available, transcript timestamps, language, provider/model and processing version, and any quality or completeness indicators. Do not retain media bytes in Elasticsearch, the source archive, message payloads, backups, or distributed artifacts.

Use bounded temporary storage and clean up media after successful processing. Failed attempts may retain temporary input only within a configured retry window; expire and clean abandoned files after crashes or exhausted attempts. Reprocessing after deletion requires fetching the source again and may be impossible if it has been removed. Record that limitation rather than claiming the transcript remains independently verifiable against an archived recording.

Transcript text alone cannot establish an exact spoken quotation. Preserve uncertainty and timestamps; if exact wording is material and cannot be verified against an available source, skip that quotation or publication as appropriate.

## Transcript-first acquisition

Before downloading media, the Substack controller checks whether the post exposes an accessible transcript or caption resource. Verify this capability against the selected publication rather than assuming every video or audio post has one.

Acquisition preference:

1. Fetch an existing transcript or captions when available and sufficiently complete.
2. Otherwise obtain an audio-only alternative and transcribe it.
3. Download video temporarily only if neither a usable transcript nor an audio-only input is available.

Record acquisition method, transcript origin (publisher/platform-provided or generated by this application), available timestamps, retrieval time, and completeness/quality indicators. A supplied transcript may contain errors and is not automatically a verified quotation. If supplied text is unusable, fall back to transcription under the same bounded temporary-media policy. Preserve the original supplied transcript alongside any normalised text without inventing missing timestamps.

The discovery proof-of-concept ticket must test transcript/caption and audio-alternative availability on representative historical and recent posts. This is an investigation requirement, not a confirmed Substack API capability.

## Source provenance through writing

The ingestion record preserves the source platform and identity, canonical URL,
observed original medium, and supplied representation. A video post supplied as a
transcript is different from a written post. Keep platform post classifications
separate from media kind: a platform's `podcast` label alone does not prove audio
rather than video. Record observed upload kinds and transcript origin; do not
infer the original medium from conversational wording. Legacy records without
enough evidence retain an explicit unknown medium.

Keep an observed post byline separate from resolved authorship. An explicit
single-author byline takes precedence over the configured source default; record
the resolution basis and configuration identity. A default must not be presented
as an observed byline, assigned to a quoted third party, or confused with the
destination publication's byline. Author identity does not depend on a biography
dossier being available.

Publication time, source update time and capture time are separate facts. Preserve
available offsets and precision; missing dates stay unknown, and capture time
must not substitute for publication time. Media provenance metadata is retained;
the policy excluding retained audio/video bytes is unchanged.

Research and librarian handoffs preserve the exact ingestion/context reference
without needing to interpret the medium. The initial writer, revision writer and
verifier receive the same validated, pinned source context: source, authorship,
original medium, representation and available source dates. Receiving a transcript
does not establish that the writer inspected the recording or documents mentioned
in it. Material context changes participate in affected processing/cache identity;
an old context-free draft does not satisfy this contract.

Acceptance inspects the actual writer and revision requests, not just the stored
record or an intermediate object. The provenance implementation is tracked in
#556; this section records the agreed contract, not deployment completion.

## Deliberate single-item reingestion

Ordinary duplicate discovery remains idempotent. An explicit reingestion request
may also target a successfully collected item. It updates that item's current
ingestion record at the same stable Git path, committing the new data through the
artifact controller with an expected-version check. Git provides version history;
do not create a parallel supersession journal or a sibling document for each
revision. Previously pinned commit/path/hash references continue to read their
original bytes.

Use a stable request identity and recoverable commit-to-event handoff. After the
updated record is durable, trigger initial analysis against that exact version:
theme proposals first, then claim proposals. Keep fetching/transcription and
analysis as separate retryable stages. A provenance-only update must be visible
to affected downstream identities even when the text-derived fingerprint is
unchanged. Existing drafts and approvals stay pinned to their original inputs.

Reingestion is bounded to the selected item, reuses compatible supplied transcripts
where possible, and records unavailable or changed upstream content honestly.
It does not reset unrelated workflows or initiate an archive-wide backfill. This
owner-authorised stable-path revision contract is tracked separately in #558.
