import { createHash } from "node:crypto";
import { z } from "zod";
import type { ArtifactReference } from "../content/artifact-reference.js";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";

/**
 * Version-bound manual editorial decisions (#447).
 *
 * An owner's approve, reject or feedback decision is recorded against one
 * exact draft version, in the content Git collection, before any downstream
 * handoff. It is deliberately separate from model verification and from
 * publisher receipts: an editorial approval never fabricates a verifier
 * outcome and never publishes anything by itself.
 *
 * - A decision is immutable; the stable request ID makes a repeated submission
 *   return the original record instead of creating a second decision.
 * - The exact draft must exist at the pinned commit and hash. A different or
 *   newer draft is a stale-version conflict, never an approval of it.
 * - The state controller holds the current disposition for the draft version
 *   and deduplicates requests; this module never reads its database directly.
 * - Rejection blocks that version from new automatic handoffs through the
 *   recorded disposition; it does not retract an existing external
 *   publication.
 */

export const EDITORIAL_DECISION_SCHEMA_VERSION = 1;
export const MAX_EDITORIAL_COMMENT = 2_000;

export const EditorialActionSchema = z.enum(["approve", "reject", "feedback"]);
export type EditorialAction = z.infer<typeof EditorialActionSchema>;

export const EditorialDecisionSchema = z
  .object({
    schemaVersion: z.literal(EDITORIAL_DECISION_SCHEMA_VERSION),
    requestId: z.string().min(1).max(200),
    publicationId: z.string().min(1).max(200),
    postId: z.string().min(1).max(300),
    /** The exact draft this decision applies to. */
    draft: ArtifactReferenceSchema,
    action: EditorialActionSchema,
    comment: z.string().trim().min(1).max(MAX_EDITORIAL_COMMENT).optional(),
    decidedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type EditorialDecision = z.infer<typeof EditorialDecisionSchema>;

/** JSON Schema (draft 2020-12) for {@link EditorialDecisionSchema}. */
export function editorialDecisionJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(EditorialDecisionSchema) as Record<string, unknown>;
}

const RequestSchema = z
  .object({
    requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
    publicationId: z.string().min(1).max(200),
    postId: z.string().min(1).max(300),
    draft: ArtifactReferenceSchema,
    action: EditorialActionSchema,
    comment: z.string().trim().min(1).max(MAX_EDITORIAL_COMMENT).optional(),
  })
  .strict();
export type EditorialDecisionRequest = z.infer<typeof RequestSchema>;

export type EditorialOutcome =
  | { status: "recorded"; decision: EditorialDecision; duplicate: boolean }
  | { status: "invalid"; reason: "invalid-request" | "comment-required" }
  | { status: "stale-version"; reason: "missing-draft" | "version-mismatch" }
  | { status: "conflict" }
  | { status: "busy" };

const toRef = (reference: ArtifactReference): ArtifactRef => ({
  repository: reference.repository,
  commit: reference.commit,
  path: reference.path,
  sha256: reference.hash.replace(/^sha256:/, ""),
});

const asReference = (ref: ArtifactRef): ArtifactReference => ({
  repository: ref.repository,
  commit: ref.commit,
  path: ref.path,
  hash: `sha256:${ref.sha256}`,
});

/** Stable operation key: one decision per request. */
export const editorialDecisionKey = (requestId: string): string =>
  `editorial-decision:${requestId}`;

/**
 * Stable key for the current disposition of one exact draft identity. Scoped
 * by post and full artifact identity, so identical bytes in another post (or
 * repository) can never share a disposition.
 */
export const editorialDispositionKey = (input: {
  publicationId: string;
  postId: string;
  draft: ArtifactReference;
}): string =>
  `editorial-disposition:${createHash("sha256")
    .update(
      JSON.stringify([
        input.publicationId,
        input.postId,
        input.draft.repository,
        input.draft.commit,
        input.draft.path,
        input.draft.hash,
      ]),
    )
    .digest("hex")}`;

/** Immutable path of one decision record. */
export function editorialDecisionPath(request: {
  publicationId: string;
  postId: string;
  draft: ArtifactReference;
  requestId: string;
}): string {
  const revision = request.draft.hash.replace(/^sha256:/, "").slice(0, 32);
  return `editorial-decisions/${request.publicationId}/${request.postId}/${revision}/${request.requestId}.json`;
}

/**
 * Record one manual editorial decision for an exact draft version.
 *
 * Repeats with the same request ID return the original record. A stale or
 * different draft version is refused rather than approved by proxy. Nothing is
 * published, emailed or marked as model-verified.
 */
export async function recordEditorialDecision(input: {
  content: Pick<GitArtifactStore, "lookupAt" | "lookup" | "write" | "read">;
  operations: Pick<
    OperationStore,
    "claim" | "complete" | "yieldClaim" | "recordEditorialDisposition" | "operationStatus"
  >;
  request: EditorialDecisionRequest;
  owner: string;
  now?: () => Date;
  leaseMs?: number;
}): Promise<EditorialOutcome> {
  const parsed = RequestSchema.safeParse(input.request);
  if (!parsed.success) return { status: "invalid", reason: "invalid-request" };
  const request = parsed.data;
  // Feedback without words is not a decision the writer can act on.
  if (request.action === "feedback" && request.comment === undefined) {
    return { status: "invalid", reason: "comment-required" };
  }

  // The decision must name bytes that exist at their pinned revision. A
  // missing or different draft is a stale-version conflict, not an approval.
  let stored: { ref: ArtifactRef; content: string } | undefined;
  try {
    stored = await input.content.lookupAt(request.draft.commit, request.draft.path);
  } catch {
    stored = undefined;
  }
  if (!stored) return { status: "stale-version", reason: "missing-draft" };
  // The full authoritative identity must match, not just the bytes: a request
  // naming another repository or revision is not this article's draft.
  const identity = toRef(request.draft);
  if (
    stored.ref.repository !== identity.repository ||
    stored.ref.commit !== identity.commit ||
    stored.ref.path !== identity.path ||
    stored.ref.sha256 !== identity.sha256
  ) {
    return { status: "stale-version", reason: "version-mismatch" };
  }

  const now = input.now ?? (() => new Date());
  const path = editorialDecisionPath(request);
  const decision: EditorialDecision = {
    schemaVersion: EDITORIAL_DECISION_SCHEMA_VERSION,
    requestId: request.requestId,
    publicationId: request.publicationId,
    postId: request.postId,
    draft: request.draft,
    action: request.action,
    ...(request.comment === undefined ? {} : { comment: request.comment }),
    decidedAt: now().toISOString(),
  };

  const claimed = input.operations.claim(
    editorialDecisionKey(request.requestId),
    input.owner,
    input.leaseMs ?? 60_000,
    3,
  );
  if (claimed.kind === "busy") return { status: "busy" };
  if (claimed.kind === "exhausted") return { status: "conflict" };
  if (claimed.kind === "completed") {
    const existing = await readDecision(input.content, path);
    if (!existing) return { status: "conflict" };
    // A repeated submission may only confirm the same semantic decision,
    // including the full pinned draft identity (repository, commit, path and
    // hash): identical bytes at another path are a different artifact.
    return sameDecision(existing, decision)
      ? { status: "recorded", decision: existing, duplicate: true }
      : { status: "conflict" };
  }

  // Save the durable record before any downstream handoff. An existing
  // immutable file is reused only when it is byte-identical.
  let decisionRef: ArtifactRef | undefined;
  try {
    decisionRef = await input.content.write(path, `${JSON.stringify(decision, null, 2)}\n`);
  } catch (error) {
    if (!(error instanceof ArtifactStoreError) || error.code !== "immutable-conflict") {
      input.operations.yieldClaim(claimed.claim);
      throw error;
    }
    // A crash after the artifact write but before completion: reuse the
    // retained record only when it is the same decision, and report that
    // record (not the newly constructed one) as the outcome.
    const existing = await readDecision(input.content, path);
    if (!existing || !sameDecision(existing, decision)) {
      input.operations.yieldClaim(claimed.claim);
      return { status: "conflict" };
    }
    decisionRef = await input.content.lookup(path).catch(() => undefined);
    if (!decisionRef) {
      input.operations.yieldClaim(claimed.claim);
      return { status: "conflict" };
    }
    input.operations
      .recordEditorialDisposition({
        key: editorialDispositionKey(request),
        decision: asReference(decisionRef),
        decidedAt: existing.decidedAt,
      });
    input.operations.complete(claimed.claim, { decision: asReference(decisionRef) }, []);
    return { status: "recorded", decision: existing, duplicate: true };
  }

  // Current disposition for this exact draft identity. The ordered register
  // keeps the newest decision, so an approve followed by a reject really does
  // change the disposition, while a late older arrival cannot regress it.
  input.operations.recordEditorialDisposition({
    key: editorialDispositionKey(request),
    decision: asReference(decisionRef),
    decidedAt: decision.decidedAt,
  });
  input.operations.complete(claimed.claim, { decision: asReference(decisionRef) }, []);
  return { status: "recorded", decision, duplicate: false };
}

/** True when a retained record is the same semantic decision as the request. */
function sameDecision(a: EditorialDecision, b: EditorialDecision): boolean {
  return (
    a.requestId === b.requestId &&
    a.publicationId === b.publicationId &&
    a.postId === b.postId &&
    a.action === b.action &&
    (a.comment ?? "") === (b.comment ?? "") &&
    a.draft.repository === b.draft.repository &&
    a.draft.commit === b.draft.commit &&
    a.draft.path === b.draft.path &&
    a.draft.hash === b.draft.hash
  );
}

async function readDecision(
  content: Pick<GitArtifactStore, "lookup" | "read">,
  path: string,
): Promise<EditorialDecision | undefined> {
  try {
    const ref = await content.lookup(path);
    if (!ref) return undefined;
    return EditorialDecisionSchema.parse(JSON.parse(await content.read(ref)));
  } catch {
    return undefined;
  }
}
