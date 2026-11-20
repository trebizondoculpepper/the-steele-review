# Writing engine boundaries

NATS is the boundary on either side of the writing engine (#268).

- **Inbound:** ingestion sources discover and archive content, then emit the source-neutral captured-content event. See [the ingestion contract](../operations/ingestion-contract.md) (#269).
- **Engine:** Restate runs one article workflow per captured item revision: extraction, librarian coverage, research, drafting and verification. See [the article pipeline](../operations/article-pipeline.md) (#243); the bridge from captured content to workflows is #270.
- **Outbound:** an approved article revision is announced once on `steele.v1.article.approved`, and each destination's own consumer delivers it on its own schedule. See [the publishing contract](../operations/publishing-contract.md) (#262).
