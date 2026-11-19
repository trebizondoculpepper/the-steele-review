# Runtime diagnostic CLI

## Agreed development principle

When troubleshooting requires an awkward manual inspection, add a reusable diagnostic capability to the project CLI. Grow this surface from demonstrated debugging needs. Reuse typed controllers rather than adding scattered service queries, SQL or Git commands. PDB remains the tool for tickets and reviews; these commands inspect the running application.

## Initial delivery contract

These command names are proposed interfaces, not claims of implemented entry points. Each implementation must document its actual invocation and configuration requirements.

- `status`: bounded read-only service checks and operation counts. Preserve partial results when a dependency fails. Implemented as `npm run status -- [--json]` (`node dist/cli/status.js`), configured by the optional `STEELE_STATE_PATH`, `NATS_URL`/`NATS_TOKEN` and `ELASTICSEARCH_URL`/`ELASTICSEARCH_API_KEY` variables. It reports the state, broker and search checks independently with a bounded timeout, and no output field carries configuration.
- `operation <operation-key>`: recorded state, attempts, sanitized failure code, lease expiry, logical artifact references and pending-event counts. Implemented as `npm run operation -- <key> [--json]` (`node dist/cli/operation.js`); it requires `STEELE_STATE_PATH` and exits 0 for a found record (including a failed operation), 1 for not-found or unavailable state, 2 for invalid usage.
- `post <publication-id> <post-id>`: recorded stage observations for a source, including version mismatches and missing or unavailable observations. Implemented as `npm run -s post-trace -- <publication-id> <post-id> [--json]` (`node dist/cli/post-trace.js`; the npm script is not named `post` because npm treats `pre`/`post` script prefixes specially). Each source is optional and reported as `not-configured` when absent: `STEELE_STATE_PATH` (capture operation), `STEELE_ARCHIVE_PATH`/`STEELE_ARCHIVE_REPOSITORY` (archived record and current source version), `STEELE_CONTENT_PATH`/`STEELE_CONTENT_REPOSITORY` (theme and claim results, labelled stale when they describe another source version) and `ELASTICSEARCH_URL`/`ELASTICSEARCH_API_KEY` (indexed source version). Research, drafting and verification have no per-post key convention yet and report `not-traceable`; the post-analysed announcement (#178) is added once its event-ID helper is merged. Exit 0 when inspected (including failed or stale stages), 1 when a configured source is unavailable or nothing exists for the post, 2 for invalid usage.

Provide human-readable output and `--json`. JSON has a schema version and observation time. Distinguish missing configuration, unavailable dependency, not-found and not-recorded states. Do not infer completion from absence of pending events, document counts or historical completion for a different source version. A combined view is a best-effort observation across controllers, not an atomic snapshot. Bound time, lookup counts and result sizes; label truncation.

Exit 0 for successful inspection with healthy configured checks or a found record, 1 for unavailable/partial/unhealthy/not-found outcomes, and 2 for invalid invocation. An operation reporting failed processing can still be successfully inspected; its domain status remains explicit in the output.

## Controller and security boundaries

The state controller owns its inspection queries and exposes narrow typed methods. Inspection must open existing state without creating files, migrating schemas, acquiring claims or changing journal settings. Missing or incompatible state returns an explicit unavailable result. Other controllers likewise expose read-only domain probes; the CLI composes them and never accesses vendor clients directly.

Inspection must not provision infrastructure, consume or acknowledge messages, publish events, retry work, refresh leases, invoke models or perform paid research. Repair and retry commands remain separate explicit actions.

Project safe fields using an allowlist shared by text and JSON renderers. Never dump raw controller objects, event payloads, article contents, credentials, private service URLs, internal hosts, physical paths or raw exception strings. Artifact references are logical identifiers only. Runtime configuration stays external under the existing security policy; no home infrastructure documentation belongs here.

## Verification and incremental extension

Use synthetic fixtures and controller fakes for healthy, partial, missing, failed and version-mismatched observations. Assert inspection changes no workflow or storage state. Include sensitive sentinel values in fake failures and nested records to prove both output formats exclude them. Exercise the state-controller read-only path against an existing store and a missing path.

Future claim, theme, dossier and drafting diagnostics should follow the same contracts. A dashboard, new service and automatic coordinator are outside this initial scope.
