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
