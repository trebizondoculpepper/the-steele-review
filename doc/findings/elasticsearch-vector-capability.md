# Elasticsearch vector capability

Measured for issue #29 against a disposable single-node Elasticsearch 8.19.2 with the default **Basic** licence (no trial, no paid features), using `test/content/passage-vectors.test.ts` with `STEELE_TEST_ES_URL` set. No production cluster was touched.

## Result

| Capability                                                                   | Basic tier, 8.19.2                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `dense_vector` field with explicit `dims`, `index: true`                     | Supported                                                    |
| `similarity: cosine`                                                         | Supported; used by the passage-vector mapping                |
| `similarity: dot_product`, `l2_norm`, `max_inner_product`                    | Supported (index, write and kNN probed)                      |
| Top-level approximate `knn` search with `k` and `num_candidates`             | Supported                                                    |
| `knn.filter` (keyword term filter)                                           | Supported                                                    |
| Wrong-dimension vector on write                                              | Rejected by Elasticsearch (HTTP 400, reported as `rejected`) |
| Strict mapping with `dense_vector` alongside keyword/text/date/object fields | Supported                                                    |

No separate vector database is needed: the observed limitation that would justify one (no dense-vector storage or approximate kNN at the available tier) does not exist. Paid inference (ELSER, inference endpoints) and advanced ranking are not used: embeddings are computed externally by the #28 embedding controller and only stored and searched here.

## Storage design

- One logical index (alias) per vector space: provider, model, version and dimensions. The name is `steele-passage-vectors-v1-<16 hex>` where the suffix is derived from the vector-space ID, so vectors from different models or dimensions can never share an index.
- Each document keeps passage ID, source ID and version, splitter version, span, exact passage text, publication date, archive reference, input hash, vector-space ID and model identity. The vector field is excluded from search results.
- Changing model, version or dimensions means provisioning a new index and embedding into it deliberately; nothing is rewritten in place, and the old index stays queryable until it is retired.
- Writes require the alias (see #24), so a missing index is never auto-created.

## Limits of this result

Measured on one Elasticsearch version and licence tier. The deployed cluster's version and licence must be checked before relying on it; the capability test can be pointed at an isolated test index there to confirm.
