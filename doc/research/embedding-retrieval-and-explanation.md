# Embedding retrieval and evidence explanation

## Question

Can embeddings cheaply shortlist relevant source claims and independent research passages, allowing a writing LLM to explain whether the evidence supports, contradicts, qualifies or leaves a claim unresolved?

## Proposed experiment

Use a small sample of captured source text and separately labelled independent evidence. Split deterministically, generate embeddings with one configured model, then inspect nearest passages for a claim, paraphrase, negation and correction. Return actual text, citation/provenance and similarity scores. Synthetic examples must be labelled and kept out of the evidence corpus. #73 tracks this optional investigation; it is not required for content capture.

Embeddings are candidate retrieval, not truth probabilities or a logical-negation operation. The writer receives source claim plus evidence passages and citations, explains the relationship and preserves uncertainty. The verifier checks that explanation against the same evidence. A separate contradiction-classifier service is not required initially. Compare keyword retrieval and semantic retrieval on the same small examples, especially negation and same-topic/opposite-meaning cases.

## Elasticsearch capability and licensing

Elasticsearch 8.17 documents `dense_vector` fields and approximate k-nearest-neighbour search. Elastic's subscription matrix lists vector search in its free Basic tier. Generate embeddings through our own controller, store the numeric vectors and use standard vector search; this does not require purchasing Elastic's built-in model services. Optional ELSER/model-hosting/inference and advanced ranking features have separate licensing requirements and must not be assumed available. Verify each selected feature rather than treating all features called semantic search as equivalent.

References:

- [8.17 dense_vector documentation](https://www.elastic.co/guide/en/elasticsearch/reference/8.17/dense-vector.html)
- [8.17 kNN search documentation](https://www.elastic.co/guide/en/elasticsearch/reference/8.17/knn-search.html)
- [Elastic subscription matrix](https://www.elastic.co/subscriptions)
- [ELSER subscription requirement](https://www.elastic.co/docs/explore-analyze/machine-learning/nlp/ml-nlp-elser)

## Status

Research brief and documented capability check only. No embedding provider/model has been selected or benchmarked by this note. Test the chosen dimensions, similarity and mapping against an isolated test index before a real embedding run. Source evidence must remain distinguishable from monitored assertions regardless of vector similarity.
