# Live capture preflight and staged validation

This runbook covers discovery → collection → private text archive → Elasticsearch. It does not enable claims, research, drafting or publication. Deployment endpoints, credentials, host paths and administration commands belong in private deployment documentation.

## Deployment prerequisites

The source inspection for this runbook used main at `e4bb40f`. Check these gaps against the revision being deployed; a merged library component alone is not a runnable service.

- `CollectionWorker` exists in `src/collection/worker.ts`, but this revision has no collection CLI under `src/cli/`. A composition entry point must instantiate the controllers, consume discovery deliveries, call `handle`, and arrange periodic/startup `dispatchPending` calls so an unsent outbox can drain without another discovery event. It must close resources on shutdown and avoid overlapping collection work in the initial trial.
- The standard Docker image starts `dist/main.js`, the connectivity probe. Starting that image does not start collection or indexing.
- `GitArtifactStore` executes Git, but the runtime Docker stage does not install Git. Supply it in the application image, verify it as the runtime user, and initialise the private archive through `GitArtifactStore.initialise()`. Host Git installation alone is insufficient.
- The standard image's HTTP health check targets the probe. A worker command override needs a suitable worker health policy; it must not inherit a probe-only health check and appear unhealthy solely because it has no HTTP server.
- Mount durable archive storage and state storage with permissions for the runtime user. Keep SQLite private to its in-process state controller; do not share a database file between independent worker containers. Independent processes need separate controller-owned state files. Indexing needs read access to the same committed archive and matching logical repository name.
- If transcription is needed, supply and verify the selected provider and its runtime dependencies. Prefer source transcripts, then audio-only transcription. Temporary media must be bounded and cleaned up; do not claim the transcription path passed when only article text was tested.

Workers must use the Git artifact controller, never shell out to Git themselves. Initialisation and inspection tooling must also use that boundary rather than introducing another implementation of archive Git operations.

## Before submitting posts

1. Confirm there is only one operator running the staged import. Check the active ticket claim before starting another run.
2. Test broker and index connectivity from inside the actual worker network and runtime, using private configuration. A successful host check or separate probe does not prove the worker can connect.
3. Explicitly provision the discovery stream/consumer, text-ready stream/consumer and full-text alias using the existing controller provisioning methods. Startup must not silently mutate unrelated infrastructure.
4. Start collection and the [indexing worker](indexing-worker.md). Confirm consumption and outbox dispatch are active, and that private values are absent from diagnostics.
5. Keep scheduled discovery and downstream analysis/publication disabled during the bounded trial. Record the deployed revision and selected post identities privately.

## Existing commands

These commands run inside an appropriately configured application runtime after building. They do not replace the missing collection entry point:

```sh
node --enable-source-maps dist/cli/index-worker.js
node --enable-source-maps dist/cli/backfill.js --help
```

The bounded discovery command accepts:

```sh
node --enable-source-maps dist/cli/backfill.js \
  --publication-url https://publication.example \
  --publication-id example-publication \
  --max-items 3
```

Use the selected publication in private configuration; the URL above is synthetic. Optional inclusive `--since` and `--until` timestamps bound the historical range. A successful backfill command means discovery events were accepted by NATS, not that content was captured or indexed. Repeating the same newest-first bounds can rediscover the same posts; track identities and choose the next range explicitly when growing the trial.

## Acceptance gates

Begin with three posts, processed one at a time. For each, inspect the exact committed collection artifact and its Elasticsearch document:

- Text matches the source, is readable and substantially complete; compare supplied transcripts or transcription output with the source where applicable.
- Publication/post identity, original URL, publication date, acquisition method and archive reference are correct. Do not treat partial or failed extraction as success.
- The document is searchable by a distinctive passage and resolves to the expected source and immutable artifact.
- Deliver an overlapping discovery range again and confirm no additional collection artifact or duplicate searchable document appears for the same content identity.
- Check recorded outcomes, outstanding events and retry behaviour; sanitised failure reports must distinguish a pending retry from successful capture.
- Confirm temporary audio/video has been removed after processing and no media was committed to the archive.

Only after the entire batch passes, submit a modest additional batch. Repeat inspection after every batch and grow gradually. Any extraction, provenance, duplicate or data-quality defect stops expansion: fix it and revalidate the affected cases before increasing volume. Loading the remaining accessible archive is conditional on repeated clean batches, not a fixed three-plus-ten threshold.

Record batch counts, outcomes, defects and the decision to expand in the private run log. Backups and disaster recovery are outside this proof of concept; durable completion, duplicate prevention and pending-event handling remain required. [Archive replay](index-replay.md) is available for rebuilding the search projection after collection is verified.
