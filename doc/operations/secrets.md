# Secrets and configuration boundary

The current decision for the proof of concept: credentials are protected host files mounted read-only into only the containers that need them. Research into secret-store alternatives is #65; this note covers the boundary that exists today (#129).

## Inputs

| Variable                                               | Sensitive                | Used by                                                       | Notes                         |
| ------------------------------------------------------ | ------------------------ | ------------------------------------------------------------- | ----------------------------- |
| `NATS_URL`                                             | yes, may carry user info | every worker, `backfill`, `discover`, `provision`             | never printed                 |
| `NATS_TOKEN` / `NATS_TOKEN_FILE`                       | yes                      | the same                                                      | optional                      |
| `ELASTICSEARCH_URL`                                    | yes, may carry user info | `index-worker`, `provision`, `replay-index`, `claim-timeline` | never printed                 |
| `ELASTICSEARCH_API_KEY` / `ELASTICSEARCH_API_KEY_FILE` | yes                      | the same                                                      | optional                      |
| `STEELE_*` paths, names and URLs                       | no                       | as documented in each entry point                             | the publication URL is public |

Model and search provider keys (OpenRouter, Kagi) aren't read by any entry point yet. When they are, they'll go through the same boundary.

## How credentials are read

`src/config/credentials.ts` is the only place credentials are read.

- **Two forms:** `<NAME>` for local development, or `<NAME>_FILE` naming a mounted file for deployment. One trailing newline is removed. Setting both is a `conflict`.
- **Least privilege:** `natsConnection()` and `elasticsearchConnection()` give each controller only its own URL and credential. Workers never receive a general secret-store handle.
- **Sanitised errors:** problems are reported as `<VARIABLE>: missing | unreadable | empty | conflict`. Errors never contain the value or the file's path.
- **Redaction:** `redact()` and `sensitiveValues()` remove credentials and URL user info from any text. Entry points never print client exceptions.
- **No leakage into content:** credentials go only to the broker and search controllers. They're never passed to content fetching (tested) or to the analysis, drafting or verification providers. Those build prompts only from source text, briefs and evidence.

## Mounting

Mount each credential file read-only, readable by the application user (uid 1000). For example, with synthetic names:

```yaml
services:
  indexer:
    user: "1000:1000"
    environment:
      ELASTICSEARCH_API_KEY_FILE: /run/secrets/elasticsearch_api_key
    volumes:
      - /path/on/host/elasticsearch_api_key:/run/secrets/elasticsearch_api_key:ro
```

Host files should be mode `0400` or `0440`, owned by an account the application user can read, and kept outside the repository and any build context.

## What keeps secrets out of artifacts

- **Git:** `.gitignore` excludes `.env*` (except `.env.example`), `secret.md`, `*.secret` and `secrets/`.
- **Docker build context:** `.dockerignore` is an allowlist, admitting only `package*.json`, `tsconfig.json` and `src/`.
- **Image contents:** `scripts/check-image-contents.sh` builds the image and verifies what's actually in it. It reports any `.env`, `secret.md`, `.git`, key or PEM file in the application and user locations.
