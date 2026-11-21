# Trigger one archived article

The Articles list and article trace offer **Run this revision** when the dashboard has its archive and Restate connection configured and `STEELE_DASHBOARD_ORIGIN` is set. Set that variable privately to the exact HTTP(S) browser origin, with no trailing slash or path. Without it, the dashboard exposes no submission action. Keep network exposure restricted as documented for the dashboard.

The configured origin is the single canonical address for form submissions. Other configured network routes can still serve read-only pages, but their form submissions are rejected if their Origin or Host differs. Action links lead to the configured canonical address, including when the list is viewed through an alias. Use the canonical address to confirm a run; do not relax the checks to accommodate aliases.

The confirmation page shows the captured source version and warns of model/research charges. Confirming sends a same-origin form POST. The server validates the selection against the current complete capture, pins the artifact reference, and submits through the existing ArticleRun interface. A changed or unavailable revision returns a conflict; return to the trace and select again. The trace page shows the existing run status and eventual artifacts.

`STEELE_DASHBOARD_RESEARCH_REQUEST_LIMIT` (default 5, range 0–100) and `STEELE_DASHBOARD_RESEARCH_DEADLINE_MS` (default 1800000, range 1000–86400000) are server-controlled workload bounds. Form fields cannot override them. Provider key limits remain the owner's external monetary control; this command adds no monetary ledger or dollar gate. Provider credit warnings are handled separately by #407.

Repeated confirmation uses the same publication/post/source-version workflow key as CLI and automatic capture. It reattaches to existing work rather than resetting a failed run or creating a second identity. Submission failures return a generic unavailable response; retry the same selection because an ambiguous response may already have been accepted. No GET starts work. The action does not alter verification, dispatch or publisher delivery configuration.

POSTs require the configured Origin and Host, the same-origin fetch-site value when supplied, form encoding and a body no larger than 4096 bytes. Forwarded headers are not trusted. Deployments using a proxy must preserve the configured Host and browser Origin. Do not put actual deployment origins or connection details in public documentation.
