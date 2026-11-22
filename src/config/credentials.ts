import { readFileSync } from "node:fs";
import { parse as parseToml, type TomlTable } from "smol-toml";

/**
 * The application's secrets boundary (#129).
 *
 * Credentials arrive from a canonical TOML file named by `<NAME>_CONFIG_FILE`,
 * or through explicit legacy environment/raw-file inputs. This module
 * reads them without materializing derived files and hands each
 * controller only the credentials it needs. Workers never receive a generic
 * secret-store handle, and nothing here ever puts a credential value or a
 * secret file's path into an error message.
 *
 * Connection URLs are treated as sensitive too: they may carry user info.
 */

export type CredentialProblem = "missing" | "unreadable" | "empty" | "conflict" | "invalid";

/** A setup error that names the variable and the problem, never the value or path. */
export class CredentialError extends Error {
  constructor(
    readonly variable: string,
    readonly problem: CredentialProblem,
  ) {
    super(`${variable}: ${problem}`);
    this.name = "CredentialError";
  }
}

export interface CredentialSource {
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
}

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Read one credential from `<name>`, `<name>_FILE`, or the top-level `<name>`
 * string in the canonical TOML file named by `<name>_CONFIG_FILE`.
 * Combining canonical and legacy sources is a conflict. An empty value or file is an error, not an
 * absent credential.
 */
export function readCredential(
  name: string,
  options: CredentialSource & { required: true },
): string;
export function readCredential(
  name: string,
  options?: CredentialSource & { required?: false },
): string | undefined;
export function readCredential(
  name: string,
  options: CredentialSource & { required?: boolean } = {},
): string | undefined {
  if (!NAME.test(name)) throw new Error("invalid credential name");
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const direct = env[name];
  const file = env[`${name}_FILE`];
  const canonical = env[`${name}_CONFIG_FILE`];
  if (canonical !== undefined) {
    // Even an empty legacy input is a conflicting configuration authority.
    if (direct !== undefined || file !== undefined) throw new CredentialError(name, "conflict");
    if (canonical.trim() === "") throw new CredentialError(name, "empty");
    let raw: string;
    try {
      raw = readFile(canonical);
    } catch {
      throw new CredentialError(name, "unreadable");
    }
    let parsed: TomlTable;
    try {
      if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error();
      parsed = parseToml(raw, { integersAsBigInt: true });
    } catch {
      // Parser diagnostics can include file contents: never retain the cause.
      throw new CredentialError(name, "invalid");
    }
    if (!Object.hasOwn(parsed, name)) throw new CredentialError(name, "missing");
    const selected = parsed[name];
    if (typeof selected !== "string") throw new CredentialError(name, "invalid");
    if (selected.trim() === "") throw new CredentialError(name, "empty");
    return selected;
  }
  if (direct !== undefined && direct !== "" && file !== undefined && file !== "") {
    throw new CredentialError(name, "conflict");
  }
  let value: string | undefined;
  if (file !== undefined && file !== "") {
    try {
      value = readFile(file);
    } catch {
      throw new CredentialError(`${name}_FILE`, "unreadable");
    }
    value = value.replace(/\r?\n$/, "");
    if (value.trim() === "") throw new CredentialError(`${name}_FILE`, "empty");
    return value;
  }
  if (direct !== undefined && direct !== "") return direct;
  if (options.required) throw new CredentialError(name, "missing");
  return undefined;
}

export interface NatsConnection {
  url: string;
  token?: string;
}

export interface ElasticsearchConnection {
  url: string;
  apiKey?: string;
}

/** Broker connection settings: URL plus optional token. */
export function natsConnection(source: CredentialSource = {}): NatsConnection {
  const url = readCredential("NATS_URL", { ...source, required: true });
  const token = readCredential("NATS_TOKEN", source);
  return { url, ...(token ? { token } : {}) };
}

/** Search connection settings: URL plus optional API key. */
export function elasticsearchConnection(source: CredentialSource = {}): ElasticsearchConnection {
  const url = readCredential("ELASTICSEARCH_URL", { ...source, required: true });
  const apiKey = readCredential("ELASTICSEARCH_API_KEY", source);
  return { url, ...(apiKey ? { apiKey } : {}) };
}

/** Values that must never appear in output: credentials and URL user info. */
export function sensitiveValues(
  ...connections: Array<NatsConnection | ElasticsearchConnection>
): string[] {
  const values: string[] = [];
  for (const c of connections) {
    values.push(c.url);
    if ("token" in c && c.token) values.push(c.token);
    if ("apiKey" in c && c.apiKey) values.push(c.apiKey);
    try {
      const u = new URL(c.url);
      if (u.username) values.push(decodeURIComponent(u.username));
      if (u.password) values.push(decodeURIComponent(u.password));
    } catch {
      // Not a URL: the whole value is already listed.
    }
  }
  return values.filter((v) => v.length >= 4);
}

/** Replace every occurrence of a sensitive value, longest first. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of [...new Set(secrets)].sort((a, b) => b.length - a.length)) {
    out = out.split(s).join("[redacted]");
  }
  return out;
}

/** A setup failure message safe to print. */
export function describeSetupError(error: unknown): string {
  return error instanceof CredentialError ? error.message : "configuration error";
}
