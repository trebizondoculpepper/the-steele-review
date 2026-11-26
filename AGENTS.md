# Project rules

## Code review guidelines

Architecture and security review are mandatory for every code change. Read [SECURITY.md](SECURITY.md) and the relevant documents under [doc/architecture](doc/architecture/README.md), then inspect the implementation against them. Passing compilation, lint, or tests does not override these requirements.

Report any concrete architecture or security violation as a blocking finding requiring changes. Cite the affected file and line, the principle violated, and the resulting failure or exposure. Do not approve a change with an unresolved violation. Distinguish an agreed architectural requirement from an explicitly provisional software suggestion; a different candidate library alone is not a violation.

### Architectural requirements

The owner has retired the previous implementation and confirmed a clean-slate rebuild. Read [confirmed rebuild principles](doc/architecture/rebuild-principles.md) first. They govern the new design; implementation-specific requirements in older documents describe the archived version unless explicitly reaffirmed. Do not restore old application services, resume legacy tickets or introduce a replacement platform without an explicit task.

- Follow the chosen platform's native patterns and prefer its operational interface to building a custom dashboard. No replacement platform is selected yet.
- Keep explicit, recoverable intake, storage, writing and delivery stages, with bounded agent responsibilities.
- Make inputs, outputs, artifacts, stage status, duration and available cost inspectable from the minimum demonstration onward.
- Preserve stable identities, provenance and versioned results; reuse completed work and prevent duplicate external delivery.
- Pass useful partial results onward with honest warnings. Distinguish missing evidence from technical failure.
- Bound spending, execution time, retries and corrections, with explicit outcomes at limits.
- Prove interruption, restart and duplicate-delivery recovery as well as the successful source-to-draft path.
- Isolate external authentication and protocol handling behind typed adapters and validate untrusted inputs.
- Keep prompt templates version controlled and record prompt identity with model-backed outputs. Choose their new layout alongside the replacement implementation.
- Application and test code remains TypeScript unless a documented benefit and explicit owner agreement authorize another language. Operational scripts may use a suitable local language.
- Keep private configuration and secrets outside public artifacts. Use the canonical configuration handler, without copied credentials or additional application configuration caches.
- Architecture and security review remain mandatory. Propose changes to agreed principles explicitly; an implementation or document edit alone does not authorize an exception.

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
- Merge your own pull requests. Once your PR is green and unblocked, merge it; do not wait for someone else to do it. Getting your own PR unblocked is your work: answer review findings, resolve threads, rebase conflicts and re-request review. Merging someone else's PR is not implied by this rule.
- When pdb offers a ticket as available, claim it and start. Availability authorizes pickup. Unresolved scope decisions, architectural exceptions, and security exceptions still require explicit agreement.
- When no ticket is claimable, do not stop at "blocked". Always re-check the board first, because it changes within minutes. Then do the work that needs no claim:
  - Estimate: refresh stale estimates and raise refinement requests for tickets whose scope is not yet clear.
  - Review work that is not ready: read it anyway, ask the design questions on the ticket, and say what still needs future design.
  - Look for anything that may be broken, and fix defects proactively.
  - Identify oversized tickets and propose how to split them.
  Report a blocker only after those are exhausted, and only with the specific decision needed.
- Implementers raise all work questions on the relevant ticket. Record the question, the decision needed, and why it matters. If the question blocks implementation, record the blocker and move on to the next available ticket. Keep working through the queue without interrupting the human directly. Resume the blocked ticket once the decision is recorded on it.

<!-- pdb:coordination:end -->

## State ownership

Let the selected platform own workflow state and recovery where supported. Any additional store requires a documented need and a narrow typed owner interface. If SQLite is introduced, only its owning state-controller implementation may import its driver, issue SQL, manage migrations or access its database files. Other components must not bypass that boundary.
