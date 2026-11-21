# Retained image annotations

Design for #310, following the owner's on-demand classification decision.
Classification is an optional enrichment after capture. Neither image capture
nor article delivery waits for an annotation, and this design does not enable
archive backfill or paid calls.

## Input and retention prerequisite

The current `previewImage` contract records a source URL and kind, not retained
image bytes. #277's URL reference alone therefore cannot satisfy this stage.
Before implementation, retain a bounded image through a typed image-storage
adapter and record an immutable manifest/reference and SHA-256 of those bytes.
Binary storage stays separate from the text-only Git artifact API; a manifest
can live in Git. No new network service is required by this design.

Fetch only through an adapter with public-destination/redirect checks, bounded
response size and timeout, allowed image formats and decoded pixel limits.
Verify the saved bytes against their hash before inference. Classify the saved
version, never fetch the source URL afresh during classification. Keep the
original source URL and any supplied alt text as source metadata; never replace
alt text with generated labels. Missing alt text stays missing.

## Small classification contract

One request identifies the saved image and classification prompt/model version.
One validated annotation contains:

| Field | Meaning |
| --- | --- |
| `subject` | `person`, `text-slide`, `screenshot`, `document`, `photo-scene`, `graphic`, `other`, or `uncertain` |
| `containsText` | `yes`, `no`, or `uncertain`; useful for a later OCR request |
| `sensitivity` | `none-detected`, `graphic`, `explicit`, or `uncertain`; a model assessment, not a safety guarantee |
| `illustration` | `usable`, `irrelevant`, or `uncertain`, with a short reason relative to the supplied article/topic context |
| `provenance` | Image hash/reference, prompt identity, provider/model identity, timestamp and expected/actual cost when available |

Image subject is image-specific; illustration relevance also depends on the
article/topic context. Record its exact reference/hash in the relevance result
and cache key so suitability for one article is not blindly reused for another.
No face recognition, inferred identity, free-form conspiracy tags or factual
verdicts are required. Confidence, if recorded, is descriptive model output,
not calibrated proof that an image is safe or relevant. Treat image text and
metadata as untrusted material, never instructions for tools or publication.
Store model-facing instructions in versioned Markdown under `src/prompts/`.

The annotation schema and request boundaries are runtime validated. Unknown or
malformed outputs stay explicit failures; do not coerce them to `usable`.
Keep bounded attempts and durable failure records through existing controllers.
Identity includes the image version, supplied relevance context, prompt and
model; repeat requests reuse the exact saved annotation.

## Renderer and OCR

The renderer omits images flagged graphic, explicit, irrelevant or uncertain
until review; an annotation never deletes the archived image. Missing or failed
annotations also leave the image out without blocking the text article. This
does not introduce a human-review UI or a policy against every image of a person.

OCR is a separate optional stage and artifact, with its own prompt/model,
cost and image provenance. OCR output is candidate extracted text, not verified
verbatim source evidence. It must not overwrite source alt text or bypass claim
grounding. `containsText` can suggest OCR; this epic does not require running it.

## Evaluation and delivery slices

Prepare a private representative set of 20 retained images, aiming for 15 video
frames and five uploaded images, including slides, screenshots and a generic
placeholder. Keep images and source-derived annotations in the private corpus;
public automated tests use synthetic fixtures. Record human labels and expected
renderer decisions against exact image hashes. Target at least 90% observed
agreement on illustration usability and no missed sensitive examples in this
set. Report the confusion counts and uncertainty cases; a small set cannot
establish a universal zero-error rate. If a category cannot be represented,
record the evaluation gap rather than fabricating coverage.

Use one low-cost vision model through an appropriate typed provider adapter.
At execution time choose and pin a compatible model and preflight its bounded
cost against the proposed $0.002/image experiment ceiling and the owner's total
daily budget. If none fits, record the blocker; do not silently raise the cap.
Actual cost is recorded when available, and unknown accounting is explicit.
No classification deployment, spend or model selection is required to finish
this design.

Split implementation into: retained-byte storage/manifests (prerequisite),
annotation schema and bounded provider invocation, then renderer integration
and the representative evaluation. Each needs its own estimate; this is not one
S ticket covering all storage, inference and evaluation work. OCR remains a
separate optional follow-up. Preserve the existing image URL feature while the
retention prerequisite is implemented.
