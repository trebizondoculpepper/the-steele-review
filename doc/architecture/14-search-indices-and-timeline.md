# Search indices and claim timelines

Use four logical index families, introducing each only as its functionality is needed. These are public logical names; deployment aliases, actual endpoints and credentials are private configuration.

| Family               | Documents                                                                                                       | Purpose                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Source content       | One searchable retained post with text, source dates, author if supplied, URL and immutable artifact provenance | Content capture and full-text retrieval           |
| Claim occurrences    | One grounded claim occurrence in a specific source passage/version, with attribution and date provenance        | Observed timelines, frequency and claim retrieval |
| Independent research | Reusable explanations with underlying evidence, citations, topic/claim associations and checked dates           | Corpus-first research and drafting evidence       |
| Passages             | Deterministic source/research text chunks, provenance and optional compatible vectors                           | Keyword/semantic candidate retrieval              |

The existing full-text mapping uses `steele-source-text-v1`; introduce other mappings explicitly rather than assuming these names already exist. Themes start as fields/associations, not a separate index. Timeline is a query over claim occurrences, not another authoritative store. Workflow state remains private SQLite, not a fifth Elasticsearch claim authority. Git is the text artifact source of truth; Elasticsearch records are derived and replayable.

## Occurrences versus grouped claims

An occurrence identifies who asserted a statement in an exact source passage. A normalised claim/topic key can connect related occurrences, but grouping is revisable: paraphrases, negation, predictions and changed circumstances must not be collapsed blindly. Stable occurrence IDs stop retries and repeated backfill inflating counts. Indexing a source's assertion is not certifying it true.

Store post author/publisher separately from attributed speaker. A quoted person may be the speaker, and uncertainty must remain explicit. Use source publication time for the observed publication timeline, an evidenced assertion time only when actually supplied, and extraction time separately. Missing dates remain missing. Counts report their unit (occurrences or distinct posts) and the collected corpus coverage; do not claim frequency across material that was never collected.

## Embedding compatibility and evidence

Generate embeddings outside Elasticsearch through the embedding controller. Store model identifier, dimensions, splitter version and input/source hash alongside passages. Use the same compatible model for query vectors; matching dimensions alone does not make models interchangeable. Model or splitter changes require a deliberate derived-index rebuild, not silent mixing.

Embeddings shortlist relevant or potentially contradictory passages; they are not truth scores or logical negation. The writer reads the actual candidate passages and citations and explains support, contradiction, qualifications or insufficient evidence. The verifier checks the resulting prose against those same sources. A separate contradiction-classifier service is not required for the initial approach. Keep research evidence distinguishable from monitored-source assertions in all retrieval results.

Technical experiments and licensing/migration investigations belong in [doc/research](../research/README.md). No paid Elastic inference feature is required for externally generated dense-vector storage/search; verify any optional ranking or built-in model feature separately.
