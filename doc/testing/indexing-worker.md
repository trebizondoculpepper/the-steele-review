# Indexing worker

The indexing worker (`dist/cli/index-worker.js`) consumes text-ready events from a durable JetStream consumer and indexes the committed collection text into the full-text index. It is the last step that makes captured posts inspectable in Elasticsearch.

## Before starting

Provision once, explicitly (the worker never creates streams, consumers or indices):

- a stream capturing the text-ready subject (`steele.v1.content.extracted`), for example with `provisionDiscoveryStream`;
- a durable, explicit-acknowledgment consumer on that stream filtered to the subject, with `provisionDurableConsumer`;
- the full-text index alias with `ElasticsearchController.provisionIndex(<alias>, FULLTEXT_INDEX_MAPPING)`.

## Configuration

Environment variables (values are deployment configuration and stay outside this repository):

| Variable | Meaning |
| --- | --- |
| `NATS_URL`, `NATS_TOKEN` (optional) | Broker connection |
| `ELASTICSEARCH_URL`, `ELASTICSEARCH_API_KEY` (optional) | Index connection |
| `STEELE_ARCHIVE_PATH` | Local path of the private artifact repository |
| `STEELE_ARCHIVE_REPOSITORY` | Logical archive name recorded in artifact references |
| `STEELE_STATE_PATH` | Absolute path of the SQLite state file |
| `STEELE_INDEX_STREAM`, `STEELE_INDEX_CONSUMER` | Provisioned stream and durable consumer |
| `STEELE_FULLTEXT_INDEX` (optional) | Index alias; defaults to `steele-source-text-v1` |
| `STEELE_INDEX_RETRY_DELAY_MS` (optional) | Redelivery delay after a retryable failure |

Missing or invalid configuration exits with status 2 and names the fields, without printing values.

## Health and behaviour

The worker prints one JSON line per decision, for example `{"event":"indexing","action":"ack","outcome":"indexed"}`, plus `consuming` and `stopped` state lines. It processes one message at a time.

| Outcome | Action |
| --- | --- |
| `indexed`, `stale` (already indexed, or an older retrieval than the indexed one) | acknowledge |
| `retry` (index timeout/outage/throttling, transient archive read) | redeliver after the retry delay |
| `failed`, `incomplete` | recorded as a non-retryable operation in the state file, then acknowledged |
| malformed message | terminated |

SIGTERM or SIGINT stops consumption after the in-flight message and closes connections.

## Smoke test

`test/collection/indexing-consumer.test.ts` includes a controlled smoke test that runs when both `STEELE_TEST_NATS_URL` and `STEELE_TEST_ES_URL` point at disposable servers (`scripts/nats-test-server.sh start`, `scripts/es-test-server.sh start`). It delivers one saved text-ready event twice, simulates an index outage on the first attempt, and checks that exactly one searchable document results. Checks against the real deployment belong to the staged capture work (#92).
