import { z } from "zod";

/**
 * Bounded, private diagnostics for rejected extraction candidates (#183).
 *
 * A rejected candidate is kept as untrusted diagnostic data so a reviewer can
 * see *which* proposed theme or claim failed and why. It is never an accepted
 * theme or claim. Only allowlisted string fields of the model's candidate are
 * copied, each truncated, with control characters removed and secret-like
 * tokens redacted; arbitrary extra fields are dropped. Operational logs keep
 * reporting counts and codes only; these details live in the private
 * extraction artifacts.
 */

export const RejectionStageSchema = z
  .enum(["schema", "grounding", "semantic"])
  .describe(
    "schema: malformed/invalid structure; grounding: quote or reference not found; semantic: refinement or identity rules.",
  );
export type RejectionStage = z.infer<typeof RejectionStageSchema>;

export const MAX_DIAGNOSTIC_FIELD = 500;
export const MAX_EXCERPT = 1_000;

export const CandidateSnapshotSchema = z
  .object({
    fields: z.record(z.string(), z.string().max(MAX_DIAGNOSTIC_FIELD + 1)),
    truncated: z.boolean(),
  })
  .strict();
export type CandidateSnapshot = z.infer<typeof CandidateSnapshotSchema>;

// Long tokens that look like credentials: provider keys, bearer tokens,
// JWT-like strings and long hex/base64 runs.
const SECRET_LIKE =
  /\b(?:sk|pk|rk|ghp|gho|glpat|xox[abp])[-_][A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?|\b[A-Fa-f0-9]{40,}\b/g;

// Long base64-like runs: matched greedily once, then checked in a callback,
// so scanning is linear (no lookahead re-scans).
const LONG_RUN = /[A-Za-z0-9+/]{48,}={0,2}/g;
const isKeyLike = (run: string) => /\d/.test(run) && /[A-Za-z]/.test(run);

/** Make untrusted text safe to keep: no control characters, secrets redacted, bounded. */
export function safeText(value: string, max: number): { text: string; truncated: boolean } {
  // Strip C0/C1 control characters except newline and tab.
  // Bound the work first: only a little more than the kept length is scanned,
  // with slack so a secret straddling the cut is still recognised.
  const window = value.length > max + 256 ? value.slice(0, max + 256) : value;
  const cleaned = window
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(SECRET_LIKE, "[redacted]")
    .replace(LONG_RUN, (run) => (isKeyLike(run) ? "[redacted]" : run));
  return cleaned.length > max || window.length < value.length
    ? { text: `${cleaned.slice(0, max)}…`, truncated: true }
    : { text: cleaned, truncated: false };
}

/** Copy only allowlisted string fields of an untrusted candidate. */
export function candidateSnapshot(item: unknown, allow: readonly string[]): CandidateSnapshot {
  const fields: Record<string, string> = {};
  let truncated = false;
  if (item && typeof item === "object" && !Array.isArray(item)) {
    for (const key of allow) {
      const value = (item as Record<string, unknown>)[key];
      if (typeof value !== "string") continue;
      const safe = safeText(value, MAX_DIAGNOSTIC_FIELD);
      fields[key] = safe.text;
      truncated ||= safe.truncated;
    }
  }
  return { fields, truncated };
}

/** Bounded excerpt of a malformed (non-JSON or invalid) model response. */
export const MalformedResponseSchema = z
  .object({
    attempt: z.number().int().positive(),
    stage: z.literal("schema"),
    reason: z.enum(["not-json", "invalid-structure", "too-large"]),
    length: z.number().int().nonnegative(),
    excerpt: z.string().max(MAX_EXCERPT + 1),
    truncated: z.boolean(),
  })
  .strict();
export type MalformedResponse = z.infer<typeof MalformedResponseSchema>;

export function malformedResponse(
  attempt: number,
  raw: string,
  maxChars: number,
): MalformedResponse {
  let reason: MalformedResponse["reason"] = "invalid-structure";
  if (raw.length > maxChars) reason = "too-large";
  else {
    try {
      JSON.parse(raw.trim().replace(/^```(?:json)?\n([\s\S]*)\n```$/, "$1"));
    } catch {
      reason = "not-json";
    }
  }
  const safe = safeText(raw, MAX_EXCERPT);
  return {
    attempt,
    stage: "schema",
    reason,
    length: raw.length,
    excerpt: safe.text,
    truncated: safe.truncated,
  };
}

/** Minimal artifact-writer port, so this module does not depend on Git. */
export interface DiagnosticWriter {
  write(path: string, content: string): Promise<unknown>;
}

/**
 * Best-effort private record of a failed extraction run (bounded, redacted).
 * A diagnostics write failure never changes the extraction outcome.
 */
export async function saveFailureDiagnostics(
  artifacts: DiagnosticWriter,
  basePath: string,
  details: { reason: string; attempts: number; malformed: MalformedResponse[] },
): Promise<void> {
  const path = basePath.replace(/\.json$/, `-${Date.now()}.json`);
  try {
    await artifacts.write(path, `${JSON.stringify({ schemaVersion: 1, ...details }, null, 2)}\n`);
  } catch {
    // Diagnostics only.
  }
}
