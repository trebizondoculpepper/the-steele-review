import { z } from "zod";

/**
 * Activation of a saved configuration revision (#546).
 *
 * Saving changes desired state; activation is what makes a running component
 * actually use it. This module plans and records activation; it performs no
 * restart and calls no deployment API. A component is only ever acknowledged as
 * running a version after it reports having loaded it, and an activation with no
 * observation stays visibly pending rather than being assumed to have worked.
 */

export const ACTIVATION_SCHEMA_VERSION = 1;

/** How disruptive activating a setting is. */
export const ACTIVATION_MODE = {
  live: "reload",
  restart: "restart",
} as const satisfies Record<string, "reload" | "restart">;

export type ActivationMode = "reload" | "restart";

export const ActivationComponentSchema = z
  .object({
    /** Logical component that must load the revision, e.g. "dashboard". */
    component: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    /** Why this component is involved; the settings it owns. */
    settings: z.array(z.string().min(1).max(200)).max(200),
    mode: z.enum(["reload", "restart"]),
    /** The version the component currently reports it loaded, when observed. */
    observedVersion: z.string().min(1).max(200).optional(),
    /** Why activation failed, kept visible rather than overwritten. */
    failure: z.string().min(1).max(500).optional(),
  })
  .strict();
export type ActivationComponent = z.infer<typeof ActivationComponentSchema>;

export const ActivationRecordSchema = z
  .object({
    schemaVersion: z.literal(ACTIVATION_SCHEMA_VERSION),
    /** The configuration revision being activated. */
    configVersion: z.string().min(1).max(200),
    requestedAt: z.iso.datetime({ offset: true }),
    components: z.array(ActivationComponentSchema).max(50),
  })
  .strict();
export type ActivationRecord = z.infer<typeof ActivationRecordSchema>;

export type ComponentState = "pending" | "active" | "failed";

export interface ComponentAssessment {
  component: string;
  mode: ActivationMode;
  state: ComponentState;
  /** True only when the component reports the requested version. */
  observedVersion?: string;
  /** Present when activation failed; the component is never reported active. */
  failure?: string;
}

/**
 * Compare what each component reports with the requested revision.
 *
 * A component that reports a different version is `pending`, and so is one that
 * reports nothing: an unobserved component is never treated as activated. A
 * component explicitly recorded as failed stays failed even if it later happens
 * to report the right version, so a failure is never silently overwritten.
 */
export function assessActivation(record: ActivationRecord): ComponentAssessment[] {
  return record.components.map((c) => ({
    component: c.component,
    mode: c.mode,
    state:
      c.failure !== undefined
        ? "failed"
        : c.observedVersion !== undefined && c.observedVersion === record.configVersion
          ? "active"
          : "pending",
    ...(c.observedVersion ? { observedVersion: c.observedVersion } : {}),
    ...(c.failure ? { failure: c.failure } : {}),
  }));
}

/** True when every component that must load the revision reports it. */
export function activated(record: ActivationRecord): boolean {
  return assessActivation(record).every((a) => a.state === "active");
}

/** Record a component's own report of the version it loaded. */
export function acknowledgeComponent(
  record: ActivationRecord,
  input: { component: string; observedVersion: string },
): ActivationRecord {
  const index = record.components.findIndex((c) => c.component === input.component);
  if (index === -1) return record;
  const components = [...record.components];
  // A later successful report clears an earlier failure.
  const { failure: _cleared, ...rest } = components[index]!;
  components[index] = { ...rest, observedVersion: input.observedVersion };
  return ActivationRecordSchema.parse({ ...record, components });
}

/** Mark a component's activation as failed, keeping the reason visible. */
export function failComponent(
  record: ActivationRecord,
  input: { component: string; reason: string },
): ActivationRecord {
  const index = record.components.findIndex((c) => c.component === input.component);
  if (index === -1) return record;
  const components = [...record.components];
  // Drop any observation: a failed activation must never read as active.
  const { observedVersion: _dropped, ...rest } = components[index]!;
  components[index] = { ...rest, failure: input.reason.slice(0, 500) };
  return ActivationRecordSchema.parse({ ...record, components });
}

/** Plan which components a revision touches and how disruptive that is. */
export function planActivation(input: {
  configVersion: string;
  settings: Array<{ key: string; component: string; activation: "live" | "restart" }>;
  observed: Record<string, string | undefined>;
  now?: () => Date;
}): ActivationRecord {
  const byComponent = new Map<string, { settings: string[]; mode: ActivationMode }>();
  for (const setting of input.settings) {
    const mode = ACTIVATION_MODE[setting.activation];
    const entry = byComponent.get(setting.component) ?? { settings: [], mode };
    entry.settings.push(setting.key);
    // A component needing a restart needs it even if another setting reloads.
    if (mode === "restart") entry.mode = "restart";
    byComponent.set(setting.component, entry);
  }
  return ActivationRecordSchema.parse({
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    configVersion: input.configVersion,
    requestedAt: (input.now ?? (() => new Date()))().toISOString(),
    components: [...byComponent.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([component, entry]) => ({
        component,
        settings: entry.settings,
        mode: entry.mode,
        ...(input.observed[component] ? { observedVersion: input.observed[component] } : {}),
      })),
  });
}
