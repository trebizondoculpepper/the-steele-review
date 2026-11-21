import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { writeOnce } from "../research/job.js";

export const DraftValidationKindSchema = z.enum([
  "json-syntax",
  "schema-validation",
  "truncated-output",
  "evidence-validation",
]);
export type DraftValidationKind = z.infer<typeof DraftValidationKindSchema>;

// Do not retain Zod messages, arbitrary keys, expected/received values or
// provider exception strings. Only schema-owned names can reach a diagnostic.
const FIELD_NAMES = [
  "title",
  "subtitle",
  "excerpt",
  "summary",
  "themes",
  "responses",
  "claimRecordId",
  "verdict",
  "text",
  "evidence",
  "limitations",
  "narrative",
  "widerContext",
  "status",
  "history",
  "background",
  "limitation",
] as const;
const FIELDS = new Set<string>(FIELD_NAMES);
const CODES = [
  "invalid_type",
  "too_big",
  "too_small",
  "invalid_format",
  "invalid_union",
  "unrecognized_keys",
  "invalid_value",
  "not_multiple_of",
  "invalid_key",
  "invalid_element",
  "custom",
] as const;
const SafeIssueSchema = z
  .object({
    code: z.enum(CODES),
    path: z
      .array(z.union([z.enum([...FIELD_NAMES, "unknown"]), z.number().int().min(0).max(999)]))
      .max(12),
  })
  .strict();
export type SafeDraftIssue = z.infer<typeof SafeIssueSchema>;

export function safeDraftIssues(error: z.ZodError): SafeDraftIssue[] {
  return error.issues.slice(0, 30).map((issue) =>
    SafeIssueSchema.parse({
      code: (CODES as readonly string[]).includes(issue.code) ? issue.code : "custom",
      path: issue.path
        .slice(0, 12)
        .map((part) =>
          typeof part === "number" && Number.isInteger(part) && part >= 0 && part <= 999
            ? part
            : typeof part === "string" && FIELDS.has(part)
              ? part
              : "unknown",
        ),
    }),
  );
}

export const DraftAttemptDiagnosticSchema = z
  .object({
    schemaVersion: z.literal(1),
    package: ArtifactReferenceSchema,
    attempt: z.number().int().min(1).max(10),
    promptVersion: z.string().min(1).max(500),
    repairPromptVersion: z.string().min(1).max(500).optional(),
    modelVersion: z.string().min(1).max(300),
    kind: DraftValidationKindSchema,
    issues: z.array(SafeIssueSchema).max(30),
    outputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    outputChars: z.number().int().min(0).max(40_000),
    completion: z.enum(["completed", "length-limit", "unknown"]),
    writerAttempt: ArtifactReferenceSchema.optional(),
  })
  .strict();

export async function saveDraftDiagnostic(input: {
  content: GitArtifactStore;
  package: ArtifactRef;
  baseKey: string;
  attempt: number;
  promptVersion: string;
  repairPromptVersion?: string;
  modelVersion: string;
  kind: DraftValidationKind;
  issues: SafeDraftIssue[];
  raw: string;
  completion: "completed" | "length-limit" | "unknown";
  writerAttempt?: ArtifactRef;
}): Promise<ArtifactRef> {
  const diagnostic = DraftAttemptDiagnosticSchema.parse({
    schemaVersion: 1,
    package: {
      repository: input.package.repository,
      commit: input.package.commit,
      path: input.package.path,
      hash: `sha256:${input.package.sha256}`,
    },
    attempt: input.attempt,
    promptVersion: input.promptVersion,
    ...(input.repairPromptVersion ? { repairPromptVersion: input.repairPromptVersion } : {}),
    modelVersion: input.modelVersion,
    kind: input.kind,
    issues: input.issues,
    outputHash: `sha256:${createHash("sha256").update(input.raw).digest("hex")}`,
    outputChars: input.raw.length,
    completion: input.completion,
    ...(input.writerAttempt
      ? {
          writerAttempt: {
            repository: input.writerAttempt.repository,
            commit: input.writerAttempt.commit,
            path: input.writerAttempt.path,
            hash: `sha256:${input.writerAttempt.sha256}`,
          },
        }
      : {}),
  });
  const body = `${JSON.stringify(diagnostic, null, 2)}\n`;
  const hash = createHash("sha256").update(body).digest("hex");
  return writeOnce(input.content, `draft-diagnostics/${input.baseKey}/${hash}.json`, body);
}
