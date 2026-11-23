import { describe, expect, it } from "vite-plus/test";
import {
  acknowledgeComponent,
  activated,
  assessActivation,
  failComponent,
  planActivation,
} from "../../src/config/activation.js";

const v1 = "config-file-sha256:" + "1".repeat(32);
const v0 = "config-file-sha256:" + "0".repeat(32);
const now = () => new Date("2026-02-01T00:00:00.000Z");

const settings = [
  { key: "STEELE_WRITER_MODEL", component: "article-worker", activation: "restart" as const },
  { key: "STEELE_DASHBOARD_PORT", component: "dashboard", activation: "restart" as const },
  { key: "STEELE_RESEARCH_TIMEOUT", component: "article-worker", activation: "live" as const },
];

describe("configuration activation (#546)", () => {
  it("plans components and keeps a restart when any setting needs one", () => {
    const record = planActivation({ configVersion: v1, settings, observed: {}, now });
    expect(record.components.map((c) => [c.component, c.mode])).toEqual([
      ["article-worker", "restart"],
      ["dashboard", "restart"],
    ]);
    // Both settings for one component are listed together.
    expect(record.components[0]!.settings).toHaveLength(2);
  });

  it("never treats an unobserved or differently-versioned component as active", () => {
    const record = planActivation({
      configVersion: v1,
      settings,
      observed: { dashboard: v1, "article-worker": v0 },
      now,
    });
    const assessed = assessActivation(record);
    expect(assessed).toEqual([
      { component: "article-worker", mode: "restart", state: "pending", observedVersion: v0 },
      { component: "dashboard", mode: "restart", state: "active", observedVersion: v1 },
    ]);
    expect(activated(record)).toBe(false);
  });

  it("acknowledges only the component that reports the requested version", () => {
    const record = planActivation({ configVersion: v1, settings, observed: {}, now });
    const after = acknowledgeComponent(record, { component: "dashboard", observedVersion: v1 });
    expect(activated(after)).toBe(false);
    const both = acknowledgeComponent(after, { component: "article-worker", observedVersion: v1 });
    expect(activated(both)).toBe(true);
  });

  it("keeps a failed activation visible even if the component later reports the right version", () => {
    const record = planActivation({ configVersion: v1, settings, observed: {}, now });
    const failed = failComponent(record, { component: "dashboard", reason: "restart refused" });
    expect(assessActivation(failed).find((a) => a.component === "dashboard")).toMatchObject({
      state: "failed",
      failure: "restart refused",
    });
    // Dropping the reason: a reported version clears the failure only through an
    // explicit acknowledgement.
    const acknowledged = acknowledgeComponent(failed, { component: "dashboard", observedVersion: v1 });
    expect(assessActivation(acknowledged).find((a) => a.component === "dashboard")).toMatchObject({
      state: "active",
    });
  });

  it("ignores an acknowledgement for a component that is not part of the activation", () => {
    const record = planActivation({ configVersion: v1, settings, observed: {}, now });
    expect(acknowledgeComponent(record, { component: "unknown", observedVersion: v1 })).toEqual(record);
  });
});
