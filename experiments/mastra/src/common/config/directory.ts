import { readFile, stat } from "node:fs/promises";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import type { z } from "zod";

import { ConfigError, formatIssuePath } from "./errors.js";

/**
 * Shared configuration services (#945).
 *
 * All configuration is read from one directory: the existing owner
 * configuration root, named by STEELE_CONFIG_PATH as in the earlier
 * deployment (`model/`, `telemetry/`, `sources/sources.json`, ...). The root is
 * passed in, so tests and other callers can point it anywhere.
 *
 * This layer owns file handling and generic validation only. Each consumer
 * owns its own schema and declares it as a ConfigSection; the directory reads
 * the file, parses it and returns the typed value, or throws a ConfigError
 * that names the file and the problem but never a value.
 *
 * Files are read on every call, never cached: a configuration change takes
 * effect on the next read without a restart.
 */

/** The environment variable that names the configuration root. */
export const CONFIG_ROOT_ENV = "STEELE_CONFIG_PATH";

/** A parser turns file text into a document, or throws to report it as malformed. */
export type ConfigParser = (text: string) => unknown;

/**
 * JSON, the format of the existing configuration files. The parser's own error
 * is deliberately dropped: it can quote part of the file.
 */
export const jsonParser: ConfigParser = (text) => JSON.parse(text);

/** One configuration file and the schema its owner declares for it. */
export interface ConfigSection<T> {
  /** Path relative to the configuration root, e.g. `sources/sources.json`. */
  file: string;
  schema: z.ZodType<T>;
  /** Defaults to JSON. */
  parser?: ConfigParser;
}

/** What a consumer needs from the configuration layer; tests can supply their own. */
export interface ConfigReader {
  /** Read, parse and validate a required file. */
  read<T>(section: ConfigSection<T>): Promise<T>;
  /** As read, but a missing file yields undefined instead of an error. */
  readOptional<T>(section: ConfigSection<T>): Promise<T | undefined>;
}

export class ConfigDirectory implements ConfigReader {
  /** Absolute, normalised configuration root. */
  readonly root: string;

  constructor(root: string) {
    if (!root.trim()) throw new ConfigError("no-root", "", [], `${CONFIG_ROOT_ENV} is empty`);
    this.root = resolve(root);
  }

  /** The configuration root named by the environment (STEELE_CONFIG_PATH). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ConfigDirectory {
    const root = env[CONFIG_ROOT_ENV];
    if (root === undefined || !root.trim()) throw new ConfigError("no-root", "", [], `${CONFIG_ROOT_ENV} is not set`);
    return new ConfigDirectory(root);
  }

  /** Confirms the root exists and is a directory, so a deployment fails at startup, not on first use. */
  async check(): Promise<void> {
    try {
      if ((await stat(this.root)).isDirectory()) return;
    } catch {
      // Fall through: a missing root and an unreadable one are reported alike.
    }
    throw new ConfigError("no-root", "", [], "the configured root is not a readable directory");
  }

  /** Absolute path of a file under the root; rejects absolute paths and `..` escapes. */
  path(file: string): string {
    const relative = normalize(file);
    if (!file || isAbsolute(file) || relative === ".." || relative.startsWith(`..${sep}`))
      throw new ConfigError("outside-root", file);
    const full = resolve(this.root, relative);
    if (!full.startsWith(this.root.endsWith(sep) ? this.root : this.root + sep)) throw new ConfigError("outside-root", file);
    return full;
  }

  /** The raw text of a file, or undefined when it does not exist. */
  async readText(file: string): Promise<string | undefined> {
    const full = this.path(file);
    try {
      return await readFile(full, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      throw new ConfigError("unreadable", file);
    }
  }

  async read<T>(section: ConfigSection<T>): Promise<T> {
    const value = await this.readOptional(section);
    if (value === undefined) throw new ConfigError("missing", section.file);
    return value;
  }

  async readOptional<T>(section: ConfigSection<T>): Promise<T | undefined> {
    const text = await this.readText(section.file);
    if (text === undefined) return undefined;
    return parseSection(section, text);
  }
}

/** Parse and validate one file's text against its section; exported for callers that hold the text already. */
export function parseSection<T>(section: ConfigSection<T>, text: string): T {
  if (text.trim() === "") throw new ConfigError("malformed", section.file, [], "the file is empty");
  let document: unknown;
  try {
    document = (section.parser ?? jsonParser)(text);
  } catch {
    throw new ConfigError("malformed", section.file);
  }
  const result = section.schema.safeParse(document);
  if (result.success) return result.data;
  throw new ConfigError(
    "invalid",
    section.file,
    result.error.issues.map((issue) => ({ path: formatIssuePath(issue.path), message: issue.message })),
  );
}
