# Project rules

## Code review guidelines

Architecture and security review are mandatory for every code change. Read [SECURITY.md](SECURITY.md) and the relevant documents under [doc/architecture](doc/architecture/README.md), then inspect the implementation against them. Passing compilation, lint, or tests does not override these requirements.

Report any concrete architecture or security violation as a blocking finding requiring changes. Cite the affected file and line, the principle violated, and the resulting failure or exposure. Do not approve a change with an unresolved violation. Distinguish an agreed architectural requirement from an explicitly provisional software suggestion; a different candidate library alone is not a violation.

### Architectural requirements

- Application and test code must be TypeScript. A different implementation language requires a specific documented benefit and explicit agreement to the exception. Files under `scripts/` are exempt: shell, Python, or another language supported by the local system may be used for convenient operational/development automation. Do not move application logic into `scripts/` to evade this boundary. Configuration files, Dockerfiles, and documentation use their native formats.

* Isolate each external concern behind its own controller or adapter, including Substack, NATS, and Elasticsearch. Keep vendor-specific clients, authentication, and protocol handling within that boundary. Entry points compose controllers; business logic must not bypass them.
* Isolate all application Git operations behind the artifact-store controller (`GitArtifactStore`). Workers and other controllers use typed artifact methods; they must not execute Git commands, construct Git argument arrays, or implement repository plumbing. Keep Git process execution and repository initialisation inside that boundary. Repository development commands are outside this runtime restriction.
* Keep ingestion, archiving, extraction, indexing, analysis, research, drafting, verification, and publishing logically separate. Separate containers are optional. New pipeline work must preserve event-driven processing and recoverable stage boundaries.
* Preserve stable source and operation IDs, versioned artifacts, runtime validation at external boundaries, and safe retries. Do not acknowledge work before durable completion or lose downstream work between saving state and emitting an event. Apply these requirements when implementing processing stages; the read-only connectivity probe does not require a workflow engine.
* Prevent duplicate publication and reconcile uncertain external side effects. An ambiguous publish response must not trigger creation of another article.
* Store all model-facing prompt templates in version-controlled Markdown files under `src/prompts/<service-name>/`, one file per prompt. Services load those files and supply runtime data. Build and deployment artifacts include them, and model-backed stages record the prompt identity used. See [prompt files and provenance](doc/architecture/08-decisions-and-open-questions.md#prompt-files-and-provenance).
* Keep writing separate from verification. Automatic publication requires verification of the exact article version; inconclusive cases must end in a recorded skip after bounded attempts. Do not replace evidence checks with model confidence alone.
* Treat fetched content and model output as untrusted data. Preserve source provenance and distinguish independent evidence from assertions in monitored material.
* Keep runtime and deployment suitable for the documented lightweight container architecture. Introduce new services or language runtimes only with a stated architectural reason.

An intentional change to an agreed principle requires explicit user agreement and a corresponding architecture update. Editing an architecture document in the same change does not by itself authorise a conflicting implementation. Review only requirements applicable to the functionality being changed; do not demand unimplemented future pipeline features from a connectivity-only change.

### Security review gate

Disallow any change that leaks configuration information about the user's home setup. This includes actual internal hostnames, addresses, private URLs, topology, accounts, ports associated with real hosts, credentials, and host-specific administration details. Check all changed files and relevant output paths, including tests, fixtures, scripts, generated files, logs, error responses, Docker layers, and CI artifacts. Private values in comments or examples are still leaks.

The local `.env` exception below allows development access only. Never track, package, print, upload, or expose its contents. Public examples must use clearly synthetic placeholders. If a concrete leak is found, block approval and describe its location and type without repeating the value.

These instructions establish the review policy. Enforcing a merge block also requires repository rules or branch protection to require the review/check; this file alone does not configure GitHub enforcement.

## Confidential information and infrastructure documentation

This is a public, open-source repository. Do not create, copy, or commit confidential information or home lab infrastructure documentation anywhere in this project, including untracked files, local configuration, generated artifacts, logs, fixtures, issue bodies, and pull request descriptions.

Explicit user-authorised exception: a local, non-versioned `.env` may contain private development connection configuration. Keep it Git-ignored, excluded from Docker build contexts, readable only by its owner, and out of logs and public artifacts. This exception does not permit infrastructure documentation or committing private values.

Keep home lab infrastructure documentation and private connection information in the separate Mind of Steele project. Consult that project when authorised access is needed; do not duplicate its private details here.

Prohibited material includes credentials, tokens, private keys, actual hostnames and addresses, SSH connection details, private service URLs, deployment inventories, and host-specific administration instructions. Do not reproduce these details in project tickets or other public collaboration surfaces.

Public application architecture may describe generic dependencies, interfaces, configuration variable names, and deployment requirements using placeholders. It must not document the actual home lab topology or connection details. Supply private runtime configuration from outside this repository.

If private information is discovered in this project, stop propagating it, report the issue without repeating the sensitive values, and remove it from the working files. If it has entered Git history or a public service, report that separately so remediation can be coordinated.

<!-- pdb:coordination:start -->

## Coordination with Presidential Daily Briefing (pdb)

This project (trebizondoculpepper/the-steele-review) uses pdb for status, priorities, claims and handoffs.

- At the start of every session, read the current rules: `pdb rules`.
- First use: `pdb --repo trebizondoculpepper/the-steele-review --role implementer|designer`. PDB reuses or safely creates your identity, saves it and continues. If selection is ambiguous, select your logical entry with --entry KEY. A verified binding retains it; unsupported sessions must keep passing --entry KEY on every invocation. Never reuse another agent's name.
- See what to do next: `pdb --repo trebizondoculpepper/the-steele-review`. Help: `pdb --help`; onboarding: `pdb onboard --repo trebizondoculpepper/the-steele-review`.
- MCP clients: `pdb-mcp --repo trebizondoculpepper/the-steele-review`.
- Prefer pdb over raw gh for status and priorities; use gh only for operations pdb does not support.
- Do not ask the user for permission before picking up work. If pdb offers an item as available (listed under READY / UNCLAIMED, or a next step whose command is a claim), it is explicitly available: claim it and start. Availability settles pickup, not scope: still ask when pdb does not offer the work, when a decision is recorded as unresolved on the ticket, when the change would alter an agreed architectural principle or require an architecture update, or when the security review gate would block it. Those still require explicit user agreement as described above.

<!-- pdb:coordination:end -->

## SQLite isolation

SQLite is private to the state-controller implementation. Only that implementation may import the driver, issue SQL, manage migrations, or access the database file/path. Other components use its narrow typed domain interface; do not expose generic queries, raw handles, or shared-file database access. Keep completion and pending-event transactions, ownership checks and expiry handling behind this boundary. The proof of concept uses an in-process controller; a separate service is not required. Architectural review must reject bypasses of this boundary.
