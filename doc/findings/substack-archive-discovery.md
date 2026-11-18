# Substack historical discovery: coverage and access findings

Investigation for issue #8, measured on 2026-11-18 against the initial public source named in that issue. Counts describe that publication on that date and will change.

## Enumeration method

The public archive listing at `<publication>/api/v1/archive` returns posts newest first as `{ posts: [...], nextCursor }`. It is an observed web endpoint, not a documented API, so `SubstackArchiveDiscovery` validates every page and treats an unexpected shape as incomplete enumeration.

| Parameter  | Observed behaviour                                                                   |
| ---------- | ------------------------------------------------------------------------------------ |
| `sort=new` | Newest first.                                                                        |
| `limit`    | Accepted up to 25. Values of 50 are rejected with HTTP 400.                          |
| `offset`   | Rejected with HTTP 400, including `offset=0`. Offset pagination is not available.    |
| `cursor`   | Opaque token from the previous page's `nextCursor`. The last page returns no cursor. |

No authentication, cookies or browser automation were needed.

## Coverage

A full walk at 25 per page with a one-second interval took 23 pages and returned 553 unique posts, with no repeated items or cursors. The oldest post was dated 2023-07-25, which suggests the listing reaches the start of the publication.

The RSS feed returned only the 20 most recent entries. RSS therefore cannot serve as a backfill source, which confirms the ticket's warning.

Of the 553 posts, 532 were `podcast` and 21 `newsletter`; 531 had audience `everyone` and 22 `only_paid`. Paid-only posts still appear in the listing with public metadata (title, URL, date). Their bodies and media are presumably restricted; this has not been tested.

## Identity

Archive entries carry a numeric `id`, a `slug` and a `canonical_url`. The slug matches the `/p/<slug>` path used by RSS `link` and `guid`, so `postId` = slug gives the same content key from both sources. The numeric ID does not appear in RSS and is not used as identity.

## Supplied transcripts (finding for later collection)

Each archive entry's `podcastUpload` and `videoUpload` objects can include a `transcription` record. In the newest 25 posts, 23 had a podcast transcription with status `transcribed`, and none had a video transcription. Substack-generated transcripts may therefore be retrievable without local transcription. How to fetch the transcript text, and whether access is permitted, was not tested and belongs to the content-acquisition work (#15, #16). This controller does not download or record them.

## Limitations

- The endpoint is undocumented and may change or be rate limited without notice. The controller paces requests (one second by default), caps the number of pages, retries transient failures a bounded number of times, and reports any stop other than exhaustion or a configured bound as `IncompleteEnumerationError`.
- Enumeration is not a snapshot. Posts published or deleted during a walk can shift page boundaries. Repeated items are suppressed, and a repeated cursor ends the run as incomplete.
- Date bounds rely on the archive's `post_date` order. An undated entry inside a date-bounded run is skipped and reported.
