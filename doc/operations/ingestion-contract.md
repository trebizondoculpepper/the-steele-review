# Ingestion contract: captured content

Every ingestion source hands archived content to the writing engine through one source-neutral event (#269): `steele.v1.content.captured` (`org.steele.content.captured.v1`, on the `STEELE_CONTENT` stream). The Substack-specific text-ready event (`steele.v1.content.extracted`) is unchanged and still drives indexing; the collector commits both in the same outbox step.

## Fields

| Field | Meaning |
| --- | --- |
| `source.namespace` | `<kind>/<instance>`, e.g. `substack/saveusnow` or `blog/example-site` |
| `source.kind` | the namespace's kind (`substack`, `blog`, ...) |
| `itemId` | stable item identity within the namespace (a Substack post slug) |
| `originalUrl` | public HTTPS link to the original item, used by the article |
| `title`, `publishedAt` | optional, when the source provides them |
| `artifact` | exact archived text revision (repository, commit, path, hash) |
| `sourceVersion` | hash of the archived text |
| `complete` | false when only part of the content could be retained |
| `transcript` | `none`, `supplied` (with the platform's variant) or `generated` (with the engine) |
| `ingestionReason` | `live`, `backfill` or `reprocess` |

The event subject is `<namespace>/<itemId>`. Its ID is derived from the namespace, item and exact artifact, so re-emitting or redelivering the same revision is idempotent and a new revision gets a new ID. `parseCapturedContentEvent` validates the envelope and payload, and a JSON Schema is exported for consumers.

## Adding an ingestion source

1. Archive each item's text through the artifact controller, one write-once artifact per revision, under a path for its namespace.
2. Build the event data for the archived revision (see `substackCapturedContent` as the reference adapter), choosing a stable namespace and item ID.
3. Record the event in the state controller's outbox together with the archive operation's completion, and dispatch it on `steele.v1.content.captured`.
4. Add the source's producer to the message registry description if it is new.

The NATS-to-Restate bridge (#270) consumes this event to start one article workflow per item revision.
