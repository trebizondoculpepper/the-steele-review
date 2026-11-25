import { z } from "zod";

export const DEFAULT_RESEARCH_MODEL = "perplexity/sonar-deep-research";
export const ResearchModelSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:/-]{1,200}$/);

/** Only optional environment settings treat blank values as absent. Explicit overrides stay strict. */
export const ResearchModelSelectionSchema = z
  .object({
    configured: z.string().optional(),
    requested: z.string().optional(),
  })
  .transform(
    ({ configured, requested }) =>
      requested ?? (configured?.trim() || DEFAULT_RESEARCH_MODEL),
  )
  .pipe(ResearchModelSchema);

export function researchModel(
  env: NodeJS.ProcessEnv,
  requested?: string,
): string {
  return ResearchModelSelectionSchema.parse({
    configured: env.STEELE_RESEARCH_MODEL,
    requested,
  });
}
