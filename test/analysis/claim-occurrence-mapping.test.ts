import { describe, expect, it } from "vite-plus/test";
import {
  CLAIM_OCCURRENCE_INDEX_MAPPING,
  CLAIM_OCCURRENCE_MAPPING_ADDITIONS,
} from "../../src/analysis/claim-occurrence.js";

/** Every leaf field path in a mapping's properties. */
function leaves(properties: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(properties).flatMap(([name, spec]) => {
    const nested = (spec as { properties?: Record<string, unknown> }).properties;
    return nested ? leaves(nested, `${prefix}${name}.`) : [`${prefix}${name}`];
  });
}

describe("claim occurrence index upgrades (#461)", () => {
  it("adds every field a deployed strict index may lack, matching the full mapping", () => {
    const full = new Set(leaves(CLAIM_OCCURRENCE_INDEX_MAPPING.properties));
    const added = leaves(CLAIM_OCCURRENCE_MAPPING_ADDITIONS as Record<string, unknown>);
    for (const path of added) expect(full.has(path)).toBe(true);
    // Fields introduced after the index was first provisioned must be upgradable.
    for (const path of [
      "assertionKind",
      "publisher.attributedAuthor",
      "publisher.attributionBasis",
      "publisher.sourceMetadataVersion",
    ])
      expect(added).toContain(path);
  });
});
