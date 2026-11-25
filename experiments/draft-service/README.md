# Shared draft service

This is the narrow publishing adapter shared by both tracks of the [n8n versus Mastra experiment](../../doc/experiments/n8n-vs-mastra.md) (#912). It creates **unpublished, editable Substack drafts, with no email**, and nothing else. There is no publish, schedule or send operation anywhere in the code.

It is a TypeScript service on Node 22 (run directly with type stripping, no build step). The Substack client and Markdown converter are reused from the archived implementation, with the publish call removed.

## API

Every route except `/health` and `/ready` needs `Authorization: Bearer <platform token>`. Each platform can only deliver and read its own requests.

| Route | Purpose |
|---|---|
| `POST /v1/drafts` | Deliver a request in the [contract shape](../../doc/experiments/n8n-vs-mastra.md#delivery-request-to-the-shared-draft-service-912) |
| `GET /v1/deliveries/<requestId>` | Status, with `?refresh=1` to reconcile a pending or uncertain delivery |
| `POST /v1/deliveries/<requestId>/reconcile` | Reconcile now |
| `POST /v1/deliveries/<requestId>/allow-recreate` | Explicit operator recovery for an `uncertain` delivery with no matching draft |
| `GET /v1/deliveries?limit=` | The caller's recent deliveries (at most 100) |
| `GET /v1/preflight` | Read-only check of destination access, which lists one draft and creates nothing |
| `GET /health`, `GET /ready` | Liveness; readiness of storage and configuration |

The `status` field and HTTP code of each response:

| Status | HTTP | Meaning |
|---|---|---|
| `created` | 201 | A new draft was created and read back as unpublished, with no email |
| `existing` | 200 | Same ID and same payload: the existing draft is returned |
| `conflict` | 409 | Same ID with a different payload |
| `uncertain` | 503 | Possibly created, and not settled. Retrying the request only reconciles; it never creates blindly |
| `failed` | 502 | The destination definitely did not create a draft, so a retry may create one |
| `invalid` | 400 | Validation failed; field issues are included |
| `forbidden` | 403 | The request belongs to another platform |

## Guarantees

- **Intent before create.** The intent is stored durably before any create call. The SQLite store is owned only by `DeliveryStore`.
- **Reconciling unclear outcomes.** A lost response, a crash, or a pending record found after restart is reconciled. The service lists recent drafts and matches the unique labelled title, `[exp-911 <platform> <attempt>] …`.
  - Exactly one match: the draft is confirmed.
  - No match: the delivery stays `uncertain` until an operator explicitly allows a new create.
  - More than one match: it stays `uncertain`.
- **Readback.** A draft only counts as delivered after readback shows the expected title, unpublished, with no email sent.
- **Configuration.** It is re-read on every request: the platform token hashes, the destination, and the session cookie file. The session stays in canonical private configuration, mounted read-only.
- **Platform tokens.** The service stores only their SHA-256 hashes; each platform holds its own token.
- **Logs and responses.** Logs record only the method, path, platform, status, outcome and duration. Responses never contain credentials, paths or upstream bodies.

## Configuration

These are set in the environment, using values from private configuration:
- `STEELE_DRAFT_DB`
- `STEELE_DRAFT_CLIENTS_FILE`
- `STEELE_DRAFT_DESTINATION` (`substack` or `fake`)
- `STEELE_DRAFT_SUBSTACK_ORIGIN`
- `STEELE_DRAFT_SUBSTACK_SESSION_FILE`
- `STEELE_DRAFT_FAKE_FILE`
- `HOST` and `PORT`

See `src/main.ts`, `deploy/compose.yaml` (placeholders only) and `deploy/deploy.sh`.

## Tests

```bash
npm ci
npm test
```

The suite uses the file-backed fake destination and covers:
- formatting;
- validation, including refusal of unknown fields such as `publish`;
- cross-platform access;
- repeated, concurrent and changed-payload requests;
- a lost response after creation;
- a definite failure, then a retry;
- a crash after external creation, recovered across a restart;
- `uncertain` recovery that needs an explicit operator action;
- a readback showing a published draft;
- HTTP authentication, readiness, and delivery across a process restart.
