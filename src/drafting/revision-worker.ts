import { createHash } from "node:crypto";
import type { ExtractionModelProvider } from "../analysis/extraction.js";
import { toArchiveRef } from "../collection/fulltext-projection.js";
import type { ArtifactReference } from "../content/artifact-reference.js";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import type { DeliveredMessage } from "../controllers/nats.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { DraftingBriefSchema, parseBriefReadyEvent, type DraftingBrief } from "./brief.js";
import { DEFAULT_DRAFT_PROMPT, draftFromBrief, type DraftMetadata } from "./draft.js";
import { RevisionAttemptStore, type AttemptRecord } from "./revision-attempts.js";
import { DEFAULT_MAX_REVISIONS, decideRevision } from "./revision-policy.js";
import { DEFAULT_VERIFY_PROMPT, verifyDraft, type VerificationReport } from "./verify.js";

/**
 * Resumable draft-and-verify revision worker (#101, completes #44).
 *
 * For one saved brief: draft (#42), verify the exact draft (#43), apply the
 * pure revision policy (#99) and record the attempt (#100). A redraft goes
 * back to the same writer with the verifier's targeted feedback and the
 * changed draft is verified again, up to the policy's revision bound.
 *
 * - Resumes from stored attempt state: recorded attempts are reused, never
 *   redrafted or reverified, so a duplicate or redelivered event costs no
 *   model calls.
 * - An unavailable writer or verifier (for example exhausted credit) keeps
 *   the work pending and redelivers; it never becomes an editorial skip.
 * - The outcome is the attempt store's `revision.decided` event (approve
 *   with the exact draft, or skip with its reason) for a later consumer.
 *   No browsing, research or publishing happens here.
 */

export type RevisionWorkerOutcome =
  | { kind: "approved"; revision: number; draft: ArtifactReference }
  | { kind: "skipped"; revision: number; reason: string }
  | { kind: "no-supported-errors" }
  | { kind: "pending"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "invalid-event" };

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const refOf = (r: ArtifactRef): ArtifactReference => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

export class RevisionWorker {
  private readonly attempts: RevisionAttemptStore;

  constructor(
    private readonly config: {
      artifacts: Pick<GitArtifactStore, "read" | "write" | "lookup">;
      operations: OperationStore;
      writer: ExtractionModelProvider;
      verifier: ExtractionModelProvider;
      owner: string;
      maxRevisions?: number;
      retryDelayMs?: number;
    },
  ) {
    this.attempts = new RevisionAttemptStore({
      artifacts: config.artifacts,
      operations: config.operations,
    });
  }

  async handle(message: DeliveredMessage, signal?: AbortSignal): Promise<RevisionWorkerOutcome> {
    const { artifacts, operations } = this.config;
    const retryDelay = this.config.retryDelayMs ?? 60_000;
    const maxRevisions = this.config.maxRevisions ?? DEFAULT_MAX_REVISIONS;
    let event;
    try {
      event = parseBriefReadyEvent(new TextDecoder().decode(message.data));
    } catch {
      message.term();
      return { kind: "invalid-event" };
    }
    const briefRef = toArchiveRef(event.data.brief);
    let briefText: string;
    let brief: DraftingBrief;
    try {
      briefText = await artifacts.read(briefRef);
      brief = DraftingBriefSchema.parse(JSON.parse(briefText));
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.code === "git-failed") {
        message.nak(retryDelay);
        return { kind: "pending", reason: "archive-read-failed" };
      }
      operations.recordPermanentFailure(`revision-invalid:${event.id}`, "unreadable-brief");
      await message.ack();
      return { kind: "failed", reason: "unreadable-brief" };
    }
    const post = { publicationId: brief.source.publicationId, postId: brief.source.postId };
    if (post.publicationId !== event.data.publicationId || post.postId !== event.data.postId) {
      operations.recordPermanentFailure(`revision-invalid:${event.id}`, "identity-mismatch");
      await message.ack();
      return { kind: "failed", reason: "identity-mismatch" };
    }
    const briefHash = event.data.brief.hash;

    let previous: { record: AttemptRecord; markdown: string } | undefined;
    for (let revision = 0; revision <= maxRevisions; revision++) {
      const begun = await this.attempts.begin({
        post,
        briefHash,
        revision,
        owner: this.config.owner,
      });
      if (begun.kind === "busy" || begun.kind === "out-of-order") {
        message.nak(Math.min(retryDelay, 30_000));
        return { kind: "pending", reason: begun.kind };
      }
      if (begun.kind === "failed") {
        await message.ack();
        return { kind: "failed", reason: begun.reason };
      }
      let record: AttemptRecord;
      let markdown: string;
      if (begun.kind === "already-recorded") {
        // Resume: reuse the stored attempt without calling any model.
        record = begun.record;
        markdown = await artifacts.read(toArchiveRef(record.draft));
      } else {
        const step = await this.attempt(
          brief,
          briefText,
          briefRef,
          revision,
          previous,
          maxRevisions,
          signal,
        );
        if (step.kind !== "ready") {
          if (step.kind === "pending") {
            operations.yieldClaim(begun.claim);
            message.nak(retryDelay);
            return { kind: "pending", reason: step.reason };
          }
          operations.fail(begun.claim, "revision:no-supported-errors", false);
          await message.ack();
          return { kind: "no-supported-errors" };
        }
        const finished = await this.attempts.finish(begun.claim, {
          ...post,
          brief: event.data.brief,
          revision,
          draft: step.draft,
          report: step.report,
          decision: step.decision,
          ...(previous ? { previous: previous.record.draft } : {}),
        });
        if (finished.kind !== "recorded") {
          message.nak(Math.min(retryDelay, 30_000));
          return {
            kind: "pending",
            reason: finished.kind === "stale-owner" ? "stale-owner" : finished.reason,
          };
        }

        record = {
          schemaVersion: 1,
          ...post,
          brief: event.data.brief,
          revision,
          draft: step.draft,
          report: step.report,
          decision: step.decision,
        };
        markdown = step.markdown;
      }
      if (record.decision.action === "approve") {
        await message.ack();
        return { kind: "approved", revision, draft: record.draft };
      }
      if (record.decision.action === "skip") {
        await message.ack();
        return { kind: "skipped", revision, reason: record.decision.reason };
      }
      previous = { record, markdown };
    }
    // The policy never redrafts past its bound; reaching here means a
    // recorded redraft at the last revision, which is a skip.
    await message.ack();
    return { kind: "skipped", revision: maxRevisions, reason: "revisions-exhausted" };
  }

  /** One draft-verify-decide step for a claimed revision. */
  private async attempt(
    brief: DraftingBrief,
    briefText: string,
    briefRef: ArtifactRef,
    revision: number,
    previous: { record: AttemptRecord; markdown: string } | undefined,
    maxRevisions: number,
    signal?: AbortSignal,
  ): Promise<
    | {
        kind: "ready";
        markdown: string;
        draft: ArtifactReference;
        report: ArtifactReference;
        decision: AttemptRecord["decision"];
      }
    | { kind: "pending"; reason: string }
    | { kind: "no-supported-errors" }
  > {
    const { artifacts } = this.config;
    const feedback =
      previous?.record.decision.action === "redraft"
        ? (previous.record.decision.feedback as Array<{
            passage?: string;
            problem: string;
            requiredChange: string;
          }>)
        : undefined;
    const drafted = await draftFromBrief({
      brief,
      provider: this.config.writer,
      prompt: DEFAULT_DRAFT_PROMPT,
      ...(previous && feedback ? { revision: { previousDraft: previous.markdown, feedback } } : {}),
      ...(signal ? { signal } : {}),
    });
    if (drafted.kind === "failed") return { kind: "pending", reason: `writer:${drafted.reason}` };
    if (drafted.kind === "no-supported-errors") return { kind: "no-supported-errors" };

    const base = `drafts/${brief.source.publicationId}/${brief.source.postId}/revisions/${sha(briefText).slice(0, 16)}`;
    const write = async (path: string, content: string): Promise<ArtifactRef> =>
      (await artifacts.lookup(path)) ?? artifacts.write(path, content);
    const draftRef = await write(
      `${base}/${revision}-${sha(drafted.markdown)}.md`,
      drafted.markdown,
    );
    const metadata: Pick<DraftMetadata, "draftHash" | "brief"> = {
      draftHash: `sha256:${draftRef.sha256}`,
      brief: refOf(briefRef),
    };
    const verified = await verifyDraft({
      markdown: drafted.markdown,
      draft: draftRef,
      briefText,
      briefRef,
      metadata,
      verifier: this.config.verifier,
      prompt: DEFAULT_VERIFY_PROMPT,
      attempt: revision + 1,
      maxAttempts: maxRevisions + 1,
      ...(signal ? { signal } : {}),
    });
    if (verified.kind === "pending")
      return { kind: "pending", reason: `verifier:${verified.reason}` };
    if (verified.kind === "invalid")
      return { kind: "pending", reason: `verifier:${verified.reason}` };
    const report: VerificationReport = verified.report;
    const reportContent = `${JSON.stringify(report, null, 2)}\n`;
    const reportRef = await write(
      `${base}/${revision}-${sha(reportContent)}.verification.json`,
      reportContent,
    );
    const decision = decideRevision(
      {
        revisionCount: revision,
        draft: { hash: `sha256:${draftRef.sha256}`, markdown: drafted.markdown },
        brief: { hash: `sha256:${briefRef.sha256}` },
        report,
      },
      { maxRevisions },
    );
    return {
      kind: "ready",
      markdown: drafted.markdown,
      draft: refOf(draftRef),
      report: refOf(reportRef),
      decision,
    };
  }
}
