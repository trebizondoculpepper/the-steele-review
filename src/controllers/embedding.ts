import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Embedding controller: the only code that talks to an embedding provider.
 * The provider is injected; none is configured yet, so choosing one (and its
 * credentials) is a deployment dependency, not something this module invents.
 *
 * Every vector carries its model identity (provider, model, version) and
 * dimensions. Vectors from different models or dimensions belong to
 * different vector spaces and must never be compared or stored together;
 * {@link assertSameVectorSpace} enforces that. Batches, timeouts and retries
 * are bounded, and provider output is validated: one finite vector of the
 * expected dimension per input.
 */

export const EmbeddingModelSchema = z
  .object({
    provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    model: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    dimensions: z.number().int().min(1).max(65_536),
  })
  .strict();
export type EmbeddingModel = z.infer<typeof EmbeddingModelSchema>;

/** Stable identifier of one vector space: model identity plus dimensions. */
export function vectorSpaceId(model: EmbeddingModel): string {
  return `${model.provider}/${model.model}@${model.version}#${model.dimensions}`;
}

const InputHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const EmbeddingVectorSchema = z
  .object({
    inputId: z.string().min(1).max(512),
    inputHash: InputHashSchema,
    model: EmbeddingModelSchema,
    vectorSpace: z.string().min(1),
    vector: z.array(z.number().finite()).min(1),
  })
  .strict()
  .refine((v) => v.vector.length === v.model.dimensions, "vector length must equal dimensions")
  .refine((v) => v.vectorSpace === vectorSpaceId(v.model), "vectorSpace must match model");
export type EmbeddingVector = z.infer<typeof EmbeddingVectorSchema>;

export interface EmbeddingInput {
  /** Caller's identifier, e.g. a passage ID. */
  id: string;
  text: string;
  /** sha256:<hex> of `text`; verified so a vector can never be filed under the wrong input. */
  inputHash: string;
}

/** Injected provider client. Receives texts, returns one vector per text, in order. */
export interface EmbeddingProvider {
  readonly model: EmbeddingModel;
  /** Largest batch the provider accepts. */
  readonly maxBatchSize: number;
  embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
}

export type EmbeddingFailure =
  | "invalid-input"
  | "provider-failed"
  | "invalid-output"
  | "timeout"
  | "cancelled";

export class EmbeddingError extends Error {
  constructor(
    readonly reason: EmbeddingFailure,
    readonly retryable: boolean,
    /** Vectors completed before the failing batch, in input order. */
    readonly completed: EmbeddingVector[] = [],
  ) {
    super(`embedding ${reason}`);
    this.name = "EmbeddingError";
  }
}

export class VectorSpaceMismatchError extends Error {
  constructor() {
    super("vectors belong to different embedding spaces");
    this.name = "VectorSpaceMismatchError";
  }
}

/** Refuse to combine vectors from different models, versions or dimensions. */
export function assertSameVectorSpace(vectors: Array<Pick<EmbeddingVector, "vectorSpace">>): void {
  const spaces = new Set(vectors.map((v) => v.vectorSpace));
  if (spaces.size > 1) throw new VectorSpaceMismatchError();
}

export function inputHashFor(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export interface EmbeddingControllerConfig {
  provider: EmbeddingProvider;
  batchSize?: number;
  /** Per-batch time bound. */
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxInputChars?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export class EmbeddingController {
  readonly model: EmbeddingModel;
  readonly vectorSpace: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxInputChars: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly config: EmbeddingControllerConfig) {
    this.model = EmbeddingModelSchema.parse(config.provider.model);
    this.vectorSpace = vectorSpaceId(this.model);
    const providerMax = Math.max(1, Math.floor(config.provider.maxBatchSize));
    this.batchSize = Math.max(1, Math.min(config.batchSize ?? 32, providerMax, 512));
    this.timeoutMs = Math.max(1_000, Math.min(config.timeoutMs ?? 30_000, 5 * 60_000));
    this.maxAttempts = Math.max(1, Math.min(config.maxAttempts ?? 3, 5));
    this.retryDelayMs = Math.max(0, config.retryDelayMs ?? 1_000);
    this.maxInputChars = Math.max(1, config.maxInputChars ?? 8_000);
    this.sleep = config.sleep ?? defaultSleep;
  }

  /** Embed inputs in bounded batches, returning one validated vector per input, in order. */
  async embed(inputs: EmbeddingInput[], signal?: AbortSignal): Promise<EmbeddingVector[]> {
    for (const input of inputs) {
      if (
        !input.id ||
        input.text.length === 0 ||
        input.text.length > this.maxInputChars ||
        input.inputHash !== inputHashFor(input.text)
      ) {
        throw new EmbeddingError("invalid-input", false);
      }
    }
    const results: EmbeddingVector[] = [];
    for (let at = 0; at < inputs.length; at += this.batchSize) {
      const batch = inputs.slice(at, at + this.batchSize);
      try {
        results.push(...(await this.embedBatch(batch, signal)));
      } catch (error) {
        const failure =
          error instanceof EmbeddingError ? error : new EmbeddingError("provider-failed", true);
        throw new EmbeddingError(failure.reason, failure.retryable, [...results]);
      }
    }
    return results;
  }

  private async embedBatch(
    batch: EmbeddingInput[],
    outer?: AbortSignal,
  ): Promise<EmbeddingVector[]> {
    let last = new EmbeddingError("provider-failed", true);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (outer?.aborted) throw new EmbeddingError("cancelled", false);
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
      try {
        const raw = await raceAbort(
          this.config.provider.embed(
            batch.map((b) => b.text),
            signal,
          ),
          signal,
        );
        return this.validate(batch, raw);
      } catch (error) {
        if (outer?.aborted) throw new EmbeddingError("cancelled", false);
        last =
          error instanceof EmbeddingError
            ? error
            : timeout.aborted
              ? new EmbeddingError("timeout", true)
              : new EmbeddingError("provider-failed", true);
        if (!last.retryable || attempt === this.maxAttempts) break;
        try {
          await this.sleep(
            this.retryDelayMs * 2 ** (attempt - 1),
            outer ?? new AbortController().signal,
          );
        } catch {
          throw new EmbeddingError("cancelled", false);
        }
      }
    }
    throw last;
  }

  private validate(batch: EmbeddingInput[], raw: unknown): EmbeddingVector[] {
    if (!Array.isArray(raw) || raw.length !== batch.length) {
      throw new EmbeddingError("invalid-output", false);
    }
    return batch.map((input, index) => {
      const parsed = EmbeddingVectorSchema.safeParse({
        inputId: input.id,
        inputHash: input.inputHash,
        model: this.model,
        vectorSpace: this.vectorSpace,
        vector: raw[index],
      });
      if (!parsed.success) throw new EmbeddingError("invalid-output", false);
      return parsed.data;
    });
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
