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

## Retained preview images (#277)

When a new post is captured with an eligible preview image (`previewImage`, derived from Substack's `cover_image` under the #277 eligibility rules), the collector downloads it and saves the exact bytes in the capture archive, beside the record, as a binary artifact:

```text
substack/<publication>/<post>/images/<sha256>.<png|jpg|gif|webp>
```

The download goes through `PublicImageFetcher`:
- HTTPS only, to public addresses only, with the same address pinning as research page fetches;
- no redirects and no content encoding;
- a 5 MB limit and a 20-second timeout;
- the declared content type and the bytes' own signature must agree on an allowlisted image type.

The record's `previewImage.retained` is added only after the image is saved. It holds the exact pinned artifact reference, the content type and the byte size, and `previewImage.url` stays as provenance. A refused or failed download commits the record without `retained` and doesn't block collection. The image is content-addressed, so a retry or an unchanged image reuses the same artifact.

This applies to new captures only: there's no backfill or refetch. Indexers select their own document paths, so they never decode image bytes, and nothing runs OCR or image understanding on them. Set `STEELE_RETAIN_PREVIEW_IMAGES=0` to turn retention off in the collector. Each item logs a `preview-image` line with its outcome: `retained`, `no-preview`, `already-retained` or `failed`.
