import type { z } from "zod";

import { formatIssuePath, type ConfigIssue } from "./errors.js";

/**
 * Value-free schema diagnostics (#945).
 *
 * A schema library's own messages and paths can carry configuration content:
 * an unrecognised-key message lists the keys found, an enum message lists the
 * value's alternatives, and a record's keys (which come from the file) appear
 * in issue paths. None of that may reach an error message or a log, so every
 * issue is rebuilt here from fixed descriptions, and a path keeps only array
 * positions and the keys the schema itself declares. Anything else in a path
 * is shown as `[key]`.
 */

const REDACTED_KEY = "[key]";

/** Object keys a schema declares, collected through wrappers, unions, arrays, records and pipes. */
export function declaredKeys(schema: z.ZodType, into = new Set<string>(), seen = new Set<unknown>()): Set<string> {
  if (seen.has(schema)) return into;
  seen.add(schema);
  const def = (schema as unknown as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (!def) return into;
  const walk = (child: unknown) => {
    if (child && typeof child === "object" && "_zod" in child) declaredKeys(child as z.ZodType, into, seen);
  };
  if (def.type === "object" && def.shape && typeof def.shape === "object") {
    for (const [key, child] of Object.entries(def.shape as Record<string, unknown>)) {
      into.add(key);
      walk(child);
    }
  }
  for (const field of ["innerType", "element", "valueType", "in", "out", "catchall", "left", "right"]) walk(def[field]);
  if (Array.isArray(def.options)) def.options.forEach(walk);
  if (Array.isArray(def.items)) def.items.forEach(walk);
  return into;
}

/** A fixed description of an issue: never the value, the keys found, or the allowed alternatives. */
function describe(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      // `expected` is a type name from the schema, e.g. "string".
      return `expected ${issue.expected}`;
    case "too_small":
      return issue.origin === "array" ? "too few entries" : issue.origin === "string" ? "too short" : "too small";
    case "too_big":
      return issue.origin === "array" ? "too many entries" : issue.origin === "string" ? "too long" : "too large";
    case "invalid_format":
      return "invalid format";
    case "not_multiple_of":
      return "not an allowed multiple";
    case "invalid_value":
      return "not an allowed value";
    case "unrecognized_keys":
      return `unexpected ${issue.keys.length === 1 ? "key" : `keys (${issue.keys.length})`}`;
    case "invalid_union":
      return "does not match any allowed form";
    case "invalid_key":
      return "invalid key";
    case "invalid_element":
      return "invalid entry";
    case "custom":
      // Custom messages are written by the schema's owner, who must keep them value-free.
      return issue.message;
    default:
      return "invalid";
  }
}

/** Rebuild schema issues without configuration content. */
export function sanitizeIssues(
  issues: readonly z.core.$ZodIssue[],
  schema: z.ZodType,
  extraKeys: readonly string[] = [],
): ConfigIssue[] {
  const known = declaredKeys(schema);
  for (const key of extraKeys) known.add(key);
  return issues.map((issue) => ({
    path: formatIssuePath(
      issue.path.map((part) => (typeof part === "number" || (typeof part === "string" && known.has(part)) ? part : REDACTED_KEY)),
    ),
    message: describe(issue),
  }));
}
