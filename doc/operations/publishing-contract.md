# Multi-destination publishing contract

One approved article feeds any number of independent destinations (#262). Live destination adapters and their credentials are follow-ups (for example Substack, #256); approval makes an article eligible for a destination's configured action, and public delivery needs separate authorization.

## The approved-article event

`recordApproval` (in `src/publishing/approved-article.ts`) takes a saved package verification report (#150). If it approves exactly the stored draft bytes, it records one `steele.v1.article.approved` event (`org.steele.article.approved.v1`, on the `STEELE_PUBLICATION` stream) in the state controller's outbox, keyed by the draft revision. The event carries only immutable references: the draft, the approval report and the evidence package, plus the approval time. Its ID is derived from the draft and approval, so recording again is a no-op and a restart between approval and delivery cannot lose the handoff.

### Event contract

Registered in `src/events/registry.ts` under the messaging standard (`doc/architecture/20-messaging-contract.md`, #273). The runtime schema is `ArticleApprovedDataSchema` in `src/events/article-approved-event.ts`; a test checks that this table lists exactly its fields.

| Field                  | Type                                                                                     | Meaning                                                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publicationId`        | slug                                                                                     | Publication of the source post.                                                                                                                                                                                             |
| `postId`               | slug                                                                                     | Source post within that publication.                                                                                                                                                                                        |
| `draft`                | artifact reference                                                                       | The exact approved Markdown draft revision (repository, commit, path, `sha256:` hash).                                                                                                                                      |
| `approval`             | artifact reference                                                                       | The package verification report that approved exactly that draft.                                                                                                                                                           |
| `approvalKind`         | optional enum: `combined-verification`, `editorial-judgment`, or `owner-draft-rehearsal` | Exact-version authority; the owner kind is draft-only and never asserts factual approval. Absent only on legacy combined-verifier events.                                                                                   |
| `authorizationOutcome` | V2 literal `owner-authorized-draft`                                                      | Honest owner rehearsal outcome; absent from all V1 verification events.                                                                                                                                                     |
| `draftTargets`         | V2 ordered tuple                                                                         | Exactly dummy-a, dummy-b, then one Substack draft target; each pins an opaque identity and unpublished/no-email capability.                                                                                                 |
| `assessment`           | optional artifact reference                                                              | The saved assessor record when approval came from an editorial judgment; never a fabricated combined-verification report.                                                                                                   |
| `publication`          | optional artifact reference                                                              | Exact versioned metadata/body payload for v2 verification; absent only on legacy body-only approvals.                                                                                                                       |
| `package`              | artifact reference                                                                       | The evidence (writer) package the draft was written from.                                                                                                                                                                   |
| `approvedAt`           | ISO 8601 date-time                                                                       | The verifier's `verifiedAt`: when the approving verification ran, not when the event was recorded. It is fixed by the report, so re-recording the same approval yields the same event. Destination schedules count from it. |

**Envelope:** CloudEvents 1.0; type `org.steele.article.approved.v1`; dataschema `urn:steele:schema:article-approved:v1`; source `urn:steele:publishing:approval`; subject `article/<publicationId>/<postId>`, which consumers check against the data; `time` equals `approvedAt`.

Owner rehearsals use a separate V2 envelope: type `org.steele.article.draft-authorized.v2`, dataschema `urn:steele:schema:article-draft-authorized:v2`, source `urn:steele:publishing:owner-draft`. The existing publication subject/stream is unchanged. The legacy `approvedAt` field means the explicit authorization time in V2, not verification. Both data schemas export from the runtime definitions; a V2 authority cannot be inserted into a V1 envelope. Deploy V2-capable dummy-a, dummy-b and the selected one-event operator before emitting V2; continuous real publishing remains off. Older V1-only consumers must not receive this new mode as though it were a legacy approval.

**Identity:** the event ID is `approvedArticleEventId(draft, approval)`, a hash of the exact draft and approval references. A different draft revision or a different approving report is a different event; the same pair is always the same event, and JetStream deduplicates it.

**Emission condition:** only `recordApproval`, and only when the report's outcome is `approved`, its draft reference matches, and `approvalValidFor` confirms the approval covers the stored draft bytes. A rejected or unresolved verification emits nothing. The event goes into the outbox in the same step as the approval record.

For the explicit V2 exception, `authorizeOwnerDraftRehearsal` independently validates the exact retained one-revision result, mechanical record, accepted writer bytes, metadata, package and complete assessment/judgment chain. Its operator request acknowledges remaining findings. It never calls a model or changes a REVISE record. A typed state binding rejects changed-input retries and competing requests for the same version; authorization completion and pending event are atomic. Delivery re-reads that durable authority and pins the same discriminator into intent, preview and receipt. Missing authority, substituted target scope and incompatible/public/email actions fail closed, including receipt reuse and original-intent reconciliation. The resulting status is owner-authorized draft delivery, not verified.

**Replay guarantees:** recording again is a no-op with the same ID. Consumers re-read the draft and report by reference (hash-verified) and re-check the approval before acting, so a stale or tampered event is terminated rather than delivered. The original post URL is not part of this event; it belongs to the pinned writer package (#276).

## Destination consumers

Each destination runs its own durable consumer and calls `handleApprovedArticle` with its adapter and schedule:

- It re-reads the draft and approval report from the artifact store and refuses the event (`term`) unless the approval matches those exact bytes.
- It waits for its own schedule (`delayMs` after approval) by asking for redelivery.
- It keeps its own intent, status and receipt under the key `publish:<destination>:<action>:<revision>`, so one destination's failure or retry never touches another's.
- It saves a preview (`publications/<destination>/<action>/<publication>/<post>/<revision>/preview.json`) before delivery and a receipt (`receipt.json`) after. Duplicate delivery reuses the saved receipt.
- Intent records retain the original approved artifact references before any external attempt. Retries reuse the saved adapter preview, including its configured byline; a later approval of identical content cannot replace the original manifest or attribute its delivery to a newer provenance lineage. Legacy structured intents without an authoritative original manifest remain on operational hold.
- A delivery whose outcome is unknown is recorded with an `uncertain.json` marker; the next attempt asks the adapter to reconcile before sending again, so an uncertain delivery is never repeated blindly.

Adapters implement `DestinationAdapter`: `render` (own format and capabilities), idempotent `deliver`, and `reconcile`. `SimulatedDestination` is the placeholder used for the end-to-end proof: it makes no external call and needs no credentials, and its receipt is marked `simulated: true`, which is the terminal publishing result for that test.

## Approval outbox dispatch (#271)

`dispatchApprovedArticles` (`src/publishing/approval-dispatch.ts`) is the one path from a recorded approval to the publisher stream. It publishes every due `steele.v1.article.approved` outbox event from the state controller with its event ID as the JetStream message ID, marks it sent, and leaves a failed publish pending with the same ID for a later retry. Destinations consume only the stream. A production entry point (a periodic dispatch beside the article worker) belongs to #244.

`test/workflow/two-sources-two-publishers.test.ts` proves the whole chain against real NATS and Restate containers with deterministic models:

- a Substack source and a non-Substack fixture source each emit one captured-content event;
- the bridge submits both to `ArticleRun`, and both drafts are verified;
- the dispatcher publishes both approvals;
- two independent simulated destinations each save a receipt per approved revision, one of them after a failed first attempt;
- replaying a captured event and an approval event creates no new draft or delivery.

## Exact publication payloads (#457)

New verification reports use schema v2 and pin a schema-v1 manifest under `publication-payloads/<publication>/<post>/`. The manifest uses canonical JSON bytes and carries exact metadata and body artifact references plus a validated reader-visible `contentHash` and either the saved `fields` (`structured`) or an explicit `legacy-body-only` mode. The independent verifier receives title, subtitle and excerpt alongside the same body and pinned evidence; a body-only approval never approves fields attached later. Model verification remains distinct from any manual editorial decision.

Approval events carry the optional `publication` reference. Publishers read and validate those pinned artifacts again, check the report binds that complete payload, and pass the saved fields/references unchanged to the adapter. For payload-aware events, delivery operation keys, artifact directories and receipt `publicationHash` use a canonical reader-visible content hash (title, subtitle, excerpt and body hash) (truncated only in the directory/key segment), while `draftHash` still records the body. A title-only change therefore cannot reuse an older approval or receipt. Exact manifest references remain the approval identity; changing only provenance still requires its own verification, while identical reader-visible bytes reuse the existing delivery receipt within that destination/action. The receipt retains the manifest actually delivered rather than relabelling it with newer provenance. Legacy events retain their body-only behavior and cannot acquire generated fields.

Adapters must opt into `supportsPublicationPayload` before structured delivery. Without that capability the publisher returns `unsupported-payload`, makes no external attempt and spends no attempt budget. After an adapter upgrade, the same event/key resumes normally, including reconciliation of any existing intent. Substack mapping is a separate change (#458); this contract does not enable it. Deploy payload-aware consumers before enabling new payload-producing workers; older strict event readers do not understand the added reference. No feature deployment is performed by this contract change.

The read-only draft inventory binds status and receipts to the exact metadata/body association, displays all saved generated fields as escaped text, and labels legacy verification explicitly as body-only. Equal body bytes with different titles never share full-payload approval status or receipts.

Manual decision records from #447 remain body-only. This change does not apply those dispositions to generated metadata. Full-payload manual targets and action integration are tracked in #449, after atomic claim-owned state completion is corrected; no manual approval is fabricated here.
