import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { writeOnce } from "../research/job.js";
import { MechanicalPolicySchema } from "./mechanical-policy.js";

const ref = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});
export const MechanicalRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    package: ArtifactReferenceSchema,
    start: ArtifactReferenceSchema,
    policy: MechanicalPolicySchema,
    outcome: z.enum([
      "in-progress",
      "valid",
      "turns-exhausted",
      "deadline-exhausted",
      "provider-failed",
      "application-format-failed",
    ]),
    turns: z
      .array(
        z
          .object({
            number: z.number().int().min(1).max(10),
            mode: z.enum(["initial", "metadata-fields", "format-schema", "evidence"]),
            attempt: ArtifactReferenceSchema,
            candidate: ArtifactReferenceSchema.optional(),
            diagnostic: ArtifactReferenceSchema.optional(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type MechanicalRecord = z.infer<typeof MechanicalRecordSchema>;
export async function saveMechanicalRecord(
  content: GitArtifactStore,
  record: MechanicalRecord,
): Promise<ArtifactRef> {
  const text = `${JSON.stringify(MechanicalRecordSchema.parse(record), null, 2)}\n`;
  const hash = createHash("sha256").update(text).digest("hex");
  return writeOnce(content, `writer-mechanical-runs/${hash}.json`, text);
}
export async function mechanicalStart(
  content: GitArtifactStore,
  identity: unknown,
  policy: z.infer<typeof MechanicalPolicySchema>,
) {
  const id = createHash("sha256")
    .update(JSON.stringify([identity, policy]))
    .digest("hex");
  const now = Date.now();
  const saved = await writeOnce(content, `writer-mechanical-runs/${id}/start.json`, {
    schemaVersion: 1,
    policy,
    startedAt: now,
    deadlineAt: now + policy.deadlineMs,
  });
  const start = z
    .object({
      schemaVersion: z.literal(1),
      policy: MechanicalPolicySchema,
      startedAt: z.number().int().nonnegative(),
      deadlineAt: z.number().int().nonnegative(),
    })
    .strict()
    .parse(JSON.parse(await content.read(saved)));
  return { ref: saved, deadlineAt: start.deadlineAt };
}

/** Commit a derived candidate before validating it; this is not model output or approval. */
export async function commitMergedCandidate(
  content: GitArtifactStore,
  candidate: Record<string, unknown>,
  parents: ArtifactRef[],
) {
  const text = JSON.stringify(candidate);
  const hash = createHash("sha256").update(text).digest("hex");
  const raw = await writeOnce(content, `writer-candidates/${hash}.json`, text);
  const manifest = {
    schemaVersion: 1,
    kind: "metadata-field-merge",
    candidate: ref(raw),
    parents: parents.map(ref),
  };
  const identity = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  await writeOnce(content, `writer-candidates/${identity}.manifest.json`, manifest);
  return raw;
}
export { ref as mechanicalRef };
