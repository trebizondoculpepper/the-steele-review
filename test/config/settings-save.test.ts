import { describe, expect, it } from "vite-plus/test";
import {
  MAX_SAVED_VALUE_LENGTH,
  planSettingsSave,
  savedFileVersion,
  SETTINGS,
} from "../../src/config/settings.js";

// Synthetic deployment salt; never a real one.
const salt = "synthetic-salt";
const publicKey = SETTINGS.find((s) => s.sensitivity === "public")!.key;
const secretKey = SETTINGS.find((s) => s.sensitivity !== "public")!.key;
const env = {} as NodeJS.ProcessEnv;
const versionOf = (file: Record<string, string>) => savedFileVersion(file, salt);

const base = (file: Record<string, string> = {}) => ({
  current: file,
  expectedVersion: versionOf(file),
  env,
  salt,
  now: () => new Date("2026-02-01T00:00:00.000Z"),
});

describe("planned settings save (#545)", () => {
  it("accepts a valid public setting and returns content, version and audit", () => {
    const decision = planSettingsSave({ ...base(), changes: { [publicKey]: "1" } });
    expect(decision.status).toBe("accepted");
    if (decision.status !== "accepted") throw new Error(decision.reason);
    expect(JSON.parse(decision.content)).toMatchObject({ [publicKey]: "1" });
    expect(decision.version).toMatch(/^config-file-sha256:[0-9a-f]{32}$/);
    expect(decision.audit).toEqual([{ key: publicKey, action: "set", at: "2026-02-01T00:00:00.000Z" }]);
  });

  it("refuses unknown keys and non-editable settings", () => {
    expect(planSettingsSave({ ...base(), changes: { NOT_A_SETTING: "1" } })).toMatchObject({
      status: "rejected",
      reason: "unknown-key",
    });
    expect(planSettingsSave({ ...base(), changes: { [secretKey]: "x" } })).toMatchObject({
      status: "rejected",
      reason: "not-editable",
      keys: [secretKey],
    });
  });

  it("refuses a candidate that leaves the configuration invalid", () => {
    const decision = planSettingsSave({ ...base(), changes: { [publicKey]: "not-valid" } });
    expect(decision.status).toBe("rejected");
    if (decision.status !== "rejected") return;
    expect(["invalid-value", "invalid-configuration"]).toContain(decision.reason);
  });

  it("does not expose a private value through the version token", () => {
    const a = savedFileVersion({ [secretKey]: "alpha" }, salt);
    const b = savedFileVersion({ [secretKey]: "beta" }, salt);
    expect(a).not.toBe(b); // it still changes when the value changes
    expect(a).toMatch(/^config-file-sha256:[0-9a-f]{32}$/);
    // The token cannot be used to confirm a guess without the salt.
    expect(savedFileVersion({ [secretKey]: "alpha" }, "other-salt")).not.toBe(a);
  });

  it("validates a saved value even when the environment overrides it", () => {
    const decision = planSettingsSave({
      ...base(),
      // The override is valid, but the saved value would be garbage.
      env: { [publicKey]: "1" } as NodeJS.ProcessEnv,
      changes: { [publicKey]: "not-valid" },
    });
    expect(decision).toMatchObject({ status: "rejected", reason: "invalid-value" });
  });

  it("refuses a saved value longer than the reader accepts", () => {
    const decision = planSettingsSave({
      ...base(),
      changes: { [publicKey]: "x".repeat(MAX_SAVED_VALUE_LENGTH + 1) },
    });
    expect(decision).not.toMatchObject({ status: "accepted" });
  });

  it("refuses a stale submission", () => {
    const decision = planSettingsSave({
      ...base({ [publicKey]: "1" }),
      expectedVersion: versionOf({ [publicKey]: "2" }),
      changes: { [publicKey]: "3" },
    });
    expect(decision).toMatchObject({ status: "rejected", reason: "stale-version" });
  });

  it("records a removal and reports activation without performing it", () => {
    const decision = planSettingsSave({
      ...base({ [publicKey]: "1" }),
      changes: { [publicKey]: "" },
    });
    expect(decision.status).toBe("accepted");
    if (decision.status !== "accepted") throw new Error(decision.reason);
    expect(JSON.parse(decision.content)).not.toHaveProperty(publicKey);
    expect(decision.audit[0]).toMatchObject({ action: "remove" });
    expect(decision.activation.length).toBeGreaterThan(0);
  });
});
