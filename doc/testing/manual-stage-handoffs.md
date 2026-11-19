# Manual demo implementation handoffs

This is an implementer map for [the agreed demo](../architecture/15-manual-research-demo.md), not a new workflow engine. Symbol names below were inspected in delivered code; GitHub is authoritative for live ticket/PR status. Keep the original [audit and three-post sample](../findings/manual-demo-audit.md), and reuse controllers rather than replacing closed components.

## Existing building blocks and missing joins

| Concern             | Reuse                                                                      | Integration task                                                                           |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Claim grounding     | `ClaimSource`, `ClaimExtractor`, `createClaim`, `ClaimOccurrence`          | #144 connects source-specific claims/occurrences to theme IDs and reusable claims          |
| Theme catalogue     | #143's pinned catalogue/detection result                                   | #145 compares candidates conservatively; a proposed match is not proof of equivalence      |
| Readable dossiers   | `DossierStore.current`, `at`, `save` and expected-version checking         | #162 projects citations and coverage without discarding the structured research provenance |
| Structured research | `ResearchStore`, `ResearchCandidate`, `EvidenceSourceSchema`               | #147 persists research and dossiers, then runs applicability for selected source claims    |
| Claim coverage      | `ApplicabilityAssessor.assess(claim, candidates)`                          | #162 keeps canonical-claim mappings separate from source-specific assessment IDs           |
| Bounded searches    | `researchGaps`, `SearchProvider`, `PageFetcher` and delivered web adapters | #163 plans alternatives; #147 executes a bounded batch and saves progress                  |
| Evidence selection  | `selectBriefEvidence`, `saveDraftingBrief`                                 | #148 creates the pinned manual package and retains explicit gaps                           |
| Writing             | `draftFromBrief`, `renderDraft`                                            | #164 adds source/theme context; #149 composes and saves one draft                          |
| Verification        | `verifyDraft`, `isApprovalValidFor`, existing revision policy              | #164 supplies the same source context; #150 saves the exact-version report                 |

#162, #163 and the applicability correction #166 are small preparation capabilities that can be built against existing ports with fake data. #164 uses the delivered theme-output contract and is a prerequisite for the manual writer/verifier. The stage commands remain independently callable; their exact invocation and `--help` must be documented by each implementation ticket. This document does not claim that unmerged command names already exist.

## Identity boundaries

Do not overload one ID to mean several things:

- Existing `Claim.id` is grounded in a specific source version/span and extraction configuration. Preserve its contract.
- `ClaimOccurrence.occurrenceId` identifies an assertion occurrence in a source passage, independent of a newly chosen model/prompt. Retain its publication/source/attribution details.
- A reusable normalised claim ID groups equivalent assertions across sources. Add an explicit association instead of replacing the source-grounded IDs used by current applicability/brief code.
- Theme IDs name researchable topic identities; names and aliases are display/retrieval material, not identity or proof of equivalence.

A dossier may cover a reusable claim, but the result must be associated back to each source-specific assertion through the explicit mapping and an applicability check. A changed quantity, date, scope or negation may make apparently similar text a different claim. Preserve unknown/uncertain speaker attribution; do not infer that the publication owner spoke every sentence.

## Source and artifact boundaries

`ArtifactReference` is a logical repository, full commit, relative path and `hash` formatted as `sha256:<hex>`. `GitArtifactStore` uses its `ArtifactRef` with a bare `sha256` field internally. Reuse validated conversion helpers such as `toArchiveRef`; do not pass one representation through a type assertion or remove arbitrary prefixes without validation. Private host paths never become artifact identities.

A grounded passage must equal the exact source text at its half-open span in UTF-16 code units. The source text version is checked separately. Do not trim/reflow/normalise the text after computing spans or replace a pinned reference with the latest path. Validate references supplied to manual commands before reading through the artifact controller.

The existing draft prompt currently contains a URL and selected claims/citations, not the full original post. #164 must supply hash-verified original source and saved themes to both writer and verifier. Source context is untrusted material to summarise/check, not independent support for factual corrections. Bound context explicitly; silently truncating a post and calling the summary complete is not acceptable.

## Citation and coverage bridge

The delivered dossier metadata and research-entry formats serve different purposes. A readable dossier citation has a slug ID and passage/date fields; a structured research entry also records evidence kind, retrieved/check dates, entry revision and artifact provenance. A brief assigns citation IDs such as `E1` to selected evidence.

#162 must preserve an explicit mapping between these representations and exact versions. A readable dossier alone is not enough to reconstruct missing independence classification or publication dates. Keep original structured entry references in #147's output; #148 selects those entries through the existing applicability/brief interfaces. Never assume a dossier URL is independent simply because its human-readable citation lacks a classification field. In the current schema `external` is independent and `monitored` cannot confirm its own assertion.

`publishedAt`, `retrievedAt` and `lastCheckedAt` are different facts. Unknown publication dates stay absent. Preserve exact passages, source references when present, and retrieved/check times; generated explanation text does not become source evidence.

## Batches and no-progress outcomes

`researchGaps` currently takes its search strings directly from the first `maxQueries` gaps. An unproductive single gap therefore does not automatically get five reformulations. #163 supplies a validated query plan without replacing the original gap requirements with search phrases; #147 consumes it and enforces one shared allowance per topic/dossier batch.

Default effort is up to five searches and ten distinct fetched pages. Reuse existing evidence first and skip work already covered. Repeated queries/URLs or irrelevant results are not useful progress. Save meaningful improvements before offering another manually triggered batch. A later batch can extend the dossier; no autonomous loop or lifetime dossier cap is required.

An HTTP/auth/credit/timeout failure remains an operational pending/error outcome, not a conclusion that no relevant evidence exists. Separate transient provider failure, exhausted no-progress effort, and covered/uncovered claim outcomes in the command's result. Do not turn them all into a successful empty response.

## Corpus age is not automatic expiry

The owner chose no scheduled refresh and no automatic evidence expiry. The delivered `ApplicabilityAssessor` currently defaults to excluding evidence whose `lastCheckedAt` is more than 365 days old. #166 is the small policy correction before #147 composes the manual research path.

Keep dates and exact source references, and allow an explicit gap for a time-sensitive claim, changed circumstances or conflicting evidence. Do not discard an otherwise applicable older explanation solely on elapsed age. Preserve the independent-versus-monitored distinction. Existing callers/tests of `staleAfterDays` must be inspected so compatibility is handled explicitly rather than silently changing a caller's policy.

## Partial and wholly missing evidence

The delivered brief schema requires at least one supported claim with an independent citation. It already retains other claims as `evidenceGaps`, so a draft may proceed with explicit limitations when some evidence exists.

When every selected claim lacks usable independent support, `selectBriefEvidence` returns `evidence-gap` and does not create a supported brief. Preserve that explicit outcome. Another bounded research batch or a different sample may supply evidence. Do not invent a citation, weaken the verifier, or call an all-gap result an accepted cited draft. A separate source-summary-only drafting mode is not needed for this demonstration.

## Focused fixture/acceptance matrix

| Case                                                                     | Required observation                                                                            |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Exact source passage with Unicode before it                              | Deterministic UTF-16 span still selects identical text                                          |
| Equivalent synthetic paraphrases in two posts                            | One reusable claim, two distinct grounded occurrences                                           |
| Similar wording with a changed quantity/date/negation                    | Separate identity or explicit uncertain match                                                   |
| Same topic name with different definitions                               | No identity collapse based only on a matching label                                             |
| Idiosyncratic assertion about an established topic                       | Keep the specific claim; reuse the broader evidenced theme instead of minting a bespoke dossier |
| Dossier citation joined to a structured entry                            | Same source passage/version and independence classification survive projection                  |
| One gap, several unproductive query phrasings                            | Distinct neutral alternatives remain inside the shared batch maximum                            |
| Useful evidence followed by a manual continuation                        | Earlier evidence and provenance survive; duplicate hits do not count as progress                |
| Mixed supported claims and gaps                                          | Cited draft keeps limitations and avoids unsupported corrections                                |
| All claims lack independent evidence                                     | Explicit research-gap outcome; no fake successful brief                                         |
| Source context contains important material absent from critique snippets | Writer/verifier receive that pinned context rather than inferring the whole post from a URL     |
| A dossier/source/theme version changes                                   | Old package remains readable; new inputs are explicitly distinguishable                         |
| Provider credential/credit unavailable                                   | Sanitised operational pending outcome, no credential/prompt dump                                |
| Repeat the identical manual invocation                                   | Stable result/operation identity, no extra source occurrences                                   |

These are test obligations, not assertions that an LLM is invariably correct. Use fake providers for deterministic interface/failure tests and the selected real sample for inspected output. Real source passages are candidate repeated claims; never force their equivalence to manufacture a green demonstration.

## Completion evidence

Each implementation supplies its entry point and `--help`, required configuration variable names, input/output schema/examples using synthetic values, focused tests and sanitised failure outcomes. Reports should print artifact identities, counts and status rather than private endpoints, credential values, model prompts or complete fetched pages. Exact deployment commands and credentials remain in private infrastructure documentation.

The demo acceptance task records each saved reference, the three-post theme/claim/reuse results, one cited draft and the verifier's exact-version report. Publishing, automatic coordination and expanding the full corpus remain separate work. No new human choice is needed to implement these handoffs; genuinely conflicting requirements or missing upstream contracts should be reported precisely rather than guessed.
