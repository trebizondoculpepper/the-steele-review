# Manually triggered research and drafting demo

This is the agreed initial demonstration, tracked by mega-epic #[140](https://github.com/trebizondoculpepper/the-steele-review/issues/140). It groups three mini-epics: [source understanding](https://github.com/trebizondoculpepper/the-steele-review/issues/138), [research dossiers](https://github.com/trebizondoculpepper/the-steele-review/issues/139), and [manual drafting and verification](https://github.com/trebizondoculpepper/the-steele-review/issues/141). Automatic coordination belongs in a subsequent epic.

## Input and outcome

Use three already captured, complete source posts that share a theme and preferably repeat a claim. Read their exact Git artifact versions and retain source links, publication dates, speaker attribution and transcript timestamps where supplied. The demonstration does not depend on the remaining transcription backlog.

The outcome is inspectable source analysis, reusable cited research, one pinned evidence package, and one readable cited draft with a verification report. Manual commands invoke the normal stage/controller interfaces. There is no automatic dependency engine, scheduled research refresh, publisher or new user interface in this demo.

## Themes and claims

Theme extraction receives the post and a catalogue of known stable theme IDs, names, definitions and aliases. It returns validated JSON listing every detected existing theme with supporting passages and any proposed new themes with definitions and evidence. It may return no theme. A post having no new themes still returns its relevant existing themes.

Candidate retrieval narrows possible theme/claim matches; a model then compares their actual meanings. Reuse an existing identity only where supported. If uncertain, keep separate records. Similarity or a shared theme does not establish truth, contradiction or equivalence. Dates, quantities, negation and qualifiers must survive comparison. Bound the candidate catalogue sent to the model rather than assuming the entire corpus always fits.

Extract specific assertions after themes and link each claim to one or more applicable theme IDs. Explicitly retain an unclassified outcome instead of forcing a link. Keep a normalised reusable claim separate from each occurrence: exact wording, asserted speaker, source post, dates and passage/timestamp. Distinguish assertions from quotations, questions and speculation. Stable occurrence IDs prevent repeated processing from inflating timelines and counts.

Persist results before emitting events. New-theme identities and research requests must be deduplicated. Events may be produced by individual stages, but no automatic downstream pipeline is enabled for the demonstration.

## Content repository

The content repository is private and separate from the public application code:

```text
dossier/<stable-theme-id>.md
claims/<stable-claim-id>.json
articles/<stable-article-id>.md
```

Dossiers contain readable research with validated metadata: theme identity/scope, claim coverage, supporting citations/passages, source dates, checked-at dates and unresolved gaps. Structured claim records retain reusable identities and evidence links; occurrence records retain their source-specific details. Elasticsearch is the derived query/retrieval projection, not a second editable source of truth.

Dossiers evolve through one writer and an expected-prior-revision check behind the typed Git controller. Preserve the existing immutable API for captured sources and saved evidence references. Add a narrow revision capability rather than scattering Git commands or weakening every artifact's immutability. Reads pinned to an earlier commit/path/hash remain valid after updates. Models, media, databases and credentials do not belong in content Git.

## Research and readiness

For each theme, reuse the existing dossier or create a bounded research request for a genuinely new theme. Then assess each specific claim against the available research. Return covered with cited evidence, or gap with a short reason. A dossier existing is not proof that every claim about its theme is answered.

Use existing research first, and Kagi/source-fetch adapters only to investigate missing evidence or a warranted freshness question. Keep independent evidence separate from the monitored assertions and earlier generated prose. Use conservative configurable search/page limits and configured cheap models; credential exhaustion leaves work pending. No scheduled refresh or automatic expiry is required.

Unresolved claims may proceed to drafting with explicit limitations. They must not become unsupported factual corrections. Research completion and claim coverage are separate facts.

## Evidence, drafting and verification

A manual evidence-selection command saves exact versions of the original post, summary, themes, selected claims and relevant research passages, with a covered/gap outcome for each selected claim. Repeated invocation over identical input reuses its stable result; a later dossier revision cannot silently change that package.

A manual drafting command follows a versioned template: link to the original and fair summary, relevant conspiratorial themes, then specific factual and reasoning errors with supporting citations. The writer does not browse or publish. Save the draft and model/prompt/template versions with its evidence-package reference.

A separate verification prompt checks that exact draft against its pinned source and evidence, without new research. It checks quotations, attribution, citation support and uncertainty. Return supported, specific redraft instructions, or unresolved after bounded attempts. Changed draft text invalidates earlier approval. Unresolved verification does not count as an accepted final draft, and no live publisher consumes these outputs.

## Acceptance

Inspect all three posts and their grounded analysis, demonstrate a recurring theme, validated equivalent-claim match, research reuse and an explicit gap. If the selected real posts lack a repeated claim or natural gap, report that and use a clearly labelled synthetic fixture to prove the mechanism; never invent assertions attributed to a real source.

Produce one cited draft with an acceptable verification result. Demonstrate that old cited dossier versions remain readable and reruns do not duplicate occurrences or lose provenance. Record counts, model/prompt versions, returned usage/cost and observed defects. Stop expansion on extraction, attribution, duplicate or unsupported-citation defects. This proves the workflow on the sample, not general correctness of all model judgements.

## Small delivery tasks

| Ticket                                                                      | Work                                            | Size |
| --------------------------------------------------------------------------- | ----------------------------------------------- | ---- |
| #[142](https://github.com/trebizondoculpepper/the-steele-review/issues/142) | Audit existing contracts and select the sample  | S    |
| #[143](https://github.com/trebizondoculpepper/the-steele-review/issues/143) | Known/new theme extraction integration          | M    |
| #[144](https://github.com/trebizondoculpepper/the-steele-review/issues/144) | Grounded claims and theme links                 | M    |
| #[145](https://github.com/trebizondoculpepper/the-steele-review/issues/145) | Equivalent-claim reuse and distinct occurrences | M    |
| #[146](https://github.com/trebizondoculpepper/the-steele-review/issues/146) | Controlled Git dossier revisions                | M    |
| #[147](https://github.com/trebizondoculpepper/the-steele-review/issues/147) | Manual research, reuse and claim coverage       | M    |
| #[148](https://github.com/trebizondoculpepper/the-steele-review/issues/148) | Pinned evidence package with explicit gaps      | S    |
| #[149](https://github.com/trebizondoculpepper/the-steele-review/issues/149) | Manual cited drafting                           | S    |
| #[150](https://github.com/trebizondoculpepper/the-steele-review/issues/150) | Manual verification and bounded revisions       | S    |
| #[151](https://github.com/trebizondoculpepper/the-steele-review/issues/151) | End-to-end acceptance evidence                  | M    |

These estimates assume reuse of delivered controllers and schemas. The parent XL estimate is an aggregate programme roll-up, not an unsplit implementation job. The audit identifies actual missing capabilities; new large work must be split into separately estimated S/M tickets. Native issue dependencies specify sequencing and allow dossier work to proceed alongside extraction after the audit.

Actual deployment locations, credentials and operational logs remain exclusively in private infrastructure documentation. Application and test code stays TypeScript; Git and SQLite retain their controller boundaries.
