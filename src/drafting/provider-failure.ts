import { z } from "zod";
import { ModelProviderError } from "../controllers/openrouter.js";

/**
 * Safe provider-failure facts kept on a failed editorial attempt (#800): the
 * error code and HTTP status, the model role, a recognised limit category and
 * sizes. Never provider response text, credentials or article inputs.
 */
export const ProviderFailureSchema = z
  .object({
    role: z.enum(["assessment", "judgment"]),
    code: z.string().max(40),
    status: z.number().int().optional(),
    limitCategory: z
      .enum(["max-tokens-unaffordable", "insufficient-credits", "key-limit", "unspecified"])
      .optional(),
    affordableTokens: z.number().int().min(0).optional(),
    requestedMaxTokens: z.number().int().min(0).optional(),
    inputChars: z.number().int().min(0).optional(),
    model: z.string().max(200).optional(),
  })
  .strict();
export type ProviderFailure = z.infer<typeof ProviderFailureSchema>;

/** The allowlisted facts of a provider error, or undefined for any other error. */
export function providerFailureOf(
  error: unknown,
  role: ProviderFailure["role"],
): ProviderFailure | undefined {
  if (!(error instanceof ModelProviderError)) return undefined;
  const f = error.failure ?? {};
  return ProviderFailureSchema.parse({
    role,
    code: error.code,
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(f.limitCategory ? { limitCategory: f.limitCategory } : {}),
    ...(f.affordableTokens !== undefined ? { affordableTokens: f.affordableTokens } : {}),
    ...(f.requestedMaxTokens !== undefined ? { requestedMaxTokens: f.requestedMaxTokens } : {}),
    ...(f.inputChars !== undefined ? { inputChars: f.inputChars } : {}),
    ...(f.model ? { model: f.model.slice(0, 200) } : {}),
  });
}

/** The provider facts retained on a durable attempt manifest (no role or code). */
export const ProviderDiagnosticsSchema = ProviderFailureSchema.omit({ role: true, code: true });
export type ProviderDiagnostics = z.infer<typeof ProviderDiagnosticsSchema>;

/** The allowlisted diagnostics of a provider error, for durable retention. */
export function providerDiagnosticsOf(error: unknown): ProviderDiagnostics | undefined {
  if (!(error instanceof ModelProviderError)) return undefined;
  const { role: _role, code: _code, ...rest } = providerFailureOf(error, "assessment")!;
  return Object.keys(rest).length ? rest : undefined;
}

/** Rebuilds a provider error from a retained manifest, keeping its diagnostics. */
export function providerErrorWith(
  code: ConstructorParameters<typeof ModelProviderError>[0],
  diagnostics?: ProviderDiagnostics,
): ModelProviderError {
  const error = new ModelProviderError(code, diagnostics?.status);
  if (diagnostics) {
    const { status: _status, ...failure } = diagnostics;
    error.failure = failure;
  }
  return error;
}
