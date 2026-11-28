# Affordable embeddings for Git-backed collections

Research proposal for #948. **Research only.** No paid calls were made, nothing was deployed, and collection indexing (#942) does not depend on this. Facts marked *verified* were checked on 2026-11-28 against the primary sources linked below. Numbers marked *estimate* are derived from those facts and a small sample, not measured. This builds on [embedding-retrieval-and-explanation.md](embedding-retrieval-and-explanation.md), which covers the separate question of retrieval quality.

## Recommendation

Use **application-managed embeddings**:
- **Generation:** the collection indexer (#942) calls OpenRouter's embeddings API and stores the vectors in an Elasticsearch `dense_vector` field.
- **Default model:** `openai/text-embedding-3-small`, at 1536 dimensions with `cosine` similarity.
- **Alternative:** `baai/bge-m3` (1024 dimensions, MIT-licensed open weights, half the price) if portability or cost matters more than staying with a mainstream proprietary model.
- **Not recommended:** do not use Elasticsearch-managed inference (`semantic_text`). On a Basic licence it cannot call a third-party provider (see the comparison below).

## What a collection declares

Embedding is opt-in per collection, in the same `collection.json` that already declares the mapping and its version:

```json
{
  "mappingVersion": 3,
  "mapping": { "dynamic": "strict", "properties": { "utterance": { "type": "text" }, "speakerId": { "type": "keyword" } } },
  "embeddings": {
    "version": 1,
    "model": "openai/text-embedding-3-small",
    "dimensions": 1536,
    "similarity": "cosine",
    "fields": [ { "name": "utterance_vector", "text": ["utterance"] } ]
  }
}
```

Two examples:
- **Claims collection:** `fields: [{ "name": "utterance_vector", "text": ["utterance"] }]`.
- **Themes collection:** `fields: [{ "name": "theme_vector", "text": ["title", "description"], "separator": "\n\n" }]`.

How the indexer handles the declaration:
- **Mapping:** it adds each vector field to the mapping as `dense_vector` with the declared `dims` and `similarity`.
- **Text:** it builds the text to embed from the named fields, in order, after normalisation (Unicode NFC, trimmed, internal whitespace collapsed).
- **Validation:** an `embeddings` block that names a missing field or an unsupported dimension count is an `invalid-declaration`. Elasticsearch caps `dense_vector` at 4096 dimensions (*verified*).
- **Versioning:** changing `model`, `dimensions`, `similarity` or `fields` requires raising `embeddings.version`, exactly as a mapping change requires raising `mappingVersion` today (see "Model or dimension changes").

## Search: filters, vectors and provenance

Elasticsearch 8.17 has a top-level `knn` search option, and it accepts a `filter`. Ordinary metadata filters restrict the candidate set before the nearest-neighbour search. For example, a `term` filter on `speakerId` or a date range on `provenance` limits which documents can be returned, rather than filtering after the top *k* has been chosen. A `query` can be sent alongside `knn`. Their scores are combined by boosts. Reciprocal rank fusion (RRF) is not available on Basic (*verified*, subscription matrix), so hybrid ranking uses weighted boosts.

Every hit is an indexed document whose `provenance` (collection, path, Git revision, blob) is set by the indexer. A semantic result therefore points to the exact Git record revision it was embedded from, as keyword results already do. The embedding metadata is stored next to the vector:
- `embedding.model`;
- `embedding.version`;
- `embedding.text_sha256`, the hash of the normalised embedded text.

That lets a result also state which model and text produced its vector.

## Comparing the models

| Model (OpenRouter ID) | Dimensions | Max input | Price per 1M input tokens | Query/document | Notes |
|---|---|---|---|---|---|
| `openai/text-embedding-3-small` | 1536 by default; can be shortened with OpenAI's `dimensions` parameter | 8192 tokens | $0.02 | Symmetric (no prefixes) | Proprietary. Widely used. **Recommended default.** |
| `baai/bge-m3` | 1024 | 8192 tokens | $0.01 | Symmetric ("no longer requires adding instructions to the queries") | MIT-licensed open weights; multilingual. |
| `qwen/qwen3-embedding-8b` | Up to 4096 | 40,960 tokens | $0.01 | Uses an instruction for queries | Large vectors raise index size. |
| `mongodb/voyage-4-lite` | Matryoshka, multiple sizes | 32,000 tokens | $0.02 | | |
| `perplexity/pplx-embed-v1-0.6b` | | 32,000 tokens | $0.004 | | Cheapest paid model. Less established. |
| `nvidia/nemotron-3.5-embed-1b:free` | | 32,768 tokens | $0 | | Free tier. Not suitable as a dependency (availability and limits not guaranteed). |

The IDs, context lengths and prices are *verified* from OpenRouter's public `GET /api/v1/embeddings/models` listing, fetched 2026-11-28. Dimensions are *verified* from the providers' own documentation:
- OpenAI: 1536 for 3-small, shortenable with `dimensions`, 8192 tokens.
- The BGE-M3 model card: 1024 dimensions, 8192 tokens, MIT licence.

OpenRouter's embeddings reference documents `model`, `input` (a string or an **array, for batching**), `input_type` (`document`/`query`, needed by some models) and `encoding_format`. It does not document a `dimensions` passthrough, so **do not rely on shortening dimensions through OpenRouter**. Use each model's native size. Errors are reported for the whole request (400/401/402/404/429/529), not per input. Input over a model's context length "will be truncated or rejected".

### Cost

These are *estimates* at the default model's $0.02 per 1M tokens, using about 4 characters per token.

| Workload | Assumption | Tokens | Cost |
|---|---|---|---|
| Today's `feeds` titles | Measured sample: 20 titles, 2,461 characters | ~615 | ~$0.00001 |
| Initial backfill | 1,000 posts × (20 claim utterances + 5 themes) × ~60 tokens | ~1.5M | **~$0.03** |
| Incremental, per new post | 25 items × ~60 tokens | ~1.5k | ~$0.00003 |
| Queries | 1,000 queries × ~15 tokens | ~15k | ~$0.0003 |

With `bge-m3` these costs halve. Cost is not the deciding factor between the two. If a separately authorised test is run, record the actual charges from OpenRouter's account activity: the embeddings response reports `usage` token counts but no cost field.

## Where embeddings are generated

| | Elasticsearch-managed (`semantic_text` + inference endpoint) | Application-managed (OpenRouter → `dense_vector`) |
|---|---|---|
| Availability on a Basic licence | **No.** The subscription matrix lists "Inference API – support for … third party … embeddings" under Enterprise only (*verified*). `semantic_text` is also beta in 8.17. | **Yes.** Vector search, vector field types, similarity functions and the kNN retriever are in Basic (*verified*). |
| OpenRouter compatibility | The `openai` service accepts a custom `url` "for testing purposes" and claims compatibility with OpenAI-compatible APIs. This is untested with OpenRouter, and moot given the licence. | Direct use of the documented OpenRouter API. |
| Credentials | The `api_key` is supplied once and cannot be changed in place: the endpoint must be deleted and recreated. That is a second copy of the key, held inside Elasticsearch. | Read through the canonical configuration directory on each pass, like the Elasticsearch connection (#945, #942). No copies. |
| Provider outage | Ingestion of `semantic_text` documents fails or stalls inside Elasticsearch. | The indexer records the failure for each document and keeps keyword search available (see below). |
| Unchanged text | Not documented. Reindexing appears to re-embed. | Reused through `text_sha256` (see below). |
| Model change | Recreate the endpoint and reindex. | New `embeddings.version`, then the existing alias-switch rebuild. |
| Cost visibility | Spread across ingest pipelines. | Every call is made by our code, so it can be counted and capped. |

**Deciding trade-offs:** unless the deployment holds an Enterprise licence, the licence rules out the managed path, and the application path also gives us canonical credentials, reuse of unchanged text and per-pass cost control.

## Reuse, failure recovery and rebuilds

- **Reuse.** Before calling the provider, the indexer computes `text_sha256` over the normalised text. It also computes a configuration key over model, dimensions, similarity and embeddings version. If the backing index already holds that document with the same hash and key, the existing vector is copied rather than recomputed. On a full rebuild, vectors are looked up in the previous backing index the same way. Repeated indexing of unchanged text therefore makes **no provider calls**, and the test plan asserts a call count of 0. The vectors are not stored in Git: they are derived data, reproducible from the record and the configuration.
- **Failures.** A failed embedding never blocks the document. The document is indexed without its vector field, with `embedding.status: "failed"`, so it stays searchable by keyword. Its path is added to the pass's durable `touched` set (#942's recovery mechanism), so the next pass retries only those documents. Batches are bounded (for example 64 inputs). On a 429 or 529 the batch is retried with backoff up to a bound, and after the bound each document is recorded as failed.
- **Model or dimension changes.** These always go through a new `embeddings.version`. That triggers #942's existing path: build a new backing index, populate vectors with reuse where the configuration key is unchanged, which is none when the model changed, then switch the alias only when the build is complete. Readers never see mixed models or dimensions in one index, and the previous index stays available for rollback.

## The smallest experiment

1. **Synthetic collection.** Use a public-safe synthetic collection of about 50 records: claim-like sentences, including paraphrases, negations and same-topic/opposite-meaning pairs, as in the earlier note. Commit it to a temporary repository and give it the `embeddings` declaration.
2. **Implement the indexer change** with a fake embedding client for unit tests:
   - reuse by hash, verified by a call count of 0 on the second pass;
   - per-document failure that keeps keyword search;
   - a version bump that rebuilds into a new backing index.
3. **Run once against OpenRouter.** This is the one **separately authorised** paid step. Use the default model at about 3k tokens in total, roughly $0.0001. Read the key from canonical private configuration and record the actual cost.
4. **Retrieval quality.** For 10 hand-written queries, compare the top 5 results from keyword search, kNN, and kNN plus keyword boosts. Record the hits with their `provenance` (path and revision), and confirm that every hit resolves to the exact Git blob.
5. **Repeat the pass** and verify there are zero provider calls and an unchanged index.

## Sources

- OpenRouter embedding models: `https://openrouter.ai/api/v1/embeddings/models`, fetched 2026-11-28.
- [OpenRouter embeddings API reference](https://openrouter.ai/docs/api/reference/embeddings)
- [OpenAI embeddings guide](https://developers.openai.com/api/docs/guides/embeddings)
- [BAAI/bge-m3 model card](https://huggingface.co/BAAI/bge-m3)
- [Elasticsearch 8.17 dense_vector](https://www.elastic.co/guide/en/elasticsearch/reference/8.17/dense-vector.html)
- [Elasticsearch 8.17 semantic_text](https://www.elastic.co/guide/en/elasticsearch/reference/8.17/semantic-text.html) (beta)
- [Elasticsearch 8.17 OpenAI inference service](https://www.elastic.co/guide/en/elasticsearch/reference/8.17/infer-service-openai.html)
- [Elastic subscriptions](https://www.elastic.co/subscriptions). Tier columns read from the linked PDF (2026-08-04): "Inference API" is Enterprise only; "Vector search" and "Retrievers: Standard, kNN" are in Basic; RRF is Enterprise only.
