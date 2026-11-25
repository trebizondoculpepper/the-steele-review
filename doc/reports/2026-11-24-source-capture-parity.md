# Source capture parity: existing collector vs composable block (#868)

Date: 2026-11-24. Test: `test/capture/parity.test.ts`.

Both paths ran on identical synthetic inputs, each in its own isolated archive and state database: the existing `CollectionWorker` (old) and `captureSource` from #865 (new). For each source-ready event, the test compares the item, text, supplied HTML, preview image (including the retained image path), text method, and every event field except the saved file's path, hash and the event ID derived from them. It then passes both sets of events through the capture bridge.

## Equivalent
| Case | Result |
|---|---|
| New source | Same captured text, supplied HTML, item fields and method. Same retained preview image, at the same content-addressed path. Same event fields. |
| Unchanged refetch | Neither path makes a new commit or a second event. |
| Missing optional image | Both save the source, keep the image URL, and record no retained copy. |
| Save, then publish failure | Both recover the announcement from their durable outbox and end with exactly one event. |
| Downstream | The bridge submits the same ArticleRun keys for both paths' events. |

## Intentional differences
1. **File name.** The new block saves `substack/<pub>/<post>/source.json`. The old path saves `collected.json` in the same directory. Because the event ID is derived from the saved file's path and hash, the two paths' event IDs differ. Each path's own ID stays stable across retries and resends.
2. **Edits.** The old collector does not refetch an already collected post on rediscovery; only a deliberate reingestion revises it, and that is announced as `reprocess`. The new block revises the same stable file when a refetch finds changed content, and announces it with the capture's own reason (`live`). The revised records themselves are identical.
3. **Recovery timing.** The old worker retries a failed publish within the same handling call. The new block leaves it pending in the outbox and sends it before the next capture of that source, or through `dispatchPendingSources`.
4. **Automatic run admission (owner-approved, #874).** A new publisher post ID is admitted. A text edit to an admitted post ID is acknowledged as `already-admitted` and starts no second run. An explicit rerun, retried twice, records one attempt that pins the exact source revision. The admitted revision stays the original one.

The parity test includes an explicit resend on the new path, which keeps the same event identity and causes no second delivery.
