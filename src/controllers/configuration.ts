import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  configurationVersion,
  inspectSettings,
  resolveSettings,
  SETTINGS,
  type InspectedSetting,
  type ResolvedSetting,
  type SettingSpec,
} from "../config/settings.js";

/**
 * Configuration controller (#543): the single owner of reading, validating
 * and versioning the private settings file against the typed registry
 * (src/config/settings.ts). Read-only for now; future writes stay here.
 *
 * Three facts are kept apart:
 * - **saved state**: what the file currently says, inspected safely;
 * - **active snapshot**: what this process loaded, which changes only on an
 *   explicit `load()`, so an external edit never takes effect silently;
 * - **acknowledgements**: which version each component reports it is using.
 *
 * Components get a role-scoped runtime view: a role sees only the settings it
 * is granted, so a model worker cannot read publishing credentials. Errors are
 * fixed categories; file paths, values and parser messages are never exposed.
 */

export type FileState = "ok" | "missing" | "invalid" | "unavailable";

export interface SavedState {
  file: FileState;
  version: string;
  settings: InspectedSetting[];
}

export interface Snapshot {
  version: string;
  loadedAt: string;
  resolved: ResolvedSetting[];
  file: FileState;
}

/** A component's typed view of only the settings its role is granted. */
export interface RuntimeConfiguration {
  version: string;
  get<T = unknown>(key: string): T | undefined;
}

/** File contents: a flat object of setting key to raw text value. */
const FileSchema = z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/), z.string().max(10_000));

export class ConfigurationError extends Error {
  constructor(
    readonly category:
      | "not-loaded"
      | "not-granted"
      | "unknown-role"
      | "file-invalid"
      | "file-unavailable"
      | "file-missing"
      | "invalid-setting",
  ) {
    super(`configuration: ${category}`);
    this.name = "ConfigurationError";
  }
}

export class ConfigurationController {
  private active?: Snapshot;
  private readonly acks = new Map<string, { version: string; at: string }>();

  constructor(
    private readonly config: {
      /** Private settings file; absent means environment and defaults only. */
      settingsFile?: string;
      env: Record<string, string | undefined>;
      /** Private salt for version digests of private values. */
      salt: string;
      /** Role name to the setting keys it may read at runtime. */
      roles: Record<string, readonly string[]>;
      registry?: readonly SettingSpec[];
      now?: () => Date;
      read?: (path: string) => Promise<string>;
    },
  ) {}

  private get registry() {
    return this.config.registry ?? SETTINGS;
  }

  /** Read and validate the file now. Never throws; problems become a category. */
  private async readFileState(): Promise<{ file: FileState; values: Record<string, string> }> {
    if (!this.config.settingsFile) return { file: "missing", values: {} };
    let raw: string;
    try {
      raw = await (this.config.read ?? ((p) => readFile(p, "utf8")))(this.config.settingsFile);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { file: code === "ENOENT" ? "missing" : "unavailable", values: {} };
    }
    try {
      if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error();
      const parsed = FileSchema.parse(JSON.parse(raw));
      // Only registered keys are ever considered; anything else is ignored.
      const known = new Set(this.registry.map((s) => s.key));
      return {
        file: "ok",
        values: Object.fromEntries(Object.entries(parsed).filter(([k]) => known.has(k))),
      };
    } catch {
      return { file: "invalid", values: {} };
    }
  }

  private async resolve(): Promise<{ file: FileState; resolved: ResolvedSetting[] }> {
    const { file, values } = await this.readFileState();
    return { file, resolved: resolveSettings(this.config.env, values, this.registry) };
  }

  /** What the saved file currently says, safe to show in the browser or logs. */
  async savedState(): Promise<SavedState> {
    const { file, resolved } = await this.resolve();
    return {
      file,
      version: configurationVersion(resolved, this.config.salt, this.registry),
      settings: inspectSettings(resolved, this.registry),
    };
  }

  /** One coherent selected observation for a new decision; never reads or populates active. */
  async currentSettings(
    role: string,
    keys: readonly string[],
  ): Promise<{ settings: ResolvedSetting[]; revision: string }> {
    const granted = this.config.roles[role];
    if (!granted) throw new ConfigurationError("unknown-role");
    if (!keys.length || new Set(keys).size !== keys.length)
      throw new ConfigurationError("invalid-setting");
    if (keys.some((key) => !granted.includes(key))) throw new ConfigurationError("not-granted");
    const specs = keys.map((key) => this.registry.find((spec) => spec.key === key));
    if (specs.some((spec) => !spec)) throw new ConfigurationError("invalid-setting");
    const { file, resolved } = await this.resolve();
    if (this.config.settingsFile && file !== "ok") throw new ConfigurationError(`file-${file}`);
    const settings = keys.map((key) => resolved.find((setting) => setting.key === key));
    if (settings.some((setting) => !setting || setting.error || setting.value === undefined))
      throw new ConfigurationError("invalid-setting");
    const selected = settings as ResolvedSetting[];
    return {
      settings: selected,
      revision: configurationVersion(selected, this.config.salt, specs as SettingSpec[]),
    };
  }

  /** Fresh selected read for a new decision; never populates or reads active. */
  async currentSetting(role: string, key: string): Promise<ResolvedSetting & { revision: string }> {
    const observed = await this.currentSettings(role, [key]);
    return { ...observed.settings[0]!, revision: observed.revision };
  }

  /** Explicitly (re)load the active snapshot from the current saved state. */
  /**
   * Explicitly (re)load the active snapshot. A candidate that is not fully
   * valid is rejected and the previous snapshot stays active: a failed load is
   * never an activation. A configured file that is missing, unreadable or
   * malformed, or any invalid or missing-required setting, rejects the load.
   * With no settings file configured, environment and defaults alone are a
   * supported startup.
   */
  async load(): Promise<
    | { status: "loaded"; version: string; file: FileState }
    | {
        status: "rejected";
        reason: "file-missing" | "file-unavailable" | "file-invalid" | "invalid-settings";
        /** The version still active, if any. */
        version?: string;
      }
  > {
    const { file, resolved } = await this.resolve();
    const keep = (
      reason: "file-missing" | "file-unavailable" | "file-invalid" | "invalid-settings",
    ) => ({
      status: "rejected" as const,
      reason,
      ...(this.active ? { version: this.active.version } : {}),
    });
    if (this.config.settingsFile) {
      if (file === "missing") return keep("file-missing");
      if (file === "unavailable") return keep("file-unavailable");
      if (file === "invalid") return keep("file-invalid");
    }
    if (resolved.some((r) => r.error)) return keep("invalid-settings");
    this.active = {
      version: configurationVersion(resolved, this.config.salt, this.registry),
      loadedAt: (this.config.now ?? (() => new Date()))().toISOString(),
      resolved,
      file,
    };
    return { status: "loaded", version: this.active.version, file };
  }

  /** The version this process loaded, if any; not the saved version. */
  activeVersion(): string | undefined {
    return this.active?.version;
  }

  /** A role-scoped runtime view of the active snapshot. */
  runtime(role: string): RuntimeConfiguration {
    const granted = this.config.roles[role];
    if (!granted) throw new ConfigurationError("unknown-role");
    const snapshot = this.active;
    if (!snapshot) throw new ConfigurationError("not-loaded");
    const allowed = new Set(granted);
    const values = new Map(snapshot.resolved.map((r) => [r.key, r.value]));
    return {
      version: snapshot.version,
      get<T>(key: string): T | undefined {
        if (!allowed.has(key)) throw new ConfigurationError("not-granted");
        // A copy, so no reader can change the loaded snapshot for others.
        const v = values.get(key);
        return (v !== null && typeof v === "object" ? structuredClone(v) : v) as T | undefined;
      },
    };
  }

  /** A component reports the version it is running with. */
  acknowledge(component: string, version: string): void {
    this.acks.set(component, {
      version,
      at: (this.config.now ?? (() => new Date()))().toISOString(),
    });
  }

  /** Per-component acknowledgements, for comparison with the saved version. */
  acknowledgements(): { component: string; version: string; at: string }[] {
    return [...this.acks].map(([component, a]) => ({ component, ...a }));
  }
}
