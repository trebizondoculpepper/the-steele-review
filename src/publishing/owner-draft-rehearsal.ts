import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import type { JudgeRecoveryCompletionPort } from "../controllers/editorial-recovery-ingress.js";
import {
  DraftTargetSchema,
  OwnerDraftRequestSchema,
  OwnerDraftAuthorizationSchema,
  ownerDraftRequestHash,
  ownerDraftVersionIdentity,
} from "../content/owner-draft-authorization.js";
import { DraftRehearsalError, readRetainedDraftRehearsal } from "../drafting/draft-rehearsal.js";
import { artifactReference, sameArtifact } from "../drafting/publication-payload.js";
import { writeOnce } from "../research/job.js";
import { ARTICLE_APPROVED_SUBJECT } from "../events/article-approved-event.js";
import {
  approvalEventFor,
  assertDraftAuthorizationTarget,
  type DestinationAdapter,
} from "./approved-article.js";

/** Explicit operator-only adoption. No model object, generation or destination write capability. */
export async function authorizeOwnerDraftRehearsal(input: {
  request: unknown;
  content: GitArtifactStore;
  operations: OperationStore;
  parentCompletion: JudgeRecoveryCompletionPort;
  destinations: Pick<DestinationAdapter, "name" | "action" | "draftTarget" | "render">[];
}) {
  const request = OwnerDraftRequestSchema.parse(input.request);
  if (input.destinations.length !== 3 || new Set(input.destinations.map((d) => d.name)).size !== 3)
    throw new DraftRehearsalError("target-refused");
  for (const adapter of input.destinations) {
    const target = DraftTargetSchema.safeParse(adapter.draftTarget);
    if (
      adapter.action !== "draft" ||
      !target.success ||
      target.data.name !== adapter.name ||
      !request.destinations.some((d) => JSON.stringify(d) === JSON.stringify(target.data))
    )
      throw new DraftRehearsalError("target-refused");
  }
  const terminal = await input.parentCompletion.read(request.parent.workflowKey);
  if (
    terminal.state !== "completed" ||
    terminal.result.outcome !== "rejected" ||
    !terminal.result.draft ||
    !terminal.result.metadata ||
    !sameArtifact(artifactReference(terminal.result.summary), request.parent.summary) ||
    !sameArtifact(artifactReference(terminal.result.draft), request.body) ||
    !sameArtifact(artifactReference(terminal.result.metadata), request.metadata)
  )
    throw new DraftRehearsalError("parent-not-complete");
  const checked = await readRetainedDraftRehearsal({
    request,
    content: input.content,
    operations: input.operations,
  });
  const requestHash = ownerDraftRequestHash(request),
    versionIdentity = ownerDraftVersionIdentity(request);
  const previous = input.operations.ownerDraftIntent(
    checked.post.publicationId,
    checked.post.postId,
    request.requestId,
  );
  if (
    previous &&
    (previous.requestHash !== requestHash || previous.versionIdentity !== versionIdentity)
  )
    throw new DraftRehearsalError("identity-conflict");
  if (!previous)
    await readRetainedDraftRehearsal({
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
  const authorization = OwnerDraftAuthorizationSchema.parse({
    kind: "owner-draft-rehearsal",
    outcome: "owner-authorized-draft",
    request,
    post: checked.post,
    parentOutcome: "rejected",
    adoptedRevisionCount: 1,
    authorizedAt: binding.recordedAt,
  });
  const ref = await writeOnce(
    input.content,
    `owner-draft-rehearsals/${checked.post.publicationId}/${checked.post.postId}/${requestHash}.json`,
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
      draftTargets: request.destinations,
      authorizationOutcome: "owner-authorized-draft",
    },
    ref,
  );
  for (const adapter of input.destinations) {
    try {
      const target = assertDraftAuthorizationTarget(event.data, adapter);
      const preview = adapter.render({
        markdown: checked.markdown,
        data: event.data,
        publication: checked.payload,
      });
      if (JSON.stringify(preview.draftAuthorization) !== JSON.stringify(target)) throw new Error();
    } catch {
      throw new DraftRehearsalError("target-refused");
    }
  }
  input.operations.completeOwnerDraftAuthorization({
    binding,
    authorization: artifactReference(ref),
    event: {
      eventId: event.eventId,
      subject: ARTICLE_APPROVED_SUBJECT,
      payload: JSON.stringify(event.event.toJSON()),
    },
  });
  return {
    outcome: "owner-authorized-draft" as const,
    eventId: event.eventId,
    authorization: ref,
    draft: request.body,
    metadata: request.metadata,
    repeated: !!previous,
  };
}
