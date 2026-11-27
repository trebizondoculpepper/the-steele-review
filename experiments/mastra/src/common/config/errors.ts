/**
 * Configuration errors (#945).
 *
 * Every message names the file (relative to the configuration root) and the
 * location of the problem, never the offending value: configuration files sit
 * beside credentials, and a parser's own message can quote file content.
 */

export type ConfigErrorCode =
  /** The configuration root is not set or is not a directory. */
  | "no-root"
  /** A requested path is absolute or escapes the configuration root. */
  | "outside-root"
  /** A required file does not exist. */
  | "missing"
  /** The file exists but could not be read (permissions, a directory, I/O). */
  | "unreadable"
  /** The file is not syntactically valid (for example, not JSON). */
  | "malformed"
  /** The file parsed but does not satisfy its schema. */
  | "invalid";

/** One schema problem: where it is and what is wrong, with no value. */
export interface ConfigIssue {
  /** Location inside the document, e.g. `sources[1].feedUrl`; empty for the document itself. */
  path: string;
  message: string;
}

export class ConfigError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    /** File relative to the configuration root; empty when the root itself is the problem. */
    readonly file: string,
    readonly issues: readonly ConfigIssue[] = [],
    detail?: string,
  ) {
    super(describe(code, file, issues, detail));
    this.name = "ConfigError";
  }
}

function describe(code: ConfigErrorCode, file: string, issues: readonly ConfigIssue[], detail?: string): string {
  const where = file ? `configuration file ${file}` : "configuration root";
  const head: Record<ConfigErrorCode, string> = {
    "no-root": `${where} is not available`,
    "outside-root": `${where} is outside the configuration root`,
    missing: `${where} is missing`,
    unreadable: `${where} could not be read`,
    malformed: `${where} is malformed`,
    invalid: `${where} is invalid`,
  };
  const lines = [detail ? `${head[code]}: ${detail}` : head[code]];
  for (const issue of issues) lines.push(`  - ${issue.path || "(document)"}: ${issue.message}`);
  return lines.join("\n");
}

/** Formats a schema issue path such as ["sources", 1, "feedUrl"] as `sources[1].feedUrl`. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}
