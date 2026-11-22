import { createHash } from "node:crypto";
import { z } from "zod";
import type { ExtractionModelProvider, ModelCompletionMetadata } from "../analysis/extraction.js";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import {
  ArtifactRefSchema,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import {
  OperationStoreError,
  type OperationStore,
  type OperationClaim,
} from "../controllers/operation-store.js";
import { ModelProviderError } from "../controllers/openrouter.js";
import { writeOnce } from "../research/job.js";

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const ref = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});
const fromRef = (r: z.infer<typeof ArtifactReferenceSchema>): ArtifactRef => ({
  ...r,
  sha256: r.hash.slice(7),
});
const Completion = z
  .object({
    stopReason: z.enum(["completed", "length-limit", "unknown"]),
    resolvedModel: z
      .string()
      .regex(/^[A-Za-z0-9._:/-]{1,200}$/)
      .optional(),
  })
  .strict();
const Failure = z.enum([
  "credit-exhausted",
  "rate-limited",
  "unauthorised",
  "unavailable",
  "bad-request",
  "bad-response",
  "response-too-large",
  "timeout",
  "cancelled",
  "interrupted",
]);

/** Raw responses are private audit artifacts, never accepted article/evidence artifacts. */
export const WriterAttemptManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    attemptId: z.string().regex(/^(writer|editorial)-attempt-[0-9a-f]{32}$/),
    purpose: z.enum(["assessor", "judge"]).optional(),
    input: ArtifactReferenceSchema,
    package: ArtifactReferenceSchema,
    source: ArtifactReferenceSchema,
    context: z.array(ArtifactReferenceSchema).max(10),
    kind: z.enum(["initial", "correction", "revision"]),
    number: z.number().int().min(1).max(100),
    revision: z.number().int().min(1).max(100).optional(),
    promptVersion: z.string().min(1).max(500),
    repairPromptVersion: z.string().min(1).max(500).optional(),
    requestedModel: z.string().min(1).max(300),
    completion: Completion,
    outcome: z.enum(["returned", "no-response", "interrupted", "accepted", "rejected"]),
    raw: ArtifactReferenceSchema.optional(),
    failure: Failure.optional(),
    diagnostic: ArtifactReferenceSchema.optional(),
    lateResponse: z.literal(true).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (!["no-response", "interrupted"].includes(m.outcome) && !m.raw)
      ctx.addIssue({ code: "custom", message: "returned output needs a raw reference" });
    if (["no-response", "interrupted"].includes(m.outcome) && (m.raw || !m.failure))
      ctx.addIssue({
        code: "custom",
        message: "unavailable response needs a failure, not invented text",
      });
    if (m.lateResponse && m.outcome === "accepted")
      ctx.addIssue({ code: "custom", message: "late output requires explicit rescue" });
  });
export type WriterAttemptManifest = z.infer<typeof WriterAttemptManifestSchema>;

/** Fixed domain refusal before any provider invocation; never a provider failure. */
export class WriterRecoveryGuardError extends Error {
  constructor(readonly code: "task-mismatch" | "not-denied" | "stale-base" | "deadline") {
    super(`editorial recovery guard: ${code}`);
    this.name = "WriterRecoveryGuardError";
  }
}
export interface ExpectedWriterRecovery {
  capture: z.infer<typeof ArtifactReferenceSchema>;
  descriptorHash: string;
  beforeNewCall?: () => Promise<void>;
}
export class WriterAttemptError extends Error {
  constructor(
    readonly code: "archive-failed" | "busy" | "interrupted",
    readonly artifact?: ArtifactRef,
    readonly reused?: boolean,
  ) {
    super(`writer attempt ${code}`);
    this.name = "WriterAttemptError";
  }
}

export interface CapturedWriterAttempt {
  manifest: WriterAttemptManifest;
  ref: ArtifactRef;
  text?: string;
  reused: boolean;
}

/** Read-only, hash-verified inspection; callers must not log/render raw text as HTML. */
export async function readWriterAttempt(
  content: Pick<GitArtifactStore, "read">,
  reference: ArtifactRef,
) {
  const manifest = WriterAttemptManifestSchema.parse(JSON.parse(await content.read(reference)));
  return { manifest, ...(manifest.raw ? { text: await content.read(fromRef(manifest.raw)) } : {}) };
}

/** Escaped text for a private inspection view, never ordinary status/telemetry. */
export function renderWriterAttemptText(text: string): string {
  return `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")}</pre>`;
}

/**
 * A capture owns one paid call. A committed response is reusable after a
 * crash, even if its manifest/state completion was interrupted. An expired
 * call with no durable response is never blindly called again.
 */
export async function captureWriterAttempt(input: {
  content: GitArtifactStore;
  operations: OperationStore;
  provider: ExtractionModelProvider;
  /** Assessor/judge share the established durable-call machinery, with separate truthful artifacts. */
  purpose?: "assessor" | "judge";
  request: Pick<
    Parameters<ExtractionModelProvider["complete"]>[0],
    "system" | "user" | "maxOutputChars"
  >;
  package: ArtifactRef;
  source: z.infer<typeof ArtifactReferenceSchema>;
  context: z.infer<typeof ArtifactReferenceSchema>[];
  kind: "initial" | "correction" | "revision";
  number: number;
  revision?: number;
  promptVersion: string;
  repairPromptVersion?: string;
  requestedModel?: string;
  signal: AbortSignal;
  /** Explicit operator recovery of a confirmed rejection before any response. */
  recoveryId?: string;
  /** Only the validated denied task may use this explicit recovery generation. */
  expectedRecovery?: ExpectedWriterRecovery;
  beforeNewCall?: () => Promise<void>;
  /** Must cover the configured request deadline plus durable capture. */
  leaseMs?: number;
}): Promise<CapturedWriterAttempt> {
  const prefix = input.purpose ? "editorial-attempt" : "writer-attempt";
  const directory = input.purpose ? "editorial-attempts" : "writer-attempts";
  const descriptor = {
    schemaVersion: 1,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    package: ref(input.package),
    source: input.source,
    context: input.context,
    kind: input.kind,
    number: input.number,
    ...(input.revision ? { revision: input.revision } : {}),
    promptVersion: input.promptVersion,
    ...(input.repairPromptVersion ? { repairPromptVersion: input.repairPromptVersion } : {}),
    requestedModel: input.requestedModel ?? input.provider.modelVersion,
    providerModel: input.provider.modelVersion,
    // Exact prompts and source/context are private corpus input, never logs.
    request: input.request,
  };
  const originalId = `${prefix}-${hash(JSON.stringify(descriptor)).slice(0, 32)}`;
  if (input.expectedRecovery) {
    const expected = input.expectedRecovery;
    const same = (
      a: z.infer<typeof ArtifactReferenceSchema>,
      b: z.infer<typeof ArtifactReferenceSchema>,
    ) =>
      a.repository === b.repository &&
      a.commit === b.commit &&
      a.path === b.path &&
      a.hash === b.hash;
    if (
      input.purpose !== "judge" ||
      !input.recoveryId ||
      !/^[0-9a-f]{64}$/.test(expected.descriptorHash) ||
      hash(JSON.stringify(descriptor)) !== expected.descriptorHash ||
      expected.capture.path !== `${directory}/${originalId}/manifest.json`
    )
      throw new WriterRecoveryGuardError("task-mismatch");
    const previous = await input.content.lookup(expected.capture.path);
    if (!previous || !same(ref(previous), expected.capture))
      throw new WriterRecoveryGuardError("not-denied");
    const manifest = WriterAttemptManifestSchema.parse(
      JSON.parse(await input.content.read(previous)),
    );
    if (
      manifest.purpose !== "judge" ||
      manifest.outcome !== "no-response" ||
      manifest.failure !== "unauthorised" ||
      manifest.raw ||
      manifest.lateResponse ||
      manifest.kind !== "initial" ||
      manifest.number !== 1 ||
      manifest.revision !== undefined ||
      manifest.repairPromptVersion !== undefined ||
      manifest.completion.stopReason !== "unknown" ||
      manifest.completion.resolvedModel !== undefined
    )
      throw new WriterRecoveryGuardError("not-denied");
    for (const name of ["response.txt", "completion.json", "late-response.json", "fence.json"])
      if (await input.content.lookup(`${directory}/${originalId}/${name}`))
        throw new WriterRecoveryGuardError("not-denied");
    const state = input.operations.operationStatus(`editorial-capture:${originalId}`);
    const accepted = z.object({ manifest: ArtifactRefSchema }).strict().safeParse(state?.artifact);
    if (
      state?.status !== "completed" ||
      !accepted.success ||
      !same(ref(accepted.data.manifest), expected.capture)
    )
      throw new WriterRecoveryGuardError("not-denied");
  }
  let id = originalId;
  if (input.recoveryId) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(input.recoveryId))
      throw new WriterAttemptError("interrupted");
    const originalRaw = await input.content.lookup(`${directory}/${originalId}/response.txt`);
    if (originalRaw) return captureWriterAttempt({ ...input, recoveryId: undefined });
    const original = await input.content.lookup(`${directory}/${originalId}/manifest.json`);
    // A new correction has no previous rejection to recover. Its normal
    // stable capture identity still owns and deduplicates the first call.
    if (!original) return captureWriterAttempt({ ...input, recoveryId: undefined });
    const previous = WriterAttemptManifestSchema.parse(
      JSON.parse(await input.content.read(original)),
    );
    if (
      previous.outcome !== "no-response" ||
      !["credit-exhausted", "rate-limited", "unauthorised", "bad-request"].includes(
        previous.failure ?? "",
      )
    )
      throw new WriterAttemptError("interrupted");
    // A deliberate recovery token is stable across retries and is recorded in
    // its input. Uncertain network failures never qualify for this escape.
    Object.assign(descriptor, { recovery: { id: input.recoveryId, previous: ref(original) } });
    id = `${prefix}-${hash(JSON.stringify(descriptor)).slice(0, 32)}`;
  }
  const dir = `${directory}/${id}`;
  const stateKey = `${input.purpose ? "editorial-capture" : "writer-capture"}:${id}`;
  let claim: OperationClaim | undefined;
  const safeWrite = async (path: string, value: unknown) => {
    try {
      return await writeOnce(input.content, path, value);
    } catch {
      throw new WriterAttemptError("archive-failed");
    }
  };
  const requestRef = await safeWrite(`${dir}/input.json`, descriptor);
  const base = {
    schemaVersion: 1 as const,
    attemptId: id,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    input: ref(requestRef),
    package: ref(input.package),
    source: input.source,
    context: input.context,
    kind: input.kind,
    number: input.number,
    ...(input.revision ? { revision: input.revision } : {}),
    promptVersion: input.promptVersion,
    ...(input.repairPromptVersion ? { repairPromptVersion: input.repairPromptVersion } : {}),
    requestedModel: input.requestedModel ?? input.provider.modelVersion,
  };
  let metadata: ModelCompletionMetadata = { stopReason: "unknown" };
  let replayDispatch: ArtifactRef | undefined;
  const rawRef = await input.content.lookup(`${dir}/response.txt`);
  if (rawRef) {
    const saved = await input.content.lookup(`${dir}/manifest.json`);
    const header = await input.content.lookup(`${dir}/completion.json`);
    if (header) {
      const data = JSON.parse(await input.content.read(header));
      if (data.outputHash !== rawRef.sha256) throw new WriterAttemptError("archive-failed");
      metadata = Completion.parse(data.completion);
      if (input.purpose && data.dispatch)
        replayDispatch = fromRef(ArtifactReferenceSchema.parse(data.dispatch));
    }
    const manifest = saved
      ? WriterAttemptManifestSchema.parse(JSON.parse(await input.content.read(saved)))
      : WriterAttemptManifestSchema.parse({
          ...base,
          completion: metadata,
          outcome: "returned",
          raw: ref(rawRef),
        });
    const manifestRef = saved ?? (await safeWrite(`${dir}/manifest.json`, manifest));
    if (["no-response", "interrupted"].includes(manifest.outcome))
      return { manifest, ref: manifestRef, reused: true };
    try {
      if (input.purpose) {
        if (!replayDispatch) throw new WriterAttemptError("interrupted", rawRef, true);
        const dispatch = z
          .object({
            attemptId: z.string(),
            claim: z
              .object({ key: z.string(), owner: z.string(), attempt: z.number().int().positive() })
              .strict(),
          })
          .strict()
          .parse(JSON.parse(await input.content.read(replayDispatch)));
        if (dispatch.attemptId !== id || dispatch.claim.key !== stateKey)
          throw new WriterAttemptError("interrupted", rawRef, true);
        let fence = await input.content.lookup(`${dir}/fence.json`);
        if (!fence) {
          const expires = input.operations.renewEditorialCapture(
            dispatch.claim,
            input.leaseMs ?? 10 * 60_000,
          );
          fence = await safeWrite(`${dir}/fence.json`, {
            attemptId: id,
            raw: ref(rawRef),
            expires,
          });
        }
        const proof = JSON.parse(await input.content.read(fence));
        if (proof.attemptId !== id || proof.raw.hash !== `sha256:${rawRef.sha256}`)
          throw new WriterAttemptError("interrupted", rawRef, true);
        input.operations.reconcileEditorialCapture(id, ref(manifestRef), dispatch.claim);
      } else
        input.operations.reconcileCompleted(stateKey, { raw: rawRef, manifest: manifestRef }, []);
    } catch (error) {
      throw error instanceof WriterAttemptError
        ? error
        : new WriterAttemptError(
            error instanceof OperationStoreError
              ? error.code === "busy"
                ? "busy"
                : error.code === "not-owner"
                  ? "interrupted"
                  : "archive-failed"
              : "archive-failed",
            manifestRef,
            true,
          );
    }
    return { manifest, ref: manifestRef, text: await input.content.read(rawRef), reused: true };
  }
  const prior = await input.content.lookup(`${dir}/manifest.json`);
  if (prior) {
    const manifest = WriterAttemptManifestSchema.parse(JSON.parse(await input.content.read(prior)));
    return {
      manifest,
      ref: prior,
      reused: true,
      ...(manifest.raw ? { text: await input.content.read(fromRef(manifest.raw)) } : {}),
    };
  }
  const leaseMs = z
    .number()
    .int()
    .min(1000)
    .max(20 * 60_000)
    .parse(input.leaseMs ?? 10 * 60_000);
  await input.expectedRecovery?.beforeNewCall?.();
  await input.beforeNewCall?.();
  const held = input.operations.claim(stateKey, "writer-attempt", leaseMs, 1);
  if (held.kind === "busy") throw new WriterAttemptError("busy");
  if (held.kind !== "claimed") {
    const manifest = WriterAttemptManifestSchema.parse({
      ...base,
      completion: metadata,
      outcome: "interrupted",
      failure: "interrupted",
    });
    return { manifest, ref: await safeWrite(`${dir}/manifest.json`, manifest), reused: true };
  }
  claim = held.claim;
  let captured: ArtifactRef | undefined;
  let retainedArtifact: ArtifactRef | undefined;
  let dispatchRef: ArtifactRef | undefined;
  let dispatched = false;
  let text: string | undefined;
  const capture = async (returned: string, info: ModelCompletionMetadata) => {
    const parsed = Completion.safeParse(info);
    metadata = parsed.success ? parsed.data : { stopReason: "unknown" };
    // Transport metadata is committed before the raw blob, so a restart can
    // never lose a known length-limit signal between those two commits.
    await safeWrite(`${dir}/completion.json`, {
      completion: metadata,
      outputHash: hash(returned),
      ...(dispatchRef ? { dispatch: ref(dispatchRef) } : {}),
    });
    // This Git commit MUST finish before the caller can parse or validate.
    try {
      captured = await input.content.write(`${dir}/response.txt`, returned, hash(returned));
    } catch {
      throw new WriterAttemptError("archive-failed");
    }
    text = returned;
  };
  try {
    if (input.purpose)
      dispatchRef = await safeWrite(`${dir}/dispatch-${claim.attempt}.json`, {
        attemptId: id,
        claim,
      });
    let failure: z.infer<typeof Failure> | undefined;
    try {
      dispatched = true;
      const returned = await input.provider.complete(
        {
          ...input.request,
          onCompletion: (info) => {
            const parsed = Completion.safeParse(info);
            metadata = parsed.success ? parsed.data : { stopReason: "unknown" };
          },
          onOutput: capture,
        },
        input.signal,
      );
      if (!captured) await capture(returned, metadata); // Other provider adapters retain the same guarantee.
      else if (hash(returned) !== captured.sha256) throw new WriterAttemptError("archive-failed");
    } catch (error) {
      if (error instanceof WriterAttemptError) throw error;
      failure =
        error instanceof ModelProviderError && Failure.safeParse(error.code).success
          ? error.code
          : "unavailable";
    }
    if (input.purpose && captured) {
      try {
        const expires = input.operations.renewEditorialCapture(claim, leaseMs);
        await safeWrite(`${dir}/fence.json`, { attemptId: id, raw: ref(captured), expires });
      } catch (error) {
        if (!(error instanceof OperationStoreError && error.code === "not-owner"))
          throw error instanceof WriterAttemptError
            ? error
            : new WriterAttemptError("archive-failed", captured);
        const late = await safeWrite(`${dir}/late-response.json`, {
          attemptId: id,
          raw: ref(captured),
          lateResponse: true,
        });
        throw new WriterAttemptError("interrupted", late, false);
      }
    }
    const manifest = WriterAttemptManifestSchema.parse({
      ...base,
      completion: metadata,
      ...(captured
        ? { outcome: "returned", raw: ref(captured), ...(failure ? { failure } : {}) }
        : { outcome: "no-response", failure: failure ?? "unavailable" }),
    });
    const manifestRef = await safeWrite(`${dir}/manifest.json`, manifest);
    retainedArtifact = manifestRef;
    const retained = WriterAttemptManifestSchema.parse(
      JSON.parse(await input.content.read(manifestRef)),
    );
    if (["interrupted", "no-response"].includes(retained.outcome) && captured) {
      await safeWrite(`${dir}/late-response.json`, { ...manifest, lateResponse: true });
      throw new WriterAttemptError("interrupted");
    }
    if (input.purpose && captured)
      input.operations.completeEditorialCapture(claim, ref(manifestRef));
    else
      input.operations.complete(
        claim,
        { manifest: manifestRef, ...(captured ? { raw: captured } : {}) },
        [],
      );
    claim = undefined;
    return {
      manifest: retained,
      ref: manifestRef,
      ...(text !== undefined ? { text } : {}),
      reused: false,
    };
  } catch (error) {
    const storage =
      input.purpose &&
      !(error instanceof WriterAttemptError && error.code === "interrupted") &&
      !(error instanceof OperationStoreError && error.code === "not-owner");
    if (claim) {
      try {
        if (input.purpose && !dispatched && storage) input.operations.yieldClaim(claim);
        else if (!storage || !captured)
          input.operations.fail(claim, "writer-capture-incomplete", false);
        // A retained editorial response keeps its claim for fenced replay after transient storage failure.
      } catch {
        /* expired owner cannot alter state */
      }
    }
    throw error instanceof WriterAttemptError
      ? error
      : new WriterAttemptError(storage ? "archive-failed" : "interrupted", retainedArtifact);
  }
}

export async function finishWriterValidation(input: {
  content: GitArtifactStore;
  attempt: CapturedWriterAttempt;
  accepted: boolean;
  diagnostic?: ArtifactRef;
}): Promise<ArtifactRef> {
  const m = input.attempt.manifest;
  if (!m.raw) return input.attempt.ref;
  if (m.lateResponse) throw new WriterAttemptError("interrupted");
  const final = WriterAttemptManifestSchema.parse({
    ...m,
    outcome: input.accepted ? "accepted" : "rejected",
    ...(input.diagnostic ? { diagnostic: ref(input.diagnostic) } : {}),
  });
  return writeOnce(input.content, `writer-attempts/${m.attemptId}/validation.json`, final);
}
