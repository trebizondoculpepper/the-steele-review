# Observed claim-family period data

`projectCorpusPeriods` in `src/analysis/corpus-periods.ts` is a library operation
for #403; it does not schedule extraction, backfill, make model calls or assert
that a trend exists. #404 consumes its saved descriptive output.

Prepare a private Git manifest matching `CorpusPeriodManifestSchema`. Supply:

- A named claim family with explicit occurrence grouping keys. The caller
  chooses membership, including known equivalent wordings; the projector does
  not perform semantic matching or discover a conspiracy category.
- The declared publication scope and whether the supplied sample is complete.
- UTC start/end months (`YYYY-MM`, end exclusive), at most 120 months.
- At most 500 post entries, each identifying one selected capture revision and
  optionally a completed extraction reference. Include known posts lacking
  extraction so coverage gaps are visible. Reference zero-claim successful
  extractions too. Conflicting revisions for one post are rejected rather than
  choosing an arbitrary winner.
- An exact-copy policy: `include` by default, or explicitly
  `exclude-identical-source`. Equality means identical complete source text
  within a publication, not a model's guess that two claims are equivalent.

Pass the manifest's exact artifact reference and the existing archive/content
controllers to `projectCorpusPeriods({ manifest, archive, content })`. The
operation reads the pinned captures and extraction results, verifies identity
and occurrence grounding, and writes a deterministic `corpus-periods/<hash>.json`
artifact. The returned `{ ref, result }` identifies the saved projection.
An identical rerun reuses the immutable output. This operation currently reads
the existing Substack collection record format; new capture formats require an
explicit adapter rather than invented metadata.

Each month reports archived posts, validated analysed posts, posts matching the
family, distinct occurrences, and the subset labelled quotations. Missing or
invalid extractions, candidate/rejection counts, exact text copies and their
optional exclusion remain visible. Unknown dates and unavailable/invalid
sources are reported separately, not assigned to a fabricated month. Periods
without matching observations are present, but zero is not a claim about
uncollected material. When the manifest declares a partial sample, `truncated`
is true; the projector cannot independently verify the sampling frame.

For example, one matching post among two analysed posts in January and two
among four in February describes the same observed per-post rate despite a
higher raw count. Two separate matching passages in one post contribute two
occurrences and only one matched post. A completed zero-claim extraction
contributes to the analysed-post denominator; an archived post with no completed
extraction does not. Known candidates and rejections qualify the completeness
of accepted-claim counts and must travel with any subsequent assessment.

Keep manifests, source-derived outputs and exact references in the private
corpus. Public fixtures are synthetic. All artifact reads/writes go through the
typed artifact controller; no new index, SQLite access or Git subprocess is
introduced. No provider or deployment credentials are required.
