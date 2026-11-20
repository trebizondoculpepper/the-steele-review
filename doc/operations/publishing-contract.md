# Multi-destination publishing contract

One approved article feeds any number of independent destinations (#262). Live destination adapters and their credentials are follow-ups (for example Substack, #256); approval makes an article eligible for a destination's configured action, and public delivery needs separate authorization.

## The approved-article event

`recordApproval` (in `src/publishing/approved-article.ts`) takes a saved package verification report (#150). If it approves exactly the stored draft bytes, it records one `steele.v1.article.approved` event (`org.steele.article.approved.v1`, on the `STEELE_PUBLICATION` stream) in the state controller's outbox, keyed by the draft revision. The event carries only immutable references: the draft, the approval report and the evidence package, plus the approval time. Its ID is derived from the draft and approval, so recording again is a no-op and a restart between approval and delivery cannot lose the handoff.

### Event contract

Registered in `src/events/registry.ts` under the messaging standard (`doc/architecture/20-messaging-contract.md`, #273). The runtime schema is `ArticleApprovedDataSchema` in `src/events/article-approved-event.ts`; a test checks that this table lists exactly its fields.

| Field | Type | Meaning |
| --- | --- | --- |
| `publicationId` | slug | Publication of the source post. |
| `postId` | slug | Source post within that publication. |
| `draft` | artifact reference | The exact approved Markdown draft revision (repository, commit, path, `sha256:` hash). |
| `approval` | artifact reference | The package verification report that approved exactly that draft. |
| `package` | artifact reference | The evidence (writer) package the draft was written from. |
| `approvedAt` | ISO 8601 date-time | The verifier's `verifiedAt`: when the approving verification ran, not when the event was recorded. It is fixed by the report, so re-recording the same approval yields the same event. Destination schedules count from it. |

**Envelope:** CloudEvents 1.0; type `org.steele.article.approved.v1`; dataschema `urn:steele:schema:article-approved:v1`; source `urn:steele:publishing:approval`; subject `article/<publicationId>/<postId>`, which consumers check against the data; `time` equals `approvedAt`.

**Identity:** the event ID is `approvedArticleEventId(draft, approval)`, a hash of the exact draft and approval references. A different draft revision or a different approving report is a different event; the same pair is always the same event, and JetStream deduplicates it.

**Emission condition:** only `recordApproval`, and only when the report's outcome is `approved`, its draft reference matches, and `approvalValidFor` confirms the approval covers the stored draft bytes. A rejected or unresolved verification emits nothing. The event goes into the outbox in the same step as the approval record.

**Replay guarantees:** recording again is a no-op with the same ID. Consumers re-read the draft and report by reference (hash-verified) and re-check the approval before acting, so a stale or tampered event is terminated rather than delivered. The original post URL is not part of this event; it belongs to the pinned writer package (#276).

## Destination consumers

Each destination runs its own durable consumer and calls `handleApprovedArticle` with its adapter and schedule:

- It re-reads the draft and approval report from the artifact store and refuses the event (`term`) unless the approval matches those exact bytes.
- It waits for its own schedule (`delayMs` after approval) by asking for redelivery.
- It keeps its own intent, status and receipt under the key `publish:<destination>:<action>:<revision>`, so one destination's failure or retry never touches another's.
- It saves a preview (`publications/<destination>/<action>/<publication>/<post>/<revision>/preview.json`) before delivery and a receipt (`receipt.json`) after. Duplicate delivery reuses the saved receipt.
- A delivery whose outcome is unknown is recorded with an `uncertain.json` marker; the next attempt asks the adapter to reconcile before sending again, so an uncertain delivery is never repeated blindly.

Adapters implement `DestinationAdapter`: `render` (own format and capabilities), idempotent `deliver`, and `reconcile`. `SimulatedDestination` is the placeholder used for the end-to-end proof: it makes no external call and needs no credentials, and its receipt is marked `simulated: true`, which is the terminal publishing result for that test.
