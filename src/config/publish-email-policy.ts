import { ConfigurationController } from "../controllers/configuration.js";
import {
  PUBLISH_WITHOUT_EMAIL,
  SETTINGS,
  SUBSCRIBER_EMAIL,
} from "./settings.js";

/** What the live Substack publisher does about subscriber email (#388, #895). */
export interface EmailPolicy {
  /** "off" publishes every post without email. */
  subscriberEmail: "off" | "on";
  /** Posts (`publicationId/postId`) never emailed, whatever the switch says. */
  withoutEmail: ReadonlySet<string>;
}

const KEYS = [SUBSCRIBER_EMAIL, PUBLISH_WITHOUT_EMAIL] as const;

/**
 * The live email policy. Each call reads current validated settings through
 * the configuration handler, so an owner edit applies to the next delivery
 * without a restart; a failed read throws, and the caller holds.
 */
export function emailPolicyFromConfiguration(
  options: {
    env?: NodeJS.ProcessEnv;
    read?: (path: string) => Promise<string>;
  } = {},
): () => Promise<EmailPolicy> {
  return async () => {
    const env = options.env ?? process.env;
    const handler = new ConfigurationController({
      env,
      settingsFile: env.STEELE_CONFIG_PATH,
      salt: "public-publish-email-policy-v2",
      registry: SETTINGS.filter((s) =>
        (KEYS as readonly string[]).includes(s.key),
      ),
      roles: { publisher: KEYS },
      ...(options.read ? { read: options.read } : {}),
    });
    const observed = await handler.currentSettings("publisher", KEYS);
    const value = (key: string) =>
      observed.settings.find((s) => s.key === key)!.value;
    return {
      subscriberEmail: value(SUBSCRIBER_EMAIL) as "off" | "on",
      withoutEmail: new Set(value(PUBLISH_WITHOUT_EMAIL) as string[]),
    };
  };
}
