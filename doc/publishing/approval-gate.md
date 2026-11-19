# Publication approval gate

`src/publishing/approval.ts` checks that exactly the approved draft is about to be published. It isn't another editorial review: the model verification (#43) is not repeated.

## Step 1: `parsePublishRequest(event, { destination, allowBackfill? })`

A pure check of the trusted verifier's `org.steele.draft.verified.v1` event: its shape, and a subject that matches the post. An approval becomes an immutable publish request keyed by destination, approved repository, commit and path. Article bytes aren't loaded here.

Typed rejections:

- `malformed-event`
- `not-approved`: a redraft or a skip.
- `backfill-disabled`: backfill publication is off unless explicitly enabled.

## Step 2: `verifyApprovedArtifact(request, artifacts)`

The publisher calls this after claiming the request's key. It reads the exact committed draft and verification report through the archive, which checks hashes, and confirms the report approves exactly this draft: same hash, path and commit.

Typed rejections:

- `tampered-content`
- `missing-artifact`
- `stale-approval`: the approval was for a different draft. A changed draft never inherits an earlier approval.
- `not-approved`
- `archive-unavailable`: retryable.

No Substack or state-store access happens in either step.

# Publisher worker

`PublisherWorker` (`src/publishing/publisher-worker.ts`) is the thin consumer of approved-artifact (`draft.verified`) events. It wires the gate above to the publication state (#67), the destination adapter (#45) and reconciliation (#68), and holds no state transitions of its own.

## Sequence

1. **Validate** the trusted approval (`parsePublishRequest`). Non-approvals and backfill are acknowledged without publishing; malformed input is terminated.
2. **Pause switch:** while `paused()` is true, nothing is claimed or published and the message is redelivered.
3. **Publication state:**
   - Already published: returns the stored receipt.
   - Uncertain: settled by read-back (`reconcileUncertainPublication`).
4. **Frequency limit:** `minIntervalMs` between publications to the destination, computed from durable receipts.
5. **Claim and check:** claim the publication key, then load and check the exact approved artifact (`verifyApprovedArtifact`).
6. **Publish:** record intent, reuse the saved destination draft or create one, then publish with subscriber email off.
7. **Confirm:** record the receipt and complete with an `org.steele.article.published.v1` handoff, then acknowledge.

## Failures

- **Lost publish response:** recorded as uncertain and settled by read-back on the next delivery, so there's no second draft or publication.
- **Uncertain draft creation:** the destination has no idempotency key, so this is a visible permanent failure for an operator, not a blind retry.
- **Other errors:** retryable destination errors redeliver; permanent ones are recorded and acknowledged.

No live destination is configured here; tests use the controlled client.
