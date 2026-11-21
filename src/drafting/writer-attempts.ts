import { createHash } from "node:crypto";
import { z } from "zod";
import type { ExtractionModelProvider, ModelCompletionMetadata } from "../analysis/extraction.js";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
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
    attemptId: z.string().regex(/^writer-attempt-[0-9a-f]{32}$/),
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

export class WriterAttemptError extends Error {
  constructor(readonly code: "archive-failed" | "busy" | "interrupted") {
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
  /** Must cover the configured request deadline plus durable capture. */
  leaseMs?: number;
}): Promise<CapturedWriterAttempt> {
  const descriptor = {
    schemaVersion: 1,
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
  const originalId = `writer-attempt-${hash(JSON.stringify(descriptor)).slice(0, 32)}`;
  let id = originalId;
  if (input.recoveryId) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(input.recoveryId))
      throw new WriterAttemptError("interrupted");
    const originalRaw = await input.content.lookup(`writer-attempts/${originalId}/response.txt`);
    if (originalRaw) return captureWriterAttempt({ ...input, recoveryId: undefined });
    const original = await input.content.lookup(`writer-attempts/${originalId}/manifest.json`);
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
    id = `writer-attempt-${hash(JSON.stringify(descriptor)).slice(0, 32)}`;
  }
  const dir = `writer-attempts/${id}`;
  const stateKey = `writer-capture:${id}`;
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
  const rawRef = await input.content.lookup(`${dir}/response.txt`);
  if (rawRef) {
    const saved = await input.content.lookup(`${dir}/manifest.json`);
    const header = await input.content.lookup(`${dir}/completion.json`);
    if (header) {
      const data = JSON.parse(await input.content.read(header));
      if (data.outputHash !== rawRef.sha256) throw new WriterAttemptError("archive-failed");
      metadata = Completion.parse(data.completion);
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
      input.operations.reconcileCompleted(stateKey, { raw: rawRef, manifest: manifestRef }, []);
    } catch (error) {
      throw new WriterAttemptError(
        error instanceof OperationStoreError && error.code === "busy" ? "busy" : "interrupted",
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
  let text: string | undefined;
  const capture = async (returned: string, info: ModelCompletionMetadata) => {
    const parsed = Completion.safeParse(info);
    metadata = parsed.success ? parsed.data : { stopReason: "unknown" };
    // Transport metadata is committed before the raw blob, so a restart can
    // never lose a known length-limit signal between those two commits.
    await safeWrite(`${dir}/completion.json`, { completion: metadata, outputHash: hash(returned) });
    // This Git commit MUST finish before the caller can parse or validate.
    try {
      captured = await input.content.write(`${dir}/response.txt`, returned, hash(returned));
    } catch {
      throw new WriterAttemptError("archive-failed");
    }
    text = returned;
  };
  try {
    let failure: z.infer<typeof Failure> | undefined;
    try {
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
    const manifest = WriterAttemptManifestSchema.parse({
      ...base,
      completion: metadata,
      ...(captured
        ? { outcome: "returned", raw: ref(captured), ...(failure ? { failure } : {}) }
        : { outcome: "no-response", failure: failure ?? "unavailable" }),
    });
    const manifestRef = await safeWrite(`${dir}/manifest.json`, manifest);
    const retained = WriterAttemptManifestSchema.parse(
      JSON.parse(await input.content.read(manifestRef)),
    );
    if (["interrupted", "no-response"].includes(retained.outcome) && captured) {
      await safeWrite(`${dir}/late-response.json`, { ...manifest, lateResponse: true });
      throw new WriterAttemptError("interrupted");
    }
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
    if (claim) {
      try {
        input.operations.fail(claim, "writer-capture-incomplete", false);
      } catch {
        /* expired owner cannot alter state */
      }
    }
    throw error instanceof WriterAttemptError ? error : new WriterAttemptError("interrupted");
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
