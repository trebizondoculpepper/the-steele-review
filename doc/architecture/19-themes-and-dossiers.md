# Themes, mappings and research dossiers

This is the agreed target design from the owner discussion, tracked in #528. It describes contracts to implement, not a claim that the current runtime already separates these objects.

A **canonical theme** is an established topic with a stable ID, title and description. It can exist without research. A **dossier** is the versioned collection of research about that theme: documents, sources, supported findings and remaining gaps. The librarian owns canonical themes, mappings and dossier organisation; the researcher produces research material.

Extraction continues to propose themes and source-grounded claims. A proposal is not automatically canonical. The librarian may map differently worded proposals to one theme, or establish a new theme before deciding when to research it. A theme's existence, a dossier's existence and evidence answering a particular claim are three separate facts.

## Target model for ideas and claims

- **Underlying idea** is the proposition that persists across retellings, such as “New communications technology harms people.”
- **Idea** is a specific version of that proposition, such as “4G harms people” or “5G harms people.” It retains details that change what evidence would answer it.
- **Claim** is a documented instance of someone expressing an idea. It retains the exact passage, known speaker, date when available, and pinned source revision.

A theme groups material by topic, such as mobile networks or public health. An underlying idea captures what the accounts assert in common. A theme can contain several underlying ideas, and an underlying idea can appear across themes. Themes and their dossiers help the librarian find candidates. The librarian establishes an idea link from the meaning of the passages and records the basis for it. Evidence for a specific idea stays tied to the proposition it addresses.

### First implementation

1. Reuse existing extraction and pinned occurrence records. In the current schema, the claim record is the starting point for an **idea**, and the occurrence record is the starting point for a **claim** in the target vocabulary.
2. Curate one underlying idea with a stable ID and link two documented ideas to it. Save the rationale and exact source references. Start with one documented 4G example and one documented 5G example if both are available.
3. Have the librarian retrieve linked claims and pass dated passages and a short comparison to the writer through the existing history handoff. If a link is uncertain, preserve that uncertainty and leave the comparison out of the draft until it is supported.
4. Verify that one essay can explain what repeated and what changed with citations. Then test automated mapping as a separate corpus workflow.

The first slice adds versioned links and a read path for the comparison. Existing record IDs remain valid. Automated mapping and archive backfill can follow once the curated example establishes what a useful match looks like.

### Proposed corpus workflow

Run corpus organisation independently of new-article production. The librarian in the article workflow reads the latest accepted catalogue when it prepares a writer package. If there is no supported match, the article proceeds with its available context. Each writer package pins the references it used so a later catalogue change cannot alter an earlier article's evidence.

1. **Read changed claims.** A scheduled or explicitly requested Restate run reads saved extraction records since its last durable checkpoint. Start with a bounded set of archived articles. Use existing claim and source IDs and retain the exact passage and attribution.
2. **Map claims to ideas.** Identify the specific proposition expressed by each claim. Look for existing ideas before proposing a new one. Treat a publication date or speaker as occurrence metadata. Keep date, actor or mechanism in the idea when changing it changes the proposition.
3. **Link ideas to underlying ideas.** Retrieve candidates from the existing catalogue using themes and, when available, similarity search. Search across themes where the proposition warrants it. Save a proposed link and a short explanation of what carries over and what differs. Leave unclear matches pending. Start with curated acceptance and use those decisions to validate later automation.
4. **Save and index accepted links.** Store versioned claims-to-ideas and ideas-to-underlying-ideas links with provenance in the artifact store. Build a derived search projection through existing controllers. Advance the checkpoint after durable completion so an interrupted run can resume without duplicating links or losing work.
5. **Build timelines and comparisons.** Return dated passages grouped by idea and underlying idea, with their sources and a short explanation of the relationship. Add trend summaries only after duplicate handling and archive coverage are measurable.

### First model experiment

Use one batch of saved claim occurrences. First, check coverage and retain each eligible claim's stable ID and pinned source passage. Then make one model request to group claims expressing the same specific idea. Validate each proposed group against the supplied claim IDs. Save accepted groups and record ambiguous, omitted and invalid items. Finally, make one separate request to group the accepted ideas under underlying ideas. Preserve the distinctions between the specific ideas and record the basis for each accepted link.

Size the batch to the model's context limit with room for the prompt and structured output. Use a reproducible selection and record which claims were included or deferred. Give each model request its own named Restate step. Review how many links were accepted, which groups conflated different propositions, and whether the resulting comparison is usable. Use those results to decide whether smaller batches and cross-batch reconciliation are needed.

### Restate entry point and first integration test

Bind a new `CorpusRefinement` workflow handler to the existing TypeScript worker's Restate SDK endpoint. At deployment, register the endpoint with Restate so the server discovers the handler from the SDK manifest. Start the workflow through Restate ingress with a stable run ID and a bounded batch. An operator can trigger the first version manually. A schedule can later use the same entry point.

The workflow has three named, ordered steps: check claim coverage, map claims to ideas, and map ideas to underlying ideas. These steps appear in the invocation journal. They run inside the workflow handler and need no separate registration.

Start with a real Restate server and inject deterministic TypeScript stubs for all three stages. Each stub returns a synthetic result that the next stage checks, proving order and handoff. In a second test, fail the middle stage once and confirm that Restate reuses the first result, retries the middle stage, and proceeds to the final stage after recovery. Use synthetic data and avoid model calls and live archive writes in both tests.

### Stage artifacts and handoff

Use the stable refinement run ID and stage name as the identity of each stage result. Derive its path from those validated identifiers, for example `corpus-refinement/<run-id>/map-claims-to-ideas.json`. Each stage saves its result through `GitArtifactStore` and hands the next stage an exact artifact reference containing the repository, path, commit, and content hash.

Record the producing stage, schema version, and pinned input references with each result. If the worker restarts after saving but before Restate records the handoff, the retry finds the result at the same path, validates its identity and inputs, and reuses it. A mismatch requires recovery before handoff. An intentional rerun gets a new run ID, so earlier results remain traceable.

### Reusable model steps

Use a shared TypeScript function for the two model-backed mapping stages. Each stage supplies four typed operations:

- **Prepare** assembles the request from pinned inputs and a versioned prompt. Record the prompt identity, model and input references.
- **Call** uses the existing provider adapter. Give each outbound request a stable, named Restate step. A recorded response is reused on replay, including when subsequent validation fails.
- **Structure** converts the response into candidate records. Parse JSON directly when the response already has the expected shape. If a task benefits from a prose-first response, an optional formatter can extract the proposals into the target schema. Any formatter model call gets its own named Restate step. Preserve source references and leave unsupported fields empty.
- **Validate** checks the schema and evaluates each proposed link against the pinned inputs. Check that references resolve and quoted text matches the source. Return a typed outcome with accepted records, issues, or both.

The workflow decides what to do with validation issues. It can save accepted links and continue with recorded gaps, or schedule an explicit, bounded repair for a known repairable issue. Each model-backed repair gets its own named Restate step. Retry technical failures such as a failed save using the recorded response.

Use the same workflow contracts with deterministic fixtures in the first integration test. Validate the pattern with both mapping stages before applying it to other workflows.

### Experimental TypeScript layout

Keep Corpus Refinement in the existing application package, with one feature directory organised by responsibility. For this experiment, prompt Markdown can live in the feature's `prompts/` directory. This is the owner-approved exception to the shared prompt location.

```text
src/corpus-refinement/
  workflow.ts
  contracts.ts
  model-step.ts
  steps/
    check-claim-coverage.ts
    map-claims-to-ideas.ts
    map-ideas-to-underlying-ideas.ts
  prompts/
    map-claims-to-ideas.md
    map-ideas-to-underlying-ideas.md
```

The workflow wires the stages together and owns recovery decisions. Shared contracts define the schemas for saved artifacts and data exchanged between stages. Keep checks specific to one model response beside that stage. The shared model-stage function composes preparation, the durable model call, structured extraction and validation through typed functions supplied by the stage. Stage classes can compose those functions through their constructors. Keep configuration in typed TypeScript defaults for the prototype.

Check the layout in the built application image. It must compile stage code, package the Markdown and record the exact prompt identity used. Use both mapping stages to evaluate how easy it is to find and change a prompt, whether imports stay clear, and whether the shared contracts prevent duplication. The layout is an experiment for Corpus Refinement.

### Technical challenges

- **Distinguishing themes and ideas.** “Mobile networks” is a topic. “A new mobile network is secretly making people ill” asserts something. Theme membership and similarity scores can locate candidates. Evaluate the proposed link against the actual propositions and excerpts.
- **Preserving meaning and attribution.** A shared idea can recur across speakers and technologies. Preserve differences in cause, effect, negation and scope. Record that two accounts are similar when the passages support it. A claim of influence or coordination needs its own evidence.
- **Managing churn.** New examples may reveal that an underlying idea is too broad. Record splits, merges and supersessions as new versions so prior citations and writer packages remain inspectable.
- **Keeping trends interpretable.** Distinguish reposts from new claims, count distinct sources where relevant, and report archive coverage and extraction gaps by period. A rise in captured examples can reflect a change in collection.
- **Controlling work as the archive grows.** Process changes incrementally, support a bounded backfill, and reuse saved decisions on retry. If mapping calls a model, expose each request as a named Restate step and retain the decision's provenance. The article path remains available while the corpus catalogue catches up.

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
