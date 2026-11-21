import { z } from "zod";
import { FIELD_LIMITS } from "../content/publication-fields.js";
import type { SafeDraftIssue } from "./draft-diagnostics.js";

export type MetadataField = keyof typeof FIELD_LIMITS;
const names = new Set<string>(Object.keys(FIELD_LIMITS));
export interface FieldRepair {
  candidate: Record<string, unknown>;
  fields: MetadataField[];
  issues: SafeDraftIssue[];
}
/** Isolate metadata only when every schema failure belongs to those fields. */
export function metadataFieldRepair(
  candidate: unknown,
  issues: SafeDraftIssue[],
): FieldRepair | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !issues.length)
    return;
  if (
    !issues.every(
      (i) => i.path.length === 1 && typeof i.path[0] === "string" && names.has(i.path[0]),
    )
  )
    return;
  return {
    candidate: candidate as Record<string, unknown>,
    fields: [...new Set(issues.map((i) => i.path[0] as MetadataField))],
    issues,
  };
}
export function fieldRepairRequest(repair: FieldRepair) {
  return {
    invalidFields: Object.fromEntries(
      repair.fields.map((name) => [
        name,
        Object.hasOwn(repair.candidate, name) ? repair.candidate[name] : null,
      ]),
    ),
    errors: repair.issues,
    constraints: Object.fromEntries(
      repair.fields.map((name) => [
        name,
        {
          type: "string",
          minLength: 1,
          maxLength: FIELD_LIMITS[name],
          singleLine: true,
          plainText: true,
          noHeading: true,
        },
      ]),
    ),
  };
}
/** A patch may name only requested fields; the rest of the candidate is untouched. */
export function mergeFieldPatch(
  repair: FieldRepair,
  patch: unknown,
): Record<string, unknown> | undefined {
  const shape = Object.fromEntries(repair.fields.map((name) => [name, z.unknown()]));
  const checked = z.object(shape).strict().safeParse(patch);
  if (!checked.success || repair.fields.some((name) => !Object.hasOwn(checked.data, name))) return;
  return { ...repair.candidate, ...checked.data };
}
