import { z } from "zod";
import { ConfigurationController } from "../controllers/configuration.js";
import { SETTINGS } from "./settings.js";
import { EditorialPolicySchema } from "../workflow/editorial-contract.js";

const keys = [
  "STEELE_EDITORIAL_MAX_REVISIONS",
  "STEELE_EDITORIAL_EXHAUSTION_ACTION",
  "STEELE_EDITORIAL_DEADLINE_MS",
] as const;
/** Only the non-secret decision actually applied is journaled, never full settings. */
export const EditorialPolicyObservationSchema = z
  .object({
    version: z.literal("live-editorial-policy-v1"),
    policy: EditorialPolicySchema,
    revision: z.string().regex(/^config-sha256:[0-9a-f]{32}$/),
  })
  .strict();
export type EditorialPolicyObservation = z.infer<typeof EditorialPolicyObservationSchema>;

/** A single file read makes each policy boundary coherent across atomic owner edits. */
export function editorialPolicyFromConfiguration(
  options: {
    env?: NodeJS.ProcessEnv;
    read?: (path: string) => Promise<string>;
  } = {},
): () => Promise<EditorialPolicyObservation> {
  return async () => {
    const env = options.env ?? process.env;
    const handler = new ConfigurationController({
      env,
      settingsFile: env.STEELE_CONFIG_PATH,
      salt: "public-editorial-policy-v1",
      registry: SETTINGS.filter((setting) => (keys as readonly string[]).includes(setting.key)),
      roles: { editorial: keys },
      ...(options.read ? { read: options.read } : {}),
    });
    const observed = await handler.currentSettings("editorial", keys);
    const value = (key: (typeof keys)[number]) =>
      observed.settings.find((setting) => setting.key === key)!.value;
    return EditorialPolicyObservationSchema.parse({
      version: "live-editorial-policy-v1",
      policy: {
        version: "assess-judge-v1",
        maxRevisions: value(keys[0]),
        onExhausted: value(keys[1]),
        deadlineMs: value(keys[2]),
      },
      revision: observed.revision,
    });
  };
}
