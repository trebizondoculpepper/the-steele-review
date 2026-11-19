# Pipeline module outline

Agreed discussion outline, 2026-11-19. This describes responsibilities and handoffs, not implementation completion or detailed contracts. Automatic coordination remains subsequent work; stages can be triggered manually in the single proof-of-concept system. There is no separate demo/production deployment requirement.

| Module | Responsibility and output |
| --- | --- |
| Discoverer | Poll subscribed feeds and announce each item seen. Repeated discovery is expected. Include enough source identity to fetch it. |
| Fetcher | Reuse already captured content without another downstream announcement. For new content, capture text/transcript and provenance, save it, then announce its immutable artifact reference. |
| Analyser | Extract proposed themes first, then proposed claims associated with those themes. Save validated structured results and announce one completed analysis per post/run. Default to reusing completed analysis; an explicit redo requests a new run without overwriting history. CLI and automatic requests use the same processing path. |
| Librarian | Own canonical themes and dossier organisation. Map proposals to existing themes when substantially equivalent, otherwise request research. Check whether existing research answers each claim and commission additions for gaps. Preserve the original proposals and mapping. |
| Researcher | Accept a research brief, discover and archive cited sources, save the original discovery report, and signal completion. The brief contains a title, a paragraph describing the conspiracy narrative, and optional example claims. Provider/job details remain to be refined. The librarian decides how job artifacts join the canonical corpus. |
| Drafter | Produce one draft using the versioned article template and supplied evidence brief. Begin with a short source summary, identify specific claims and evidence-based responses, then discuss narrative development and wider movement context where supported. An outline stage is not required. |
| Verifier | Read the exact draft and its supplied context/evidence. Reject with specific reasons and comments for redrafting, or approve if supported and any defects are only minor. Minor notes cannot excuse unsupported substantive assertions. Approval identifies the exact draft version. |
| Publisher | Check/claim publication state first, load the approved artifact, publish it, and record the outcome/URL. Reconcile uncertain outcomes before retrying to avoid duplicate posts. Publishing remains outside the current extraction experiment. |

## Shared handoffs

Librarian (#139) and researcher (#210) are separate significant component epics under the programme (#140), each requiring its own detailed design and small estimated implementation tasks. Extraction does not wait for research: its themes and claims are proposals, and the librarian may reinterpret or recategorise them while preserving the originals and source provenance.

The writer selects which proposed claims to include; it need not address every extracted claim. Unthemed candidates remain in a durable awaiting-categorisation backlog, distinct from quotation-validation failures. Existing Git results are inspectable before completion notifications are finished. A browsable UI is optional low-priority work, not a prerequisite.

- Themes need a title and optional description, not quotations. Accepted claims need a source post, at least one proposed theme, a source quotation/location, and a self-contained interpretation. Uncertainty belongs in the interpretation; rejected/unclassified candidates remain inspectable.
- Theme embeddings shortlist possible canonical matches; the librarian decides equivalence. A narrow allegation can map to a broader existing topic rather than creating a new dossier.
- The librarian's writing brief adds relevant research document/passage pointers to the existing post, themes and claims. It records coverage and limitations. Earlier agreement allows explicitly limited drafts; missing evidence must not become an invented rebuttal.
- Git holds versioned sources, proposals, claims, reports, dossiers, briefs, drafts and reviews. Save meaningful results before announcing them. NATS messages carry minimal context and exact artifact pointers; SQLite operational state/outbox stays behind its typed controller. Elasticsearch is a searchable projection.
- One aggregate analysis-completed event comes first; per-theme/per-claim fan-out is later. Durable save/dispatch retries must preserve event identity.

## Librarian and researcher design

The [librarian epic](https://github.com/trebizondoculpepper/the-steele-review/issues/139) and [researcher epic](https://github.com/trebizondoculpepper/the-steele-review/issues/210) use the existing TypeScript runtime and event-driven pipeline. The design fits the current stack.

### Librarian workflow

1. Start with the archived post and its proposed themes and claims. Search the index using embeddings to shortlist matching themes and research. Assess the actual documents for relevance and commission background research for gaps worth filling.
2. Once the theme material is available, assess relevant claims individually. Background coverage can be sufficient for the theme while leaving a particular claim open. Include every accepted claim in the research handoff. Reuse corpus material wherever it answers the question, and commission focused follow-ups where the result could change the article.
3. Persist coverage decisions and pending research job IDs so the librarian can resume when results arrive or after a restart. Reassess affected claims by reading the archived documents directly from the dossier as soon as the saved result is available. Index the documents independently so future dossiers can discover them.
4. When the material is ready, save the dossier and covering brief and signal the writer with their versioned references. Include the original post and the documents or passages the brief relies on so the writer can complete the draft from the package.

The brief maps themes and claims to the relevant documents and explains what each source establishes. It identifies strong evidence, background, and media coverage. A claimant’s post is primary evidence of what they said. Reposts that trace back to it share the same origin for attribution. The brief distinguishes claims with independent evidence, claims for which a documented search found no independent evidence, and claims for which no further research was commissioned. A dossier can be ready with any of these outcomes. Where the search found nothing relevant, record its scope and any leads followed so the writer can describe the limits accurately.

### Researcher workflow

Use Perplexity Sonar Deep Research through the OpenRouter API as the initial discovery approach. Save the original report as a discovery artifact. Extract its cited URLs, attempt to retrieve each source, and preserve the original content wherever retrievable. Check whether the retrieved passages support the findings and mark the relevant passages. Record citations whose sources could not be retrieved or whose support could not be validated. Record provenance, retrieval outcome, source type, and a confidence assessment with a short rationale as each item is saved. Keep source type and confidence distinct, and record any uncertainty in classification. Retain unavailable URLs and their retrieval outcomes in the dossier.

The dossier can include primary records, research syntheses, media coverage, and background material. The discovery report can help explain how sources were found. The writer’s brief should point to the archived material for the evidence behind its claims. The archived documents and metadata feed the search index through the existing indexing path. Save the dossier before sending a completion event carrying the job ID and exact dossier version. Report the job as complete with gaps when some sources could not be retrieved or validated, and return the usable material. The librarian decides whether a missing source warrants another attempt and can commission one if it becomes important.

If Sonar errors or times out before returning a report, record the failure and notify the librarian immediately, without an automatic retry. The librarian continues with the material already in the dossier and records the gap in the writer’s brief.

### Research request and writer handoff

Include every accepted, source-grounded claim in the research handoff, with its saved claim reference, transcript passage and location, and proposed themes. Each request identifies the evidence question or gap and points to relevant material already in the corpus. The researcher can group related claims into shared searches. Keep each claim linked to the resulting evidence so the librarian can assess it individually.

The researcher returns the job ID and versioned dossier reference. The dossier includes a short covering note based on the deep-research findings and source checks, the original discovery report, archived primary sources with supporting passages marked, and retrieval and validation outcomes. The librarian sends the writer the source post, the full claim list, the relevant archived documents, and a covering brief. The brief says what each source establishes for each claim and where the evidence remains incomplete. The writer selects which claims to cover using the supplied material.

#### Example from the extraction demo

The post [Blocking out the sun and the sinister…](https://saveusnow.substack.com/p/blocking-out-the-sun-and-the-sinister) includes one claim that a treaty prohibits hostile environmental modification and another alleging that a payment of 56 million funded an attack on civilians in breach of a treaty.

One research request can include both claim references and ask which treaty applies, what it prohibits, and whether primary records document the alleged payment and its purpose. The researcher would archive the ENMOD Convention and identify Article I for the writer. The librarian would record that Article I supports the general treaty claim within its scope. It applies to military or other hostile use with widespread, long-lasting, or severe effects as a means of harming another state party. The alleged payment and breach need their own evidence assessment, including records of the payment and what it funded. [ICRC summary of Article I](https://www.icrc.org/sites/default/files/2026-05/1976-ENMOD-ICRC-factsheet.pdf)

### Research stopping rule

Default to one Sonar pass followed by source retrieval and validation. The librarian can commission a targeted second search if a remaining gap could materially change the article. Otherwise, hand the dossier to the writer promptly and record any unresolved gaps in the covering brief.

### Implementation defaults

- Use typed, versioned contracts and the existing TypeScript provider, artifact, state and NATS boundaries. One request carries the exact post and analysis references, accepted claim references and their theme links, the research question, and relevant corpus references. Derive a stable job identity from the input versions and research pass so redelivery reuses the job. A targeted second pass has a distinct job identity linked to the first.
- The researcher writes immutable job artifacts and a manifest. The librarian owns canonical dossier revisions and assembles the writer package. Record each citation URL, retrieval status, archived artifact reference where available, source type, confidence rationale and claim-specific passage references.
- Use terminal outcomes of complete, complete with gaps, and failed. Persist the outcome and pending event through the state-controller outbox before acknowledging work. A result event identifies the job, outcome and exact manifest version if available. Delivery retries reuse the event identity and do not schedule another Sonar call. After an interrupted or uncertain provider call with no recoverable result, record failure and continue from available evidence.
- Bound provider calls and source retrieval with configurable deadlines. Fetch public HTTP(S) sources through the retrieval adapter with bounded redirects and response sizes. Treat report and source content as untrusted. The index can update independently of the librarian’s coverage check.

### Implementation slices

1. Define and validate the request, result, and manifest contracts under #210. Implement the bounded Sonar call through the OpenRouter adapter, then source retrieval, preservation and passage checks.
2. Wire durable job completion and failure through the outbox. Exercise partial results, provider failures, and duplicate delivery.
3. Under #139, connect saved extraction to corpus lookup, grouped research requests, and per-claim reassessment. Save the writer package and announce readiness. Demonstrate a real post with related claims sharing a source and with at least one gap reported explicitly.

## Other follow-up design

Refine extraction redo identity, durable consumer configuration, bounded redraft behaviour and publication reconciliation separately. Multi-source ingestion and human-triage UI remain later work.

## Ticket questions checked

- **#139:** today's discussion resolves ownership: librarian maps themes, writes canonical dossiers and judges coverage; researcher produces reports. Existing imported reports remain valid inputs. Older combined-role wording needs a separate alignment pass.
- **#178:** an explicit announcement command is agreed. Use the single POC's configured broker and state-controller outbox, not separate experiment infrastructure. A shared typed registry defines streams, purposes, subject patterns and message schemas; see [events and reliability](05-events-and-reliability.md). Exact completion-subject stream assignment remains a technical follow-up; a stream matching only `steele.v1.content.*` would not capture `steele.v1.post.analysed`.
- **#184:** claim extraction does not depend on research being ready. Quote-quality improvements are deferred; preserve rejection counts and limitations. Artifacts can be inspected before messaging is ready, while event acceptance remains tracked separately.
- **#140:** retain the programme as an umbrella; extraction is the immediate checkpoint. Research, evidence packaging and drafting remain downstream, with the librarian/researcher boundary reflected before implementation. Manual research is a prototype input, not a mandatory ordering constraint before claim extraction.
