# Substack integration

## Separate reading and writing

Define application-owned interfaces for discovery, fetching original content, and destination publishing. Keep Substack-specific response shapes, authentication, and draft formats inside adapters. This allows replacement of a third-party client without changing the analysis pipeline.

RSS is the initial discovery mechanism. Fetching full posts, historical backfill, audio access, and authenticated content require separate validation.

## Publisher contract

The publisher accepts only a stored, verified article version. It checks publication eligibility, records intent, creates or reuses a draft, saves the destination ID, and (when publishing is enabled) publishes. A change to article content after verification invalidates that verification result.

The owner explicitly permits a separate draft-rehearsal authority: one mechanically valid revision with unresolved findings may be saved as an unpublished editable Substack draft, without email. Its exact body/metadata/package and assessment/judgment records remain pinned, and REVISE verdicts are preserved. This is not an editorial approval. The operator authority names exactly two dummy targets and one real draft target with an opaque configuration identity; default destinations refuse this authority unless they implement the explicit unpublished/no-email capability. Initial readback and uncertain-create reconciliation reject published or email-sent records. A cached receipt does not bypass target/capability checks. No public publish or email API is added.

Store the destination URL and publication timestamp after confirmation. Configure publishing frequency limits and a pause switch. Cookie or session expiry must produce a visible operational failure rather than repeated creation attempts. Subscriber email is off unless deliberately enabled.

## Live Substack publisher design (#256)

This section records the agreed design. It authorises no publication by itself. Implementation is #385, the one-draft live proof is #384, and the archive-to-Substack end-to-end run is #386.

### Decisions

| Decision       | Outcome                                                                                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Destination    | The owner's existing publication, configured privately as `<publication-origin>`. No publication URL, account or cookie appears in this repository, tickets, logs or fixtures.                                                                                          |
| Operating mode | **Draft-only.** The adapter creates an editable draft from the exact verified article and reads it back. A person reviews it and presses Publish. The adapter never calls publish, and subscriber email stays off. Automatic publication is a later, separate decision. |
| Credential     | The editor's `substack.sid` session cookie only, from a restricted runtime secret file (`STEELE_SUBSTACK_SESSION_FILE`). No password login.                                                                                                                             |
| Client         | Our own small client (four private web-API calls) behind the existing `DestinationAdapter`. No new runtime dependency. `substack-ts` and `unofficial-substack-sdk` are references only.                                                                                 |
| Content        | The exact verified Markdown from the approved-article event, converted once to Substack's ProseMirror document. Content is never regenerated at delivery.                                                                                                               |

### Why our own client

Substack has no official publishing API; every client uses the private web API the editor uses. `substack-ts` is the only library with full draft support, but it sends its cookie jar to every host, follows redirects, has no `AbortSignal`, puts raw response bodies in errors and offers password login. `unofficial-substack-sdk` is well engineered but supports Notes only. Four endpoints are small enough to own, and owning them lets us pin the cookie to one origin and keep responses out of logs.

### Shape

The Substack destination implements `DestinationAdapter` from `src/publishing/approved-article.ts` (#262) and runs as its own publisher service with its own durable consumer of `steele.v1.article.approved`, exactly like the dummy publishers.

- `render(article)` converts the verified Markdown to a ProseMirror `draft_body`, with a title, subtitle and byline, and returns a preview whose hash is the delivery fingerprint.
- `deliver(preview, key)` creates the draft, reads it back, checks that the stored title and body match the preview, and returns a receipt with the draft ID, the editor URL (private), `simulated: false` and `published: false`.
- `reconcile(key)` resolves an uncertain create (see below) before any retry.

### Web API calls (to `<publication-origin>` only)

| Step                 | Request                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who am I (preflight) | `GET /api/v1/user/self` or equivalent: confirms the session is valid without side effects                                                                  |
| Create draft         | `POST /api/v1/drafts` with `draft_title`, `draft_subtitle`, `draft_bylines` and `draft_body` (ProseMirror JSON as a string), audience `everyone`, no email |
| Read back            | `GET /api/v1/drafts/{id}`: title, body, `is_published` (must be false)                                                                                     |
| List recent drafts   | `GET /api/v1/drafts?limit=<n>` (reconciliation only)                                                                                                       |

Endpoint names are as observed in public clients and must be confirmed by #384 before they are relied on. Publish (`/prepublish`, `/publish`) is deliberately not implemented in the first milestone.

### Transport safety

- The cookie is sent only to the single configured HTTPS origin. Redirects are not followed; a redirect is treated as `auth-expired` (Substack redirects expired sessions to sign-in).
- Every call has a timeout and honours `AbortSignal`.
- Responses are validated with schemas. Only allowlisted fields (IDs, booleans, status codes) reach receipts or logs; never cookies, raw bodies or the publication origin.
- `401`/`403` or a sign-in redirect map to `auth-expired`; `429` to `rate-limited`; a timeout or connection loss after the create request was sent maps to `uncertain`.

### Uncertain creates and reconciliation

Substack drafts cannot carry our idempotency key, so a create whose response was lost must not simply be retried. The adapter records intent, with its time, before the create. On `uncertain`, reconciliation lists recent drafts and looks for one whose title equals the preview title and whose normalised body fingerprint equals the preview's:

- exactly one match: delivered (that draft's ID becomes the receipt);
- no match, **and** the listing authoritatively covers the attempt (it reaches drafts created before the recorded intent time, or it is the complete list): not delivered, safe to retry. A bounded listing that does not reach back past the intent time proves nothing, because newer drafts may have pushed the created one out of the page;
- the listing fails, does not cover the attempt, or several drafts match: `unknown`, which stops automatic retries and is shown as a failed delivery for an operator to reconcile.

### Formatting

The converter handles the article format the writer produces: headings, paragraphs, emphasis, links, numbered source lists, block quotes (including quotations of the original post and dated earlier passages from #370), and inline citation markers such as `[1]`. HTML in the Markdown is never passed through. Anything the converter cannot represent fails rendering, so a malformed draft is never created. A fixture of real verified articles from #244 is the test set.

### Session expiry

The editor session eventually expires. On `auth-expired` the publisher:

1. stops delivering for that destination (no repeated create attempts) and leaves the approval pending for this destination only;
2. logs a sanitised `publisher` milestone with outcome `auth-expired` (visible in Sentry Logs and local logs by correlation ID) and shows it on the dashboard's article trace;
3. resumes automatically once the owner replaces the session file, because the next delivery attempt re-reads it.

Refreshing the cookie is an owner task: sign in to Substack in a browser, copy the `substack.sid` value into the private session file on the deployment host, and keep it out of chat, tickets and logs.

### Proof sequence

1. #385: implement the adapter, converter and publisher service; test auth expiry, rate limiting, uncertain create and reconciliation against controlled responses; deploy with the session file mounted, consuming approvals but with live delivery switched off until #384.
2. #384: one live draft from a known verified revision: preflight, create, read back, compare; save the receipt and capture sanitised response shapes as fixtures; the owner confirms the draft.
3. #386: one archived post through the normal pipeline to an editable draft, without manual stage handoffs.

## Open integration risks

Session lifetime, endpoint changes, account challenges (captcha or new-device checks), formatting fidelity and draft reconciliation remain unproven until #384. If reconciliation cannot be made reliable, uncertain creates stay `unknown` for an operator rather than being retried, while ingestion, analysis and the dummy publishers continue.
