# Storage and retrieval

## Responsibilities

Use the existing Elasticsearch service for searchable source text, extracted claims and themes, historical retrieval, and analysis records. Use a durable archive for retained source text and transcripts. Do not retain audio or video originals; media is temporary transcription input. Workflow state needs durable conditional updates; its backend must be selected separately rather than assumed to be provided by search indexing.

The official Node client, `@elastic/elasticsearch`, includes TypeScript support. Select its version against the actual server version: [Elastic TypeScript documentation](https://www.elastic.co/docs/reference/elasticsearch/clients/javascript/typescript).

## Proposed record types

| Record            | Important fields                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Source post       | Publication ID, post ID, canonical URL, title, publication time                          |
| Source version    | Source key, version hash, retrieval time, original references, completeness              |
| Extracted content | Source version, extractor version, text, paragraph IDs, transcript timestamps            |
| Claim             | Exact source passage, normalised claim, entities, relevant dates, source version         |
| Analysis          | Claims, themes, historical matches, evidence references, model and prompt versions       |
| Article           | Source versions, draft versions, verification results, destination ID, publication state |

Exact Elasticsearch indices and mappings are not yet selected. Use stable logical IDs and explicit schema versions; avoid coupling event consumers to an index layout.

## Historical questions

Retrieval should support:

- How often has this publication discussed a topic, and over what observed period?
- Is it returning to a topic after an absence in the indexed material?
- Has the framing or a specific factual assertion changed?
- Does a new statement conflict with an earlier statement about the same subject and time?

Start with publication, date, entity, and text filters. Semantic retrieval is optional and requires a later decision about embeddings and server capabilities. Broad similarity alone is not evidence of contradiction.

Every historical comparison retains both passages, URLs, dates, and source versions. Distinguish an actual contradiction from a changed prediction, newly available evidence, or different circumstances. Frequency statements describe the indexed corpus and must acknowledge gaps in historical coverage.

## Independent evidence

Keep monitored-source material distinguishable from independently researched evidence. Store evidence URLs, retrieval times, relevant passages, and the claims they support or contradict. A source repeating an assertion is evidence that it made the assertion, not independent confirmation that the assertion is true.
