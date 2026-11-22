import { z } from "zod";
import { ConfigurationController } from "../controllers/configuration.js";
import {
  RESEARCH_MAX_TOKENS,
  RESEARCH_TOKEN_SETTING,
  ResearchMaxTokensSchema,
} from "./settings.js";

/** Non-secret applied decision only; never file paths or full configuration. */
export const AppliedResearchTokensSchema = z
  .object({
    maxOutputTokens: ResearchMaxTokensSchema,
    source: z.enum(["environment", "file", "default"]),
    revision: z.string().min(1).max(200),
  })
  .strict();
export type AppliedResearchTokens = z.infer<typeof AppliedResearchTokensSchema>;
export type ResearchTokensReader = () => Promise<AppliedResearchTokens>;

/** Existing generic JSON settings-file source; credentials stay separate. */
export function researchTokensFromConfiguration(
  options: {
    env?: NodeJS.ProcessEnv;
    read?: (path: string) => Promise<string>;
  } = {},
): ResearchTokensReader {
  return async () => {
    const env = options.env ?? process.env;
    const controller = new ConfigurationController({
      settingsFile: env.STEELE_SETTINGS_FILE,
      env,
      salt: "public-research-token-setting-v1",
      registry: [RESEARCH_TOKEN_SETTING],
      roles: { research: [RESEARCH_MAX_TOKENS] },
      ...(options.read ? { read: options.read } : {}),
    });
    const selected = await controller.currentSetting("research", RESEARCH_MAX_TOKENS);
    return AppliedResearchTokensSchema.parse({
      maxOutputTokens: selected.value,
      source: selected.source,
      revision: selected.revision,
    });
  };
}
