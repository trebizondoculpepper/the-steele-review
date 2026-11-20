# Security principles

## Public repository, private configuration

The Steele Review is open source. No code change may disclose configuration information about the owner's home setup. Infrastructure details belong in the separate Mind of Steele project, outside this repository.

Protect credentials, API tokens, keys, real internal hostnames and network addresses, private service URLs, account names, home network topology, deployment inventories, and host-specific operational instructions. This applies to code, documentation, comments, fixtures, snapshots, logs, exceptions, HTTP responses, image layers, source maps, release bundles, CI artifacts, tickets, and pull requests.

Generic configuration variable names, synthetic placeholders, controller interfaces, and application deployment requirements are appropriate public material. Do not derive public examples from actual private values.

## Local development exception

The user also permits a root `secret.md` file containing local pointers to credential locations. Treat its contents as private configuration: owner-readable only, Git-ignored, excluded from builds/packages, and never uploaded or reproduced in logs or public collaboration. Prefer references to existing credential files rather than copying secret values. This is a narrow exception to the prohibition on local infrastructure information; tracked files may describe the convention but must not contain the private pointers themselves.

The user explicitly permits an unversioned local `.env` containing development connection configuration. It must be Git-ignored, owner-readable only, and excluded from Docker build contexts and every distributed artifact. Do not upload it to CI, embed its values in compiled code, or expose it through frontend environment substitution. Runtime configuration must be supplied separately from application images.

An ignore rule alone is insufficient: check whether sensitive files are already tracked and whether packaging scripts explicitly include them. Never force-add a private configuration file.

## Boundaries and least privilege

External controllers own service authentication and connections. Grant each component only the permissions needed for its role. A connectivity probe must remain read-only; it must not create indices, streams, or publications. Keep publishing credentials and capabilities outside research and extraction components.

Treat source pages, transcripts, research material, and model responses as untrusted input. Validate structured data at runtime and prevent source text from changing tool permissions, credentials, verification rules, or publishing policy. Validate destinations before implementing arbitrary URL fetching so untrusted content cannot reach internal services or metadata endpoints.

## Safe diagnostics

Return bounded operational status without private endpoints or credentials. Client exceptions may contain request URLs, headers, and authentication details; do not serialize them directly to logs or API responses. Use sanitised error categories and correlation IDs. Apply the same controls to telemetry and third-party error tracking.

## Automated publication

Publish only the exact article version that passed verification. Preserve evidence provenance, safe retry behaviour, and reconciliation of uncertain publication outcomes. Never let untrusted input bypass verification or directly invoke the publisher.

## Review and incident handling

Any concrete configuration leak or violation of these principles is a blocking review finding, even when tests pass. Findings identify the location and exposure category without quoting sensitive values. Reviewers must inspect relevant generated outputs and packaging behaviour, not only source text.

If private information is discovered, stop propagating it and remove it from working files. If it reached Git history or an external service, tell the owner without repeating it and coordinate removal and credential rotation where applicable. Do not assume deleting the current file removes historical exposure. Do not open a public issue containing private details.
