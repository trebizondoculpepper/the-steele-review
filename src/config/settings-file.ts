import { readFile, rename, writeFile } from "node:fs/promises";

import {
  planSettingsSave,
  savedFileVersion,
  type SettingsSaveDecision,
  type SettingsSaveInput,
} from "./settings.js";

/**
 * Reading and saving the configuration file (#545).
 *
 * A save is a two-step atomic operation: write a temporary file and rename it
 * over the target, so a crash cannot leave a half-written configuration. The
 * audit entry is appended only after the rename succeeds, so the trail never
 * records a change that did not land.
 */

export class SettingsFileError extends Error {
  constructor(readonly code: "unreadable" | "invalid" | "write-failed") {
    super(`settings file: ${code}`);
    this.name = "SettingsFileError";
  }
}

/** Read the saved file; a missing file is an empty configuration, not a failure. */
export async function readSettingsFile(path: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw new SettingsFileError("unreadable");
  }
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SettingsFileError("invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new SettingsFileError("invalid");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // The reader only accepts string values; anything else is a broken file.
    if (typeof value !== "string") throw new SettingsFileError("invalid");
    out[key] = value;
  }
  return out;
}

export interface SaveSettingsResult {
  decision: SettingsSaveDecision;
  /** Version now on disk: unchanged on rejection. */
  version: string;
}

/**
 * Plan and, when accepted, save the candidate atomically.
 *
 * `expectedVersion` is the saved-file version the operator was shown; a stale
 * submission is refused by the planner and nothing is written.
 */
export async function saveSettings(
  path: string,
  input: Omit<SettingsSaveInput, "current"> & { current?: Record<string, string> },
): Promise<SaveSettingsResult> {
  const current = input.current ?? (await readSettingsFile(path));
  const decision = planSettingsSave({ ...input, current });
  if (decision.status !== "accepted")
    return { decision, version: savedFileVersion(current, input.salt) };

  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, decision.content, { mode: 0o600 });
    await rename(temporary, path);
  } catch {
    throw new SettingsFileError("write-failed");
  }

  // Audit only after the rename: the trail must never claim a change that did
  // not land.
  const auditLine = decision.audit
    .map((a) => `${a.at}\t${a.action}\t${a.key}`)
    .join("\n");
  try {
    await writeFile(`${path}.audit.log`, `${auditLine}\n`, { flag: "a", mode: 0o600 });
  } catch {
    // The save already landed; a missing audit line is reported, not undone.
    throw new SettingsFileError("write-failed");
  }
  return { decision, version: decision.version };
}
