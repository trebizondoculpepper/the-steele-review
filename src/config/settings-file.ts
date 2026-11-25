import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";

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
export async function readSettingsFile(
  path: string,
): Promise<Record<string, string>> {
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
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
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

/** Serialises saves per path so two saves cannot interleave read/rename. */
const saving = new Map<string, Promise<unknown>>();

function serialize<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = saving.get(path) ?? Promise.resolve();
  const next = previous.then(work, work);
  // Keep the chain alive without leaking rejections into later callers.
  saving.set(
    path,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Plan and, when accepted, save the candidate atomically.
 *
 * The current file is always read from disk: a caller-supplied snapshot could
 * hide a change made since the operator was shown the version, so the stale
 * check must compare against what is stored. Saves for one path are serialised.
 */
export async function saveSettings(
  path: string,
  input: Omit<SettingsSaveInput, "current">,
): Promise<SaveSettingsResult> {
  return serialize(path, () => saveNow(path, input));
}

async function saveNow(
  path: string,
  input: Omit<SettingsSaveInput, "current">,
): Promise<SaveSettingsResult> {
  const current = await readSettingsFile(path);
  const decision = planSettingsSave({ ...input, current });
  if (decision.status !== "accepted")
    return { decision, version: savedFileVersion(current, input.salt) };

  // Retain the revision being replaced before it is overwritten, so a save can
  // be inspected and rolled back without relying on the filesystem's history.
  const previousVersion = savedFileVersion(current, input.salt);
  try {
    await mkdir(`${path}.revisions`, { recursive: true, mode: 0o700 });
    await writeFile(
      `${path}.revisions/${previousVersion}.json`,
      JSON.stringify(current, null, 2) + "\n",
      {
        mode: 0o600,
        flag: "wx",
      },
    );
  } catch (error) {
    // An existing revision file is fine (same content); anything else means the
    // previous state could not be retained, so refuse the save.
    if ((error as { code?: string }).code !== "EEXIST")
      throw new SettingsFileError("write-failed");
  }

  // Unique per call: a shared PID-based name lets two saves collide.
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
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
    await writeFile(`${path}.audit.log`, `${auditLine}\n`, {
      flag: "a",
      mode: 0o600,
    });
  } catch {
    // The save already landed; a missing audit line is reported, not undone.
    throw new SettingsFileError("write-failed");
  }
  return { decision, version: decision.version };
}

/** Saved revisions of a configuration file, newest version name first. */
export async function listSettingsRevisions(path: string): Promise<string[]> {
  try {
    const names = await readdir(`${path}.revisions`);
    return names
      .filter((n) => n.endsWith(".json"))
      .sort()
      .reverse();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw new SettingsFileError("unreadable");
  }
}

export type RestoreResult =
  | { status: "restored"; version: string; previousVersion: string }
  | {
      status: "rejected";
      reason: "stale-version" | "unknown-revision";
      version: string;
    };

/**
 * Restore a retained revision.
 *
 * The operator must present the version currently on disk: restoring over a
 * configuration they never saw would silently discard someone else's change.
 */
export async function restoreSettingsRevision(
  path: string,
  input: {
    version: string;
    expectedVersion: string;
    salt: string;
    now?: () => Date;
  },
): Promise<RestoreResult> {
  return serialize(path, async () => {
    const current = await readSettingsFile(path);
    const currentVersion = savedFileVersion(current, input.salt);
    if (currentVersion !== input.expectedVersion)
      return {
        status: "rejected",
        reason: "stale-version",
        version: currentVersion,
      };

    let content: Record<string, string>;
    try {
      const raw = await readFile(
        `${path}.revisions/${input.version}.json`,
        "utf8",
      );
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        throw new Error("invalid");
      content = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== "string") throw new Error("invalid");
        content[k] = v;
      }
    } catch {
      return {
        status: "rejected",
        reason: "unknown-revision",
        version: currentVersion,
      };
    }

    // Keep the state being replaced, then swap atomically.
    try {
      await writeFile(
        `${path}.revisions/${currentVersion}.json`,
        JSON.stringify(current, null, 2) + "\n",
        { mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST")
        throw new SettingsFileError("write-failed");
    }
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify(content, null, 2) + "\n", {
        mode: 0o600,
      });
      await rename(temporary, path);
    } catch {
      throw new SettingsFileError("write-failed");
    }
    const at = (input.now ?? (() => new Date()))().toISOString();
    await writeFile(`${path}.audit.log`, `${at}\trestore\t${input.version}\n`, {
      flag: "a",
      mode: 0o600,
    });
    return {
      status: "restored",
      version: savedFileVersion(content, input.salt),
      previousVersion: currentVersion,
    };
  });
}
