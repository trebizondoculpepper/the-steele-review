import { expect, it, vi } from "vite-plus/test";
import { publishWithoutEmailFromConfiguration } from "../../src/config/publish-email-policy.js";

it("reads the no-email post list from the settings file on every call (#388)", async () => {
  let file = JSON.stringify({
    STEELE_SUBSTACK_PUBLISH_WITHOUT_EMAIL: "pub/a-post, pub/other",
  });
  const read = vi.fn(async () => file);
  const current = publishWithoutEmailFromConfiguration({
    env: { STEELE_CONFIG_PATH: "synthetic-settings.json" },
    read,
  });
  expect([...(await current())]).toEqual(["pub/a-post", "pub/other"]);
  file = "{}";
  expect([...(await current())]).toEqual([]);
  expect(read).toHaveBeenCalledTimes(2);
});

it("lets the environment win and rejects malformed entries", async () => {
  const fromEnv = publishWithoutEmailFromConfiguration({
    env: { STEELE_SUBSTACK_PUBLISH_WITHOUT_EMAIL: "pub/env-post" },
  });
  expect([...(await fromEnv())]).toEqual(["pub/env-post"]);
  const bad = publishWithoutEmailFromConfiguration({
    env: { STEELE_SUBSTACK_PUBLISH_WITHOUT_EMAIL: "not a post" },
  });
  await expect(bad()).rejects.toThrow();
});
