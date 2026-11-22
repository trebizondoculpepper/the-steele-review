import { z } from "zod";
import { saveSettings, restoreSettingsRevision, SettingsFileError } from "../config/settings-file.js";
import { savedFileVersion } from "../config/settings.js";

/**
 * Console save/restore action for configuration (#545).
 *
 * The form carries the saved version the operator was shown, so a save can
 * never be applied on top of a change they did not see. Only public
 * (non-secret) settings are editable; the action refuses anything else rather
 * than silently dropping it.
 */

export const CONFIG_EDIT_PREFIX = "k.";

const Version = z.string().regex(/^config-file-sha256:[0-9a-f]{32}$/);

export const ConfigActionSchema = z
  .object({
    action: z.enum(["save", "restore"]).default("save"),
    version: Version,
    restoreVersion: Version.optional(),
  })
  .passthrough();
export type ConfigAction = z.infer<typeof ConfigActionSchema>;

export interface ConfigEditDeps {
  path: string;
  /** Private deployment salt the version tokens are keyed on. */
  salt: string;
  now?: () => Date;
}

export interface ConfigActionResult {
  status: number;
  location?: string;
  /** Short, secret-free explanation for a refusal. */
  reason?: string;
}

/** Extract the edited values from a submitted form. */
export function editsFromForm(form: URLSearchParams): Record<string, string> {
  const changes: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith(CONFIG_EDIT_PREFIX)) changes[key.slice(CONFIG_EDIT_PREFIX.length)] = value;
  }
  return changes;
}

export function configEditAction(deps: ConfigEditDeps) {
  return {
    async submit(form: URLSearchParams): Promise<ConfigActionResult> {
      const parsed = ConfigActionSchema.safeParse(Object.fromEntries(form));
      if (!parsed.success) return { status: 400, reason: "invalid-request" };
      const version = parsed.data.version;

      if (parsed.data.action === "restore") {
        if (!parsed.data.restoreVersion) return { status: 400, reason: "missing-revision" };
        try {
          const result = await restoreSettingsRevision(deps.path, {
            version: parsed.data.restoreVersion,
            expectedVersion: version,
            salt: deps.salt,
            ...(deps.now ? { now: deps.now } : {}),
          });
          if (result.status === "restored") return { status: 303, location: "/config" };
          return {
            status: result.reason === "stale-version" ? 409 : 400,
            reason: result.reason,
          };
        } catch (error) {
          if (error instanceof SettingsFileError)
            return { status: 503, reason: "storage-unavailable" };
          throw error;
        }
      }

      const changes = editsFromForm(form);
      if (Object.keys(changes).length === 0) return { status: 400, reason: "no-changes" };
      try {
        const result = await saveSettings(deps.path, {
          expectedVersion: version,
          changes,
          env: process.env,
          salt: deps.salt,
          ...(deps.now ? { now: deps.now } : {}),
        });
        if (result.decision.status === "accepted") return { status: 303, location: "/config" };
        // A non-public or unknown key is a refusal, never a silent drop.
        return {
          status: result.decision.reason === "stale-version" ? 409 : 400,
          reason: result.decision.reason,
        };
      } catch (error) {
        if (error instanceof SettingsFileError) return { status: 503, reason: "storage-unavailable" };
        throw error;
      }
    },
  };
}

/** Current saved-file version for the page the operator is looking at. */
export function savedVersionOf(file: Record<string, string>, salt: string): string {
  return savedFileVersion(file, salt);
}
