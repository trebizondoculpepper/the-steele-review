import { ConfigurationController } from "../controllers/configuration.js";
import { PUBLISH_WITHOUT_EMAIL, SETTINGS } from "./settings.js";

/**
 * The live list of posts the Substack publisher publishes without subscriber
 * email (#388). Each call reads current validated settings through the
 * configuration handler, so an owner edit applies to the next delivery
 * without a restart.
 */
export function publishWithoutEmailFromConfiguration(
  options: {
    env?: NodeJS.ProcessEnv;
    read?: (path: string) => Promise<string>;
  } = {},
): () => Promise<ReadonlySet<string>> {
  return async () => {
    const env = options.env ?? process.env;
    const handler = new ConfigurationController({
      env,
      settingsFile: env.STEELE_CONFIG_PATH,
      salt: "public-publish-email-policy-v1",
      registry: SETTINGS.filter((s) => s.key === PUBLISH_WITHOUT_EMAIL),
      roles: { publisher: [PUBLISH_WITHOUT_EMAIL] },
      ...(options.read ? { read: options.read } : {}),
    });
    const observed = await handler.currentSettings("publisher", [
      PUBLISH_WITHOUT_EMAIL,
    ]);
    return new Set(observed.settings[0]!.value as string[]);
  };
}
