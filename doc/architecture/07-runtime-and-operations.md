# Runtime and operations

## Language and tooling

Use TypeScript as the primary implementation language on Node.js. Use Vite+ for development tooling, checks, and tests; backend workers execute under Node rather than requiring a Vite frontend server. The initial backend baseline includes compilation, type checking, Vite+ formatting/lint checks, and a read-only connectivity service.

Compile with source maps and run Node with source-map support so production stack traces identify TypeScript locations. Validate configuration, events, and model outputs at runtime using a schema library to be selected. Application and test code must be TypeScript. Other implementation languages require a specific documented benefit and explicit agreement to an exception. Files under `scripts/` may use shell, Python, or any suitable language supported by the local system for operational/development automation; application logic must not be moved there to bypass the TypeScript requirement. Configuration and documentation retain their native formats.

## Deployment

Develop on the Mac and deploy Docker containers to the Raspberry Pi. Proposed orchestration is Docker Compose. Confirm the Pi's model, operating system, CPU architecture, memory, and storage before selecting images. Build and verify an image for the Pi's actual architecture rather than assuming the Mac's image will run there.

NATS and Elasticsearch are existing remote dependencies. Do not deploy duplicate instances on the Pi. Persist application state and archive data outside ephemeral container filesystems. Use a private Git text archive and SQLite workflow state on persistent local volumes.

Initially use one application codebase with explicit worker roles. Worker concurrency must be configurable, with conservative limits for audio, network downloads, and model calls. Model inference and transcription providers remain undecided; the design must allow those workloads to run off the Pi.

## Configuration

External configuration includes source publications, destination publication, polling interval, NATS connection and credentials, Elasticsearch endpoint and credentials, archive location, workflow-state location, model configuration, retry limits, and publication policy. Keep secrets out of source control, events, model prompts, and logs.

### Live configuration authority (owner decision)

The configuration handler is the authority for reading and writing runtime settings. Components obtain the latest validated values through its typed interface before each new policy decision or outbound request. Do not add application-level configuration caches, startup-only copies, worker-specific settings files, generated key files or persisted configuration snapshots as another authority. A change should affect the next applicable action without restarting the application. Transports that require reconnection refresh through their owning controller and report when the new configuration is effective.

Persist secret values only in canonical private configuration, outside the public repository and distributed artifacts. Read credentials through the handler at the request boundary; retain a value in memory only for the request that needs it. Never save keys in a workflow journal, run record, Git artifact, event, model input, receipt, telemetry or derived credential file. Atomic edits must remain visible through a least-privilege read-only configuration mount. Invalid or unavailable configuration produces a sanitized failure or hold; do not silently fall back to a stale cached value.

A run may record the non-secret policy values and configuration revision actually used for a decision, for audit and replay. Do not copy the complete configuration or secret values into that record. Historical decisions remain reproducible; future decisions read live configuration again. Restate must journal each applied decision so replay does not reinterpret completed work using today's settings. Recheck live pause, stop and destination permissions immediately before a new external side effect, including after resuming a saved intent.

This is the required behavior. Existing startup credential snapshots and submission-only editorial policy snapshots are implementation gaps to remove through the configuration and workflow follow-ups; this document does not claim they already reload live.

## Observability

Emit structured logs containing source ID, source version, correlation ID, stage, attempt, duration, and outcome. Preserve error causes and readable stack traces. Article milestones use a stable post correlation ID across revisions. They are written to local container logs and may also be exported to Sentry Logs when a runtime DSN is configured. The remote exporter uses fixed messages and an attribute allowlist. Error tracking and tracing are separate signals.

Track successful and failed polls, pipeline lag, retry counts, skipped articles and reasons, publication uncertainties, model usage/cost, and resource use. Expose worker liveness separately from remote dependency readiness. Notify the operator about prolonged outages or uncertain publication without making routine processing require approval.

## Shutdown and recovery

On termination, stop accepting new work, allow bounded completion of in-flight work, and drain connections where possible. Unfinished messages remain recoverable through durable delivery and workflow state. Test ordinary restart and retry behaviour. Backup, restore procedures, and disaster recovery are outside the proof-of-concept scope.

## Validation priorities

Prefer integration smoke tests: detect and archive a fixture post, round-trip an event through a test stream, index and retrieve a document in a test index, and resume after an interrupted stage. Test duplicate delivery and uncertain publication using a controlled publisher adapter. Use real publishing only for explicitly authorised integration tests. Production index mappings and stream configuration must not be changed by generic tests.
