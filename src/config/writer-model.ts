export const DEFAULT_WRITER_MODEL = "anthropic/claude-opus-5.5";

export function writerModel(env: NodeJS.ProcessEnv, requested?: string): string {
  return requested ?? (env.STEELE_MODEL_WRITER?.trim() || DEFAULT_WRITER_MODEL);
}
