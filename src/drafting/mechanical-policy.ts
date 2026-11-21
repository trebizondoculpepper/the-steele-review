import { z } from "zod";

/** Total writer turns: initial output plus corrections, never extra retries. */
export const MechanicalPolicySchema = z
  .object({
    maxTurns: z.number().int().min(1).max(10).default(3),
    deadlineMs: z.number().int().min(1).max(900_000).default(300_000),
  })
  .strict();
export type MechanicalPolicy = z.infer<typeof MechanicalPolicySchema>;
export function writerMechanicalPolicy(env: NodeJS.ProcessEnv): MechanicalPolicy {
  return MechanicalPolicySchema.parse({
    ...(env.STEELE_WRITER_TURN_LIMIT?.trim()
      ? { maxTurns: Number(env.STEELE_WRITER_TURN_LIMIT) }
      : {}),
    ...(env.STEELE_WRITER_DEADLINE_MS?.trim()
      ? { deadlineMs: Number(env.STEELE_WRITER_DEADLINE_MS) }
      : {}),
  });
}
