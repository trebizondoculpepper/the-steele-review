# n8n experiment track

The n8n half of the clean-slate n8n versus Mastra comparison. The contract is `doc/experiments/n8n-vs-mastra.md`; shared prompts, schemas and fixtures are in `experiments/shared/`.

## Layout

- `deploy/compose.yaml`: the separately named stack `steele-exp-n8n`. n8n is pinned by version and digest (2.49.7, multi-arch, runs on linux/arm64). Every host-specific value comes from the host's private `stack.env`.
- `deploy/deploy.sh`: copies only Git-tracked files to the host, starts or updates the stack, then imports every workflow in `workflows/` with n8n's own CLI.
- `test/`: static checks of the workflow definitions. Run `node --test experiments/n8n/test/*.test.ts` before deploying. They check that Code nodes parse, connections and published IDs are valid, and no private addresses or passwords appear.
- `workflows/`: workflow definitions, one JSON file each, with stable IDs, so a re-import updates a workflow rather than duplicating it. These files are the source of truth. Canvas edits that are not exported back to Git are lost on the next deploy.

## Feed discovery (#914)

The rules are the same as the Mastra track's (#919). The state lives in the `steele_feed` schema of the experiment database (`sql/001-feed.sql`). One atomic PostgreSQL function owns each transition.

| Workflow | Trigger | What it does |
|---|---|---|
| `Feed: poll Save Us Now RSS` (`SteeleExpFeedPoll1`) | Schedule, every 15 min | Fetches the public feed, with no redirects and a 20 s timeout, and hands it to ingest. |
| `Feed: ingest one observation` (`SteeleExpFeedIngst`) | Sub-workflow | Checks the response (HTTP 200, non-empty, 5 MB or less), parses the XML and normalises each item. It then records the result atomically, or records the failure and ends the run in error. |
| `Feed: select one post for capture` (`SteeleExpFeedSelct`) | `POST /webhook/steele-exp/feed/select` `{"url": ...}` | The manual and agent path: queues one post on the publication, such as an older one. It fetches nothing. |
| `Feed: status` (`SteeleExpFeedStats`) | `GET /webhook/steele-exp/feed/status` | Read-only. Returns the last poll, the last failure, counts, the capture queue and recent items. |
| `Feed: ingest a test fixture` (`SteeleExpFeedFixtr`) | `POST /webhook/steele-exp/feed/fixture` `{"subscription":"fixture-…","xml":...}` | Runs the same ingest under an isolated `fixture-*` subscription, so tests never touch the real feed's state. |

- **Baseline:** the first successful poll of a subscription is its baseline. Every item then present is stored as `baseline` and nothing is queued.
- **New and edited items:** after the baseline, a new item is queued for capture (`needs_capture`). An item whose metadata fingerprint changes is queued again, and its `change_count` goes up.
- **Unchanged feed:** an unchanged feed only refreshes `last_seen_at`, and a repeated poll ID is a no-op.
- **Overlapping polls:** an advisory lock means two overlapping polls can't both take the baseline.
- **Identity:** each item is identified by its canonical URL, `https://<publication>/p/<slug>`. The numeric post ID and `substack:<publication>:<id>` are recorded when the feed reveals them; audio enclosures reveal them. Capture (#915) pins the definitive ID.
- **Inspection:** every poll is visible in two places:
  - in n8n's execution history, with each node's input, output and error;
  - as a row in `steele_feed.polls`, with outcome, counts and error.
- **Access:** the webhooks are unauthenticated. Like the interface, they are reachable only on the private network (#930).

## Retained source versions (#915)

These follow the contract's canonical `source-bundle-v1` and the required operations (`doc/experiments/n8n-vs-mastra.md`). The state is in the `steele_src` schema (`sql/002-sources.sql`).

- **Immutable rows:** a version row is never updated or deleted, and database triggers enforce this. A second trigger checks that the stored bytes hash to the stored `sha256`, and the version ID must equal `<item>@sha256:<sha256>`. Capturing identical content again reuses the version and counts the observation.
- **Store column:** `store` separates the live store from isolated `fixture-*` test stores.
- **Signed transcript link:** it is used for exactly one request inside the `Fetch post` Code node, through `this.helpers.httpRequest`. Nothing that node outputs contains it, so neither n8n's execution history nor the retained post JSON does; signed URLs are replaced with `[signed-url-removed]`.

| Operation | How |
|---|---|
| `capture` | `POST /webhook/steele-exp/sources/capture` `{"url": ...}`. Also runs every 15 min for items queued by discovery: up to 3, untried items first, then the least recently tried, so a failing item can't starve later ones. Permanent failures leave the queue with their reason. A temporary failure is retried at most 5 times, then the item leaves the queue as `retries-exhausted: <last error>`; the feed status lists these under `captureFailures`. A later edit or a manual selection queues the item again with a fresh budget. |
| `listItems`, `listVersions`, `readVersion`, `exportVersion` | `POST /webhook/steele-exp/sources/browse` `{"op": ..., "item"/"version"/"limit"/"offset": ...}`. Reads come from storage only and are re-verified against the version ID. |
| `importVersion` | `POST /webhook/steele-exp/sources/import` `{"export": ...}`. Rejected unless the canonical bytes reproduce the version ID. |
| load for writing | Sub-workflow `SteeleExpSrcLoad01`: the writer's first step (#916) loads a pinned version, which may be an older one, from storage, verified, without refetching. `POST /webhook/steele-exp/sources/load` shows exactly what that step receives. |

- **How usable text is obtained:** the supplied transcript is used when the post's upload has `transcription.status = "transcribed"`. Otherwise it is the plain text of `body_html`, with the warning `text-is-article-description-not-transcript` for audio and video. With neither, the text is empty and the warning is `no-usable-text`. There is no paid transcription.
- **Fetch failures and evidence findings:** fetch failures (`post-not-found`, `restricted`, `post-unavailable` and so on) save nothing and return an error code. Evidence findings are warnings stored with the version.
- **Article HTML:** the Mastra track converts article HTML with the `html-to-text` library, and n8n uses a small converter in the Code node. So article-only posts can differ in whitespace between the platforms. The pinned comparison post uses its transcript, and #923 starts both platforms from one exported version anyway.

## Storage and state

- Workflows, credentials, run history (inputs, outputs and errors of every execution, kept for 14 days) and users live in a dedicated PostgreSQL database and restricted role on the existing PostgreSQL service. That role cannot connect to any other database.
- n8n's local directory (`data/` on the host) holds its config and binary data.
- The encryption key and database password are files in the host's private `secrets/`, mounted read-only and passed with n8n's `_FILE` variables. They are never baked into an image or copied into workflow JSON.

## Access

- Bound to the private network only. Nothing is exposed on the LAN or the internet.
- n8n has no supported way to switch off its login: the variable that did this was removed in n8n 1.0. The instance owner is therefore provisioned from the environment (`N8N_INSTANCE_OWNER_*`, a bcrypt hash only), and the owner signs in once per browser. See #930.

## Operations

Deploy or update from a checkout:

```sh
STEELE_EXP_HOST=<host> STEELE_EXP_DIR=<stack dir> experiments/n8n/deploy/deploy.sh
```

- **Start or stop:** on the host, run `docker compose --env-file stack.env -f src/n8n/deploy/compose.yaml start` (or `stop`).
- **Update n8n:** change the pinned tag and digest in `compose.yaml` in a reviewed PR, then deploy. Back up the database first, because n8n migrates its schema on startup.
- **Rollback:**
  1. Stop n8n.
  2. If the update ran a schema migration, restore the pre-update database backup while n8n stays stopped.
  3. Revert the pin and redeploy.
- **Workflow from the command line:** run these on the host, inside the container: `docker compose ... exec -T -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n <command> </dev/null`.
  - Commands: `execute --id <id>`, `export:workflow --id <id>`, `list:workflow`.
  - The CLI starts a second n8n process, so it needs its own task-broker port. Without `</dev/null`, `exec` swallows the rest of a piped script.
- **Inspection:** n8n's public API (`/api/v1/workflows`, `/api/v1/executions?includeData=true`) with a read-only scoped API key. The key is kept in the host's private secrets. Execution records show each node's inputs, outputs and errors.

## Source evidence (#915, 2026-11-26)

- **Contract tests** (`test/sources.test.ts`): the Code nodes' own JavaScript, taken from the Git-defined workflows, turns a synthetic post and its transcript into the shared `source-bundle-v1` fixture byte for byte, with hash `a1a937de…`. A tampered byte is rejected.
- **Fixture store `fixture-s1`:**
  1. Captured version 1, then an edited version 2, then version 1 again, which was reused with 2 observations.
  2. Restarted n8n.
  3. `listItems` and `listVersions` showed both versions, and `readVersion` returned both texts verified.
  4. Loading the older version returned its exact original text.
  5. Its export was imported into another store under the same ID; a tampered export was refused (400 `hash-mismatch`). A missing version returned 404.
  6. A restricted post was refused with 422 `restricted`, and nothing was saved.
- **Pinned comparison post 226395148**, captured live in n8n: `substack:saveusnow:226395148@sha256:440cb7fd…2d9b`, from the supplied transcript, 12,358 characters, no warnings. This is **identical to the version the Mastra track captured**, so both platforms derive the same ID from the same content.
- **Signed links:** none in any stored execution of the live capture (11 executions scanned).

## Feed evidence (#914, 2026-11-26, fixture subscription `fixture-t2`)

1. **Baseline:** 2 items, 0 queued.
2. **Unchanged:** 0 new, 0 changed.
3. **New and edited:** 1 new (`gamma`) and 1 changed (`alpha`), both queued.
4. **Unchanged again:** 0 new, 0 changed.
5. **Malformed XML:** a failed poll, `invalid-feed: not an RSS channel`.
6. **Link from another host:** a failed poll, `wrong-publication`.
7. **HTTP 503:** a failed poll, `feed-unavailable`.
8. **Selection:**
   - Selecting `…/p/older-post?utm_source=x` stores the canonical URL and queues it.
   - A URL with userinfo pointing at another host is rejected with 400.
   - Selecting a known item marks it `selected` and queues it again.

Real feed: the scheduled poll `n8n-265` (12:49 UTC) took the baseline of 20 items, all marked `baseline` and none queued. The feed was read only; no posts were fetched.

## Setup evidence (#913, 2026-11-26)

- `SteeleExpSmoke01` was created from Git, executed, changed in Git (`revision: 2`), redeployed and executed again. Its output was read back through the API.
- `SteeleExpError01` fails on purpose. Its execution is recorded as `error`, with the node's message, and the CLI exits with 1.
- Run history survived a container restart.
- The interface answers only on the private-network address; the LAN address does not answer.
- About 410 MB RSS when idle.
- Note: n8n 2.49 warns that PostgreSQL 16 gets compatibility support only and recommends 17 or newer.

Actual hosts, addresses and credentials are recorded in the private operations project, not here.
