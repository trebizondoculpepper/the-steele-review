import { ArticleRunInputSchema } from "../workflow/article-run.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import {
  ConfiguredDraftCheckpointSchema,
  ConfiguredDraftRequestSchema,
  ConfiguredDraftAuthorizationSchema,
  configuredDraftRequestHash,
  configuredDraftVersionIdentity,
} from "../content/configured-draft-authorization.js";
import { OwnerDraftTargetsSchema } from "../content/owner-draft-authorization.js";
import {
  readConfiguredDraftEvidence,
  ConfiguredDraftEvidenceError,
} from "../drafting/configured-draft-evidence.js";
import { artifactReference } from "../drafting/publication-payload.js";
import { writeOnce } from "../research/job.js";
import { ARTICLE_APPROVED_SUBJECT } from "../events/article-approved-event.js";
import { approvalEventFor, type DraftDeliveryControl } from "./approved-article.js";

/** Normal pipeline authority, distinct from model approval and retained-parent adoption. */
export async function authorizeConfiguredDraft(input: {
  checkpoint: unknown;
  destinations: unknown;
  content: GitArtifactStore;
  operations: OperationStore;
  deliveryControl: DraftDeliveryControl;
}) {
  const checkpoint = ConfiguredDraftCheckpointSchema.parse(input.checkpoint);
  // Refuse unknown/unbounded submission fields before copying any input into an artifact.
  ArticleRunInputSchema.parse(checkpoint.input);
  const destinations = OwnerDraftTargetsSchema.parse(input.destinations);
  const checkpointHash = configuredCheckpointHash(checkpoint);
  const checkpointRef = await writeOnce(
    input.content,
    `configured-draft-checkpoints/${checkpointHash}.json`,
    checkpoint,
  );
  const original = checkpoint.input;
  const request = ConfiguredDraftRequestSchema.parse({
    version: "configured-unpublished-draft-request-v1",
    requestId: original.operatorRequestId,
    checkpoint: artifactReference(checkpointRef),
    destinations,
    ...Object.fromEntries(
      (["body", "metadata", "publication", "package", "assessment", "judgment"] as const).map(
        (key) => [key, checkpoint[key]],
      ),
    ),
  });
  const checked = await readConfiguredDraftEvidence({
    request,
    content: input.content,
    operations: input.operations,
  });
  const requestHash = configuredDraftRequestHash(request),
    versionIdentity = configuredDraftVersionIdentity(request);
  const existing = input.operations.ownerDraftIntent(
    checked.post.publicationId,
    checked.post.postId,
    request.requestId,
  );
  if (
    existing &&
    (existing.requestHash !== requestHash || existing.versionIdentity !== versionIdentity)
  )
    throw new ConfiguredDraftEvidenceError();
  if (!existing)
    await readConfiguredDraftEvidence({
      request,
      content: input.content,
      operations: input.operations,
      requireCurrent: true,
    });
  const binding = input.operations.recordOwnerDraftIntent({
    ...checked.post,
    requestId: request.requestId,
    requestHash,
    versionIdentity,
  });
  const authorization = ConfiguredDraftAuthorizationSchema.parse({
    kind: "owner-draft-rehearsal",
    outcome: "owner-authorized-draft",
    authorizationBasis: "live-configured-normal-flow-v1",
    request,
    post: checked.post,
    authorizedAt: binding.recordedAt,
  });
  const ref = await writeOnce(
    input.content,
    `configured-draft-authorizations/${requestHash}.json`,
    authorization,
  );
  const event = approvalEventFor(
    {
      kind: "owner-draft-rehearsal",
      post: checked.post,
      body: request.body,
      package: request.package,
      publication: request.publication,
      assessment: request.assessment,
      approvedAt: binding.recordedAt,
      markdown: checked.markdown,
      payload: checked.payload,
      draftTargets: destinations,
      authorizationOutcome: "owner-authorized-draft",
    },
    ref,
  );
  const completed = input.operations.ownerDraftAuthorization(event.eventId);
  if (!completed) {
    for (const target of destinations)
      if (!(await input.deliveryControl.allow(target))) throw new ConfiguredDraftEvidenceError();
    await readConfiguredDraftEvidence({
      request,
      content: input.content,
      operations: input.operations,
      requireCurrent: true,
    });
    input.operations.completeOwnerDraftAuthorization({
      binding,
      authorization: artifactReference(ref),
      event: {
        eventId: event.eventId,
        subject: ARTICLE_APPROVED_SUBJECT,
        payload: JSON.stringify(event.event.toJSON()),
      },
    });
  }
  return { eventId: event.eventId, authorization: ref, outcome: "owner-authorized-draft" as const };
}
import { createHash } from "node:crypto";
const configuredCheckpointHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
