import { expect, it, vi } from "vite-plus/test";
import { editorialPolicyFromConfiguration } from "../../src/config/editorial-live-policy.js";
import { ConfigurationController } from "../../src/controllers/configuration.js";

it("reads one coherent live policy per decision and exposes only its non-secret observation", async () => {
  let file = JSON.stringify({
    STEELE_EDITORIAL_MAX_REVISIONS: "1",
    STEELE_EDITORIAL_EXHAUSTION_ACTION: "create-unpublished-draft",
    STEELE_EDITORIAL_DEADLINE_MS: "1800000",
    OPENROUTER_API_KEY: "SECRET-SENTINEL",
  });
  const read = vi.fn(async () => file);
  const observe = editorialPolicyFromConfiguration({
    env: { STEELE_CONFIG_PATH: "synthetic-settings.json" },
    read,
  });
  const first = await observe();
  expect(read).toHaveBeenCalledTimes(1);
  expect(first.policy).toMatchObject({
    maxRevisions: 1,
    onExhausted: "create-unpublished-draft",
    deadlineMs: 1800000,
  });
  file = JSON.stringify({
    STEELE_EDITORIAL_MAX_REVISIONS: "0",
    STEELE_EDITORIAL_EXHAUSTION_ACTION: "stop",
    STEELE_EDITORIAL_DEADLINE_MS: "1200000",
  });
  const next = await observe();
  expect(read).toHaveBeenCalledTimes(2);
  expect(next.policy).toMatchObject({ maxRevisions: 0, onExhausted: "stop", deadlineMs: 1200000 });
  expect(next.revision).not.toBe(first.revision);
  expect(first.policy.maxRevisions).toBe(1);
  expect(JSON.stringify(first)).not.toMatch(/SECRET-SENTINEL|synthetic-settings/);
});

it("fails closed on unavailable or invalid current policy instead of retaining the earlier value", async () => {
  let file = "{}";
  const observe = editorialPolicyFromConfiguration({
    env: { STEELE_CONFIG_PATH: "synthetic-settings.json" },
    read: async () => file,
  });
  await observe();
  file = JSON.stringify({ STEELE_EDITORIAL_MAX_REVISIONS: "6" });
  await expect(observe()).rejects.toMatchObject({ category: "invalid-setting" });
  file = "malformed private sentinel";
  await expect(observe()).rejects.toMatchObject({ category: "file-invalid" });
  const unavailable = editorialPolicyFromConfiguration({
    env: { STEELE_CONFIG_PATH: "synthetic-settings.json" },
    read: async () => {
      throw new Error("private sentinel");
    },
  });
  await expect(unavailable()).rejects.toMatchObject({ category: "file-unavailable" });
});

it("checks all selected grants before touching the configuration file", async () => {
  const read = vi.fn(async () => "{}");
  const handler = new ConfigurationController({
    env: {},
    settingsFile: "synthetic-settings.json",
    salt: "synthetic",
    roles: { editorial: ["STEELE_EDITORIAL_MAX_REVISIONS"] },
    read,
  });
  await expect(
    handler.currentSettings("editorial", ["STEELE_EDITORIAL_MAX_REVISIONS", "OPENROUTER_API_KEY"]),
  ).rejects.toMatchObject({ category: "not-granted" });
  expect(read).not.toHaveBeenCalled();
  await expect(
    handler.currentSettings("editorial", [
      "STEELE_EDITORIAL_MAX_REVISIONS",
      "STEELE_EDITORIAL_MAX_REVISIONS",
    ]),
  ).rejects.toMatchObject({ category: "invalid-setting" });
  expect(read).not.toHaveBeenCalled();
});
