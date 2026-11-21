import { createHash } from "node:crypto";
import { z } from "zod";
import { MechanicalPolicySchema } from "../drafting/mechanical-policy.js";
import { DEFAULT_OPENROUTER_BASE_URL } from "../controllers/openrouter.js";

/**
 * Application settings registry (#542): one typed description of every
 * supported setting, with a runtime projection for components and a separate
 * inspection projection that is safe for the browser and logs.
 *
 * Precedence (unchanged from today's deployments): a non-empty environment
 * variable wins; otherwise a value from a private configuration file, when a
 * file source is supplied; otherwise the registry default. Private
 * configuration files are mounted into containers and passed in by the
 * caller; this module never reads paths itself, and no real values live in
 * the public repository.
 *
 * Sensitivity decides what inspection may show:
 * - `public`: logical identities and workload knobs, allowlisted here and
 *   shown with their value.
 * - `private`: endpoints, hosts, paths and anything else deployment-specific;
 *   shown only as configured/missing and a validation category.
 * - `secret`: credentials; same as private, and never part of a version hash
 *   by value.
 *
 * The saved version (a hash of the effective configuration) and the version a
 * process actually loaded are different facts; a process records the latter
 * at start-up and both are reported, never assumed equal.
 */

export type Sensitivity = "public" | "private" | "secret";
export type Activation = "live" | "restart";
export type SettingSource = "environment" | "file" | "default" | "missing";

export interface SettingSpec<T = unknown> {
  key: string;
  domain: "research" | "models" | "sources" | "providers" | "dashboard";
  description: string;
  schema: z.ZodType<T>;
  /** Raw text default, parsed through `schema` like any other value. */
  default?: string;
  sensitivity: Sensitivity;
  activation: Activation;
  required?: boolean;
}

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
/** `new URL`, or undefined for a value that is not a URL at all. */
const parseUrl = (v: string) => {
  try {
    return new URL(v);
  } catch {
    return undefined;
  }
};
const modelId = z
  .string()
  .trim()
  .regex(/^[a-z0-9._-]+\/[A-Za-z0-9._:-]+$/, "provider/model");

/**
 * The registry. Defaults mirror the values the current entry points apply,
 * so adopting the registry changes no deployed behaviour.
 */
export const SETTINGS: readonly SettingSpec[] = [
  {
    key: "STEELE_WRITER_TURN_LIMIT",
    domain: "models",
    description: "Total mechanical writer turns, including the initial output.",
    schema: z.coerce.number().pipe(MechanicalPolicySchema.shape.maxTurns.unwrap()),
    default: String(MechanicalPolicySchema.parse({}).maxTurns),
    sensitivity: "public",
    activation: "restart",
  },
  {
    key: "STEELE_WRITER_DEADLINE_MS",
    domain: "models",
    description: "One shared durable deadline for mechanical writer repair, in milliseconds.",
    schema: z.coerce.number().pipe(MechanicalPolicySchema.shape.deadlineMs.unwrap()),
    default: String(MechanicalPolicySchema.parse({}).deadlineMs),
    sensitivity: "public",
    activation: "restart",
  },
  {
    key: "STEELE_DASHBOARD_RESEARCH_REQUEST_LIMIT",
    domain: "research",
    description: "Research requests a console-started article run may commission.",
    schema: int(0, 100),
    default: "5",
    sensitivity: "public",
    activation: "restart",
  },
  {
    key: "STEELE_DASHBOARD_RESEARCH_DEADLINE_MS",
    domain: "research",
    description: "Deadline for a console-started run's research batch, in milliseconds.",
    schema: int(1_000, 86_400_000),
    default: "1800000",
    sensitivity: "public",
    activation: "restart",
  },
  {
    key: "STEELE_RESEARCH_REQUEST_LIMIT",
    domain: "research",
    description: "Research requests a bridge-started article run may commission.",
    schema: int(0, 100),
    sensitivity: "public",
    activation: "restart",
  },
  {
    key: "STEELE_RESEARCH_DEADLINE_MS",
    domain: "research",
    description: "Deadline for a bridge-started run's research batch, in milliseconds.",
    schema: int(1_000, 86_400_000),
    default: "1800000",
    sensitivity: "public",
    activation: "restart",
  },
  {
    key: "STEELE_RESEARCH_MODEL",
    domain: "models",
    description: "Model identity used for commissioned research.",
    schema: modelId,
    default: "perplexity/sonar-deep-research",
    sensitivity: "public",
    activation: "restart",
  },
  {
    key: "STEELE_MODEL_WRITER",
    domain: "models",
    description: "Model identity used to write article drafts.",
    schema: modelId,
    default: "anthropic/claude-opus-5.5",
    sensitivity: "public",
    activation: "restart",
  },
  {
    key: "STEELE_ARTICLE_SOURCES",
    domain: "sources",
    description: "Logical source namespaces allowed to start article runs (comma-separated).",
    schema: z
      .string()
      .transform((s) =>
        s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(/^[a-z0-9][a-z0-9/_-]{0,199}$/))),
    default: "",
    sensitivity: "public",
    activation: "restart",
  },
  {
    key: "OPENROUTER_BASE_URL",
    domain: "providers",
    description: "Model provider endpoint.",
    // Same constraints as the OpenRouter adapters: HTTPS, no user information.
    schema: z.url().refine((v) => {
      const u = parseUrl(v);
      return !!u && u.protocol === "https:" && !u.username && !u.password;
    }),
    // The adapters fall back to this public endpoint when none is configured.
    default: DEFAULT_OPENROUTER_BASE_URL,
    sensitivity: "private",
    activation: "restart",
  },
  {
    key: "OPENROUTER_API_KEY",
    domain: "providers",
    description: "Model provider credential.",
    schema: z.string().min(1),
    sensitivity: "secret",
    activation: "restart",
  },
  {
    key: "STEELE_DASHBOARD_ORIGIN",
    domain: "dashboard",
    description: "Canonical origin the console's actions accept.",
    // Same as the dashboard entry point: an exact HTTP(S) origin, nothing more.
    schema: z.url().refine((v) => {
      const u = parseUrl(v);
      return !!u && (u.protocol === "http:" || u.protocol === "https:") && v === u.origin;
    }),
    sensitivity: "private",
    activation: "restart",
  },
];

export interface ResolvedSetting {
  key: string;
  source: SettingSource;
  /** Undefined when missing or invalid. */
  value?: unknown;
  /** Fixed category, never the offending value. */
  error?: "invalid" | "missing-required";
}

/** Resolve every setting by precedence: environment, then file, then default. */
export function resolveSettings(
  env: Record<string, string | undefined>,
  file: Record<string, string> = {},
  registry: readonly SettingSpec[] = SETTINGS,
): ResolvedSetting[] {
  return registry.map((spec) => {
    const fromEnv = env[spec.key];
    const [raw, source]: [string | undefined, SettingSource] =
      fromEnv !== undefined && fromEnv !== ""
        ? [fromEnv, "environment"]
        : file[spec.key] !== undefined
          ? [file[spec.key], "file"]
          : spec.default !== undefined
            ? [spec.default, "default"]
            : [undefined, "missing"];
    if (raw === undefined) {
      return {
        key: spec.key,
        source,
        ...(spec.required ? { error: "missing-required" as const } : {}),
      };
    }
    const parsed = spec.schema.safeParse(raw);
    return parsed.success
      ? { key: spec.key, source, value: parsed.data }
      : { key: spec.key, source, error: "invalid" as const };
  });
}

export interface InspectedSetting {
  key: string;
  domain: SettingSpec["domain"];
  description: string;
  sensitivity: Sensitivity;
  activation: Activation;
  source: SettingSource;
  state: "configured" | "default" | "missing" | "invalid";
  /** Only for `public` settings. */
  value?: unknown;
}

/** The browser/log-safe projection: values only for allowlisted public settings. */
export function inspectSettings(
  resolved: ResolvedSetting[],
  registry: readonly SettingSpec[] = SETTINGS,
): InspectedSetting[] {
  const byKey = new Map(resolved.map((r) => [r.key, r]));
  return registry.map((spec) => {
    const r = byKey.get(spec.key) ?? { key: spec.key, source: "missing" as const };
    const state = r.error
      ? r.error === "invalid"
        ? "invalid"
        : "missing"
      : r.source === "missing"
        ? "missing"
        : r.source === "default"
          ? "default"
          : "configured";
    return {
      key: spec.key,
      domain: spec.domain,
      description: spec.description,
      sensitivity: spec.sensitivity,
      activation: spec.activation,
      source: r.source,
      state,
      ...(spec.sensitivity === "public" && r.value !== undefined ? { value: r.value } : {}),
    };
  });
}

/**
 * Deterministic identity of an effective configuration. Public values are
 * hashed directly; private and secret values only through a keyed digest of
 * their presence and content, so the version changes when they change but
 * cannot be inverted from the published identity alone. The salt is a private
 * deployment value supplied by the caller.
 */
export function configurationVersion(
  resolved: ResolvedSetting[],
  salt: string,
  registry = SETTINGS,
): string {
  const bySpec = new Map(registry.map((s) => [s.key, s]));
  const canonical = [...resolved]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((r) => {
      const spec = bySpec.get(r.key);
      const value =
        spec?.sensitivity === "public"
          ? r.value
          : r.value === undefined
            ? null
            : createHash("sha256")
                .update(`${salt}\0${r.key}\0${JSON.stringify(r.value)}`)
                .digest("hex");
      return [r.key, r.source, r.error ?? null, value];
    });
  return `config-sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32)}`;
}

/** A candidate save of desired configuration, never an activation (#545). */
export interface SettingsSaveInput {
  /** The saved file the operator was shown, keyed by setting key. */
  current: Record<string, string>;
  /** The effective version the operator saw; a stale value is refused. */
  expectedVersion: string;
  /** Raw values to set; an empty string removes the key from the saved file. */
  changes: Record<string, string>;
  env: NodeJS.ProcessEnv;
  /** Private deployment salt used by `configurationVersion`. */
  salt: string;
  now?: () => Date;
}

export interface SettingsAuditEntry {
  key: string;
  action: "set" | "remove";
  at: string;
}

export type SettingsSaveDecision =
  | {
      status: "accepted";
      /** Canonical file content to write atomically; nothing is activated. */
      content: string;
      /** Version the saved file will have. */
      version: string;
      audit: SettingsAuditEntry[];
      /** Components whose activation still needs a reload or restart. */
      activation: Activation[];
    }
  | {
      status: "rejected";
      reason: "unknown-key" | "not-editable" | "invalid-value" | "invalid-configuration" | "stale-version";
      keys: string[];
    };

/**
 * Decide whether a save may happen. Pure: it validates the whole candidate
 * configuration, refuses unknown keys, non-editable (non-public) settings and
 * stale submissions, and returns the exact content to write. Saving records
 * desired state only; activation is reported, never performed.
 */
export function planSettingsSave(
  input: SettingsSaveInput,
  registry: readonly SettingSpec[] = SETTINGS,
): SettingsSaveDecision {
  const byKey = new Map(registry.map((s) => [s.key, s]));
  const keys = Object.keys(input.changes);
  const unknown = keys.filter((k) => !byKey.has(k));
  if (unknown.length > 0) return { status: "rejected", reason: "unknown-key", keys: unknown };
  const notEditable = keys.filter((k) => byKey.get(k)!.sensitivity !== "public");
  if (notEditable.length > 0)
    return { status: "rejected", reason: "not-editable", keys: notEditable };

  const candidate: Record<string, string> = { ...input.current };
  for (const key of keys) {
    const raw = input.changes[key]!;
    if (raw === "") delete candidate[key];
    else candidate[key] = raw;
  }

  // Whole-configuration validation: a save may not smuggle in a broken value
  // anywhere, including keys it did not touch.
  const resolved = resolveSettings(input.env, candidate, registry);
  const invalid = resolved.filter((r) => r.error !== undefined).map((r) => r.key);
  if (invalid.length > 0)
    return { status: "rejected", reason: "invalid-configuration", keys: invalid };

  const currentVersion = configurationVersion(
    resolveSettings(input.env, input.current, registry),
    input.salt,
    registry,
  );
  const version = configurationVersion(resolved, input.salt, registry);
  // A stale submission means another save already landed.
  if (currentVersion !== input.expectedVersion)
    return { status: "rejected", reason: "stale-version", keys: [] };

  const at = (input.now ?? (() => new Date()))().toISOString();
  const canonical = Object.fromEntries(
    Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    status: "accepted",
    content: `${JSON.stringify(canonical, null, 2)}\n`,
    version,
    audit: keys.map((key) => ({
      key,
      action: input.changes[key] === "" ? "remove" : "set",
      at,
    })),
    activation: [...new Set(keys.map((k) => byKey.get(k)!.activation))],
  };
}
