import { ConfigurationController, ConfigurationError } from "../controllers/configuration.js";
import { SETTINGS } from "../config/settings.js";
import { OwnerDraftTargetsSchema, type DraftTarget } from "../content/owner-draft-authorization.js";
import { dummyDraftTarget, type DraftDeliveryControl } from "./approved-article.js";
import { substackDraftTarget } from "./substack/destination.js";
const keys = [
  "STEELE_EDITORIAL_EXHAUSTION_ACTION",
  "STEELE_SUBSTACK_ORIGIN",
  "STEELE_SUBSTACK_BYLINE_ID",
  "STEELE_DRAFT_SUBSTACK_DESTINATION",
] as const;
/** Read current target configuration without sessions, credentials, network access or caching. */
export function draftDeliveryConfiguration(
  options: { env?: NodeJS.ProcessEnv; read?: (path: string) => Promise<string> } = {},
) {
  const current = async () => {
    const env = options.env ?? process.env;
    const handler = new ConfigurationController({
      env,
      settingsFile: env.STEELE_CONFIG_PATH,
      salt: "private-draft-target-v1",
      registry: SETTINGS.filter((setting) => (keys as readonly string[]).includes(setting.key)),
      roles: { draft: keys },
      ...(options.read ? { read: options.read } : {}),
    });
    const observed = await handler.currentSettings("draft", keys);
    const value = (key: (typeof keys)[number]) =>
      observed.settings.find((setting) => setting.key === key)!.value as string;
    if (value(keys[0]) !== "create-unpublished-draft") return undefined;
    try {
      const target = substackDraftTarget({
        origin: value(keys[1]),
        name: value(keys[3]),
        ...(value(keys[2]) ? { bylineId: value(keys[2]) } : {}),
      });
      return OwnerDraftTargetsSchema.parse([
        dummyDraftTarget("dummy-a"),
        dummyDraftTarget("dummy-b"),
        target,
      ]);
    } catch {
      throw new ConfigurationError("invalid-setting");
    }
  };
  const control: DraftDeliveryControl = {
    async allow(target: DraftTarget) {
      const targets = await current();
      return !!targets?.some(
        (currentTarget) => JSON.stringify(currentTarget) === JSON.stringify(target),
      );
    },
  };
  return { current, control };
}
