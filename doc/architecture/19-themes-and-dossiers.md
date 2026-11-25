# Themes, mappings and research dossiers

This is the agreed target design from the owner discussion, tracked in #528. It describes contracts to implement, not a claim that the current runtime already separates these objects.

A **canonical theme** is an established topic with a stable ID, title and description. It can exist without research. A **dossier** is the versioned collection of research about that theme: documents, sources, supported findings and remaining gaps. The librarian owns canonical themes, mappings and dossier organisation; the researcher produces research material.

Extraction continues to propose themes and source-grounded claims. A proposal is not automatically canonical. The librarian may map differently worded proposals to one theme, or establish a new theme before deciding when to research it. A theme's existence, a dossier's existence and evidence answering a particular claim are three separate facts.

## Mapping and coverage

Reusable mappings target stable theme IDs, not the existence of a research document. Retain assessed wording and meaning/scope, rationale, method and exact versioned provenance. Compatible known mappings can be reused across posts. Identical labels with different meanings must not inherit a mapping blindly. Renames preserve identity; changed scope, splits and merges require explicit reassessment or supersession while old briefs retain their original references.

The librarian checks dossier documents against each claim. Existing research can answer a claim, partly address it or leave it unresolved. A dossier containing material on the general topic does not establish claim coverage. Completed mapping decisions must survive a later research failure.

## Research prioritisation

The theme-only inventory and frequency work in #526 starts by inspecting and reusing compatible saved extraction results. Count distinct posts per canonical topic within an explicit source/version/date scope. Keep unresolved proposal counts separate and report missing or failed extraction coverage. Frequency measures prevalence in the selected material, not truth or scientific importance.

This inventory can rank established but unresearched themes so useful dossiers can be prepared in advance. After that seeding, the target policy is reuse first and at most one new research job per article, selected for the most useful remaining gap. Do not hide extra research in automatic follow-up passes. The writer may omit claims; insufficient evidence can end in a recorded gap rather than automatic additional research. This target does not retroactively change earlier runs or authorise a paid archive backfill.

## Browsing and writer handoff

Themes lists established topics, including unresearched themes, with titles and descriptions. Claims remains its own browser. Dossiers is a separate section for browsing the research collections related to themes; Theme mappings is a permanent indexed collection of proposal-to-canonical-topic decisions. Research coverage can be filtered without defining unresearched topics out of the theme catalogue. Show raw proposals and their mappings separately. Theme details link to actual dossier documents and their saved versions where research exists.

The article trace (#525) explains extracted themes and claims, mapping decisions and reuse, existing evidence, remaining gaps, commissioned research and proposed topics not commissioned. It must distinguish current work from historical failures and stage timestamps from heartbeats.

The writer receives the source post, proposed claims, canonical theme references and exact relevant research documents/passages with coverage limitations. Writing, independent verification of the exact article payload and safe publisher reconciliation retain their existing boundaries. A theme match never substitutes for evidence.

## Compatibility

Preserve existing theme IDs and pinned source, dossier, coverage, brief, review and article references. The current combined dossier metadata and any legacy theme catalogue need one explicit compatible transition, not competing canonical authorities. Historical records remain readable without rewriting approvals or rerunning paid extraction. Git remains the versioned authority; search indices are derived, replayable projections through existing typed controllers.

## Research need and occurrence bindings

New accepted analyses use retained request-plan version 3. A targeted research
need identifies a canonical theme and the validated proposition, assertion kind,
claim type, ordered qualifiers, entities, dates and quoted attribution. Article
bylines, post metadata and extraction record identifiers remain provenance, not
shared need identity. Conservative Unicode and whitespace normalization preserves
case, punctuation, quantities and negation. Missing or context-dependent semantic
fields bind the need to its exact source/analysis occurrence; an accepted contract
version alone does not establish equivalence.

Before dispatch, the librarian saves a separate immutable analysis-to-need binding.
Full seed jobs and targeted enhancements retain exact request, result, manifest,
raw report and occurrence-binding references. Reuse validates that chain and the
archived independent supporting passage, then projects it onto current claim IDs.
Coverage retains the supporting job references so the writer receives the same
archived evidence snapshot. Staged results additionally bind the accepted discovery,
its exact inventory and assembly result, and immutable per-URL retrieval outcomes
and citation snapshots. They retain the original Markdown report rather than
pretending it is the whole-job runner's JSON snapshot. Discovery acceptance is
queried through the state controller before staged evidence can be reused. A grouped ID with conflicting occurrence scopes cannot
select one passage silently.

Existing version 1/2 request plans and their request identities remain immutable.
Compatible legacy full reports can be proved lazily from their exact accepted
analysis and saved request/report/support chain, without rewriting those artifacts.
This read-only lookup has a total per-assessment bound; unavailable, ambiguous or
incomplete proof is recorded explicitly. Bulk legacy association work remains a
separate migration.

For new decisions, titles and saved title aliases select candidates before
secondary description disambiguation. Description similarity alone cannot merge
unrelated titles. Conflicting or ambiguous meanings remain explicit unresolved
proposals with uncommissioned claims; they do not silently create another dossier.
Previously pinned mapping decisions retain their historical interpretation.
