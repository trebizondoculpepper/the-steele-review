# Multi-destination publishing contract

One approved article feeds any number of independent destinations (#262). Live destination adapters and their credentials are follow-ups (for example Substack, #256); approval makes an article eligible for a destination's configured action, and public delivery needs separate authorization.

## The approved-article event

`recordApproval` (in `src/publishing/approved-article.ts`) takes a saved package verification report (#150). If it approves exactly the stored draft bytes, it records one `steele.v1.article.approved` event (`org.steele.article.approved.v1`, on the `STEELE_PUBLICATION` stream) in the state controller's outbox, keyed by the draft revision. The event carries only immutable references: the draft, the approval report and the evidence package, plus the approval time. Its ID is derived from the draft and approval, so recording again is a no-op and a restart between approval and delivery cannot lose the handoff.

## Destination consumers

Each destination runs its own durable consumer and calls `handleApprovedArticle` with its adapter and schedule:

- It re-reads the draft and approval report from the artifact store and refuses the event (`term`) unless the approval matches those exact bytes.
- It waits for its own schedule (`delayMs` after approval) by asking for redelivery.
- It keeps its own intent, status and receipt under the key `publish:<destination>:<action>:<revision>`, so one destination's failure or retry never touches another's.
- It saves a preview (`publications/<destination>/<action>/<publication>/<post>/<revision>/preview.json`) before delivery and a receipt (`receipt.json`) after. Duplicate delivery reuses the saved receipt.
- A delivery whose outcome is unknown is recorded with an `uncertain.json` marker; the next attempt asks the adapter to reconcile before sending again, so an uncertain delivery is never repeated blindly.

Adapters implement `DestinationAdapter`: `render` (own format and capabilities), idempotent `deliver`, and `reconcile`. `SimulatedDestination` is the placeholder used for the end-to-end proof: it makes no external call and needs no credentials, and its receipt is marked `simulated: true`, which is the terminal publishing result for that test.
