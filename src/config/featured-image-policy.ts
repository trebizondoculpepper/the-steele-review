import { ConfigurationController } from "../controllers/configuration.js";
import { FEATURED_IMAGE, SETTINGS } from "./settings.js";

export type FeaturedImagePolicy = "off" | "source-preview";

/**
 * The live featured-image policy (#894), read through the configuration
 * handler before each delivery. Off unless the owner opts in.
 */
export function featuredImagePolicyFromConfiguration(
  options: {
    env?: NodeJS.ProcessEnv;
    read?: (path: string) => Promise<string>;
  } = {},
): () => Promise<FeaturedImagePolicy> {
  return async () => {
    const env = options.env ?? process.env;
    const handler = new ConfigurationController({
      env,
      settingsFile: env.STEELE_CONFIG_PATH,
      salt: "public-featured-image-policy-v1",
      registry: SETTINGS.filter((s) => s.key === FEATURED_IMAGE),
      roles: { publisher: [FEATURED_IMAGE] },
      ...(options.read ? { read: options.read } : {}),
    });
    const observed = await handler.currentSettings("publisher", [
      FEATURED_IMAGE,
    ]);
    return observed.settings[0]!.value as FeaturedImagePolicy;
  };
}
