import { createHash, randomUUID } from "node:crypto";
import { CloudEvent } from "cloudevents";
import { z } from "zod";
import { ArtifactReferenceSchema, type ArtifactReference } from "../content/artifact-reference.js";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import {
  OperationStoreError,
  type OperationClaim,
  type OperationStore,
} from "../controllers/operation-store.js";

/**
 * Versioned drafting and verification attempt records (#100, part of #44).
 *
 * One attempt is one draft of one brief at one revision number, with its
 * verification report and the decision taken (#99). Each attempt is saved
 * once as an immutable Git record that keeps the original evidence brief
 * and every draft and report reference, and its state transition is
 * recorded through the state controller with a pending follow-up event.
 *
 * - Attempt identity is stable (brief hash and revision), so a retry reuses
 *   the saved result instead of producing a duplicate revision or charging
 *   for another model call.
 * - Revisions advance in order: revision n needs revision n-1 recorded.
 * - The transition is fenced by the claim: a stale worker whose lease was
 *   taken over cannot record over the current owner.
 *
 * No model calls, publishing or consumer loop.
 */

export const REVISION_DECIDED_SUBJECT = "steele.v1.revision.decided";
export const REVISION_DECIDED_EVENT_TYPE_V1 = "org.steele.revision.decided.v1";
export const REVISION_DECIDED_DATASCHEMA_V1 = "urn:steele:schema:revision-decided:v1";

const Hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const AttemptRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    publicationId: z.string().min(1),
    postId: z.string().min(1),
    /** The original evidence brief every revision is drafted from. */
    brief: ArtifactReferenceSchema,
    revision: z.number().int().min(0).max(10),
    draft: ArtifactReferenceSchema.optional(),
    report: ArtifactReferenceSchema.optional(),
    decision: z.discriminatedUnion("action", [
      z.object({ action: z.literal("approve"), draftHash: Hash, briefHash: Hash }).strict(),
      z
        .object({
          action: z.literal("redraft"),
          revision: z.number().int().min(1),
          feedback: z.array(z.unknown()),
        })
        .strict(),
      z.object({ action: z.literal("skip"), reason: z.string().min(1) }).strict(),
    ]),
    /** The previous attempt's record, for revisions after the first. */
    previous: ArtifactReferenceSchema.optional(),
  })
  .strict()
  // Only a skip may lack a draft and report (for example, when there was
  // nothing supported to write, or the writer never gave usable output).
  .refine(
    (r) => r.decision.action === "skip" || (r.draft !== undefined && r.report !== undefined),
    {
      message: "draft and report are required unless the decision is skip",
    },
  );
export type AttemptRecord = z.infer<typeof AttemptRecordSchema>;

/** Versioned payload of the `revision.decided` handoff. */
export const RevisionDecidedDataSchema = z
  .object({
    publicationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
    postId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
    revision: z.number().int().min(0).max(10),
    action: z.enum(["approve", "redraft", "skip"]),
    brief: ArtifactReferenceSchema,
    draft: ArtifactReferenceSchema.optional(),
    report: ArtifactReferenceSchema.optional(),
    record: ArtifactReferenceSchema,
  })
  .strict();
export type RevisionDecidedData = z.infer<typeof RevisionDecidedDataSchema>;

const RevisionDecidedEventSchema = z
  .object({
    specversion: z.literal("1.0"),
    id: z.string().min(1).max(200),
    source: z.string().min(1).max(500),
    type: z.literal("org.steele.revision.decided.v1"),
    time: z.iso.datetime({ offset: true }),
    subject: z.string().min(1).max(500),
    datacontenttype: z.literal("application/json"),
    dataschema: z.literal("urn:steele:schema:revision-decided:v1"),
    data: RevisionDecidedDataSchema,
  })
  .strict()
  .refine((e) => e.subject === `substack/${e.data.publicationId}/${e.data.postId}`, {
    message: "subject does not match the post",
  });

/** Parse and validate a serialised `revision.decided` event. */
export function parseRevisionDecidedEvent(
  input: string,
): z.infer<typeof RevisionDecidedEventSchema> {
  return RevisionDecidedEventSchema.parse(JSON.parse(input));
}

export type BeginOutcome =
  | { kind: "claimed"; claim: OperationClaim; previous?: ArtifactReference }
  | { kind: "already-recorded"; record: AttemptRecord; artifact: ArtifactRef }
  | { kind: "busy" }
  | { kind: "out-of-order" }
  | { kind: "failed"; reason: string };

export type FinishOutcome =
  | { kind: "recorded"; artifact: ArtifactRef; reused: boolean }
  | { kind: "stale-owner" }
  | { kind: "failed"; reason: string; retryable: boolean };

const shortHash = (hash: string) => hash.replace(/^sha256:/, "");
const refOf = (r: ArtifactRef): ArtifactReference => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

export class RevisionAttemptStore {
  constructor(
    private readonly config: {
      artifacts: Pick<GitArtifactStore, "read" | "write" | "lookup">;
      operations: OperationStore;
      leaseMs?: number;
    },
  ) {}

  /** Stable identity of an attempt: the brief and the revision number. */
  key(briefHash: string, revision: number): string {
    return `revision-attempt:${shortHash(briefHash)}:${revision}`;
  }

  /**
   * Record path for one claim attempt of an attempt. Each holder writes its
   * own path, so a stale holder's late commit can never collide with or
   * overwrite the current holder's record; only the fenced completion
   * decides which record is authoritative.
   */
  path(
    post: { publicationId: string; postId: string },
    briefHash: string,
    revision: number,
    claimAttempt: number,
  ): string {
    return `revisions/${post.publicationId}/${post.postId}/${shortHash(briefHash)}/${revision}/${claimAttempt}.json`;
  }

  /**
   * Claim an attempt before any model work. A recorded attempt is returned
   * for reuse; an attempt whose predecessor is not yet recorded is refused.
   */
  async begin(input: {
    post: { publicationId: string; postId: string };
    briefHash: string;
    revision: number;
    owner: string;
  }): Promise<BeginOutcome> {
    const { operations, artifacts } = this.config;
    let previous: ArtifactReference | undefined;
    if (input.revision > 0) {
      const prior = operations.operationStatus(this.key(input.briefHash, input.revision - 1));
      if (prior?.status !== "completed") return { kind: "out-of-order" };
      previous = (prior.artifact as { record?: ArtifactReference } | undefined)?.record;
    }
    const claimed = operations.claim(
      this.key(input.briefHash, input.revision),
      input.owner,
      this.config.leaseMs ?? 30 * 60_000,
      1_000,
    );
    if (claimed.kind === "busy") return { kind: "busy" };
    if (claimed.kind === "exhausted")
      return { kind: "failed", reason: claimed.errorCode ?? "exhausted" };
    if (claimed.kind === "completed") {
      const ref = (claimed.artifact as { record?: ArtifactReference } | undefined)?.record;
      if (!ref) return { kind: "failed", reason: "missing-record" };
      const artifact = {
        repository: ref.repository,
        commit: ref.commit,
        path: ref.path,
        sha256: shortHash(ref.hash),
      };
      return {
        kind: "already-recorded",
        record: AttemptRecordSchema.parse(JSON.parse(await artifacts.read(artifact))),
        artifact,
      };
    }
    // A previous holder may have committed its record and stopped before
    // completing: reuse the latest such record rather than redoing the work.
    let committed: ArtifactRef | undefined;
    for (let a = claimed.claim.attempt - 1; a >= 1 && !committed; a--) {
      committed = await artifacts.lookup(this.path(input.post, input.briefHash, input.revision, a));
    }
    if (committed) {
      const record = AttemptRecordSchema.parse(JSON.parse(await artifacts.read(committed)));
      let stored: unknown;
      try {
        stored = this.complete(claimed.claim, record, committed);
      } catch (error) {
        if (error instanceof OperationStoreError && error.code === "not-owner")
          return { kind: "busy" };
        throw error;
      }
      // Another holder may have completed first: return whatever is durable.
      const authoritative = (stored as { record?: ArtifactReference } | undefined)?.record;
      if (!authoritative) return { kind: "failed", reason: "missing-record" };
      const durable = {
        repository: authoritative.repository,
        commit: authoritative.commit,
        path: authoritative.path,
        sha256: shortHash(authoritative.hash),
      };
      const durableRecord =
        durable.path === committed.path && durable.sha256 === committed.sha256
          ? record
          : AttemptRecordSchema.parse(JSON.parse(await artifacts.read(durable)));
      return { kind: "already-recorded", record: durableRecord, artifact: durable };
    }
    return { kind: "claimed", claim: claimed.claim, ...(previous ? { previous } : {}) };
  }

  /**
   * Save the attempt record and transition its state, with a pending
   * follow-up event. Fenced: only the current claim holder can record.
   */
  async finish(
    claim: OperationClaim,
    input: Omit<AttemptRecord, "schemaVersion">,
  ): Promise<FinishOutcome> {
    const record = AttemptRecordSchema.parse({ schemaVersion: 1, ...input });
    if (claim.key !== this.key(record.brief.hash, record.revision)) {
      return { kind: "failed", reason: "claim-mismatch", retryable: false };
    }
    // Fenced before any write: a worker whose lease was taken over must not
    // record, even an identical outcome.
    try {
      this.config.operations.renew(claim, this.config.leaseMs ?? 30 * 60_000);
    } catch (error) {
      if (error instanceof OperationStoreError && error.code === "not-owner")
        return { kind: "stale-owner" };
      throw error;
    }
    const path = this.path(record, record.brief.hash, record.revision, claim.attempt);
    const content = `${JSON.stringify(record, null, 2)}\n`;
    let artifact: ArtifactRef;
    let reused = false;
    try {
      artifact = await this.config.artifacts.write(path, content);
    } catch (error) {
      const existing =
        error instanceof ArtifactStoreError && error.code === "immutable-conflict"
          ? await this.config.artifacts.lookup(path)
          : undefined;
      if (!existing) return { kind: "failed", reason: "commit-failed", retryable: true };
      // An identical record from an earlier try is reused; a different one is
      // a conflicting outcome for the same attempt and is refused.
      if (existing.sha256 !== createHash("sha256").update(content).digest("hex")) {
        return { kind: "failed", reason: "conflicting-record", retryable: false };
      }
      artifact = existing;
      reused = true;
    }
    let stored: unknown;
    try {
      stored = this.complete(claim, record, artifact);
    } catch (error) {
      if (error instanceof OperationStoreError && error.code === "not-owner")
        return { kind: "stale-owner" };
      throw error;
    }
    // A completion recorded by another holder is returned unchanged; only
    // when the stored record is ours did this worker record the attempt.
    const authoritative = (stored as { record?: ArtifactReference } | undefined)?.record;
    if (
      authoritative?.path !== artifact.path ||
      authoritative?.hash !== `sha256:${artifact.sha256}`
    ) {
      return { kind: "stale-owner" };
    }
    return { kind: "recorded", artifact, reused };
  }

  /** Complete the transition; returns the authoritative stored result. */
  private complete(claim: OperationClaim, record: AttemptRecord, artifact: ArtifactRef): unknown {
    const event = new CloudEvent({
      specversion: "1.0",
      id: randomUUID(),
      source: "urn:steele:drafting:revisions",
      type: REVISION_DECIDED_EVENT_TYPE_V1,
      time: new Date().toISOString(),
      subject: `substack/${record.publicationId}/${record.postId}`,
      datacontenttype: "application/json",
      dataschema: REVISION_DECIDED_DATASCHEMA_V1,
      data: RevisionDecidedDataSchema.parse({
        publicationId: record.publicationId,
        postId: record.postId,
        revision: record.revision,
        action: record.decision.action,
        brief: record.brief,
        draft: record.draft,
        report: record.report,
        record: refOf(artifact),
      }),
    });
    const payload = JSON.stringify(event.toJSON());
    // The emitted envelope must satisfy the published contract.
    parseRevisionDecidedEvent(payload);
    return this.config.operations.complete(
      claim,
      { record: refOf(artifact), action: record.decision.action },
      [{ eventId: event.id, subject: REVISION_DECIDED_SUBJECT, payload }],
    );
  }
}
