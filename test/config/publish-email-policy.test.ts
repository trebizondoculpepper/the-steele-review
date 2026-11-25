import { expect, it, vi } from "vite-plus/test";
import { emailPolicyFromConfiguration } from "../../src/config/publish-email-policy.js";

it("defaults to no subscriber email and reads the settings file on every call (#895)", async () => {
  let file = "{}";
  const read = vi.fn(async () => file);
  const current = emailPolicyFromConfiguration({
    env: { STEELE_CONFIG_PATH: "synthetic-settings.json" },
    read,
  });
  const first = await current();
  expect(first.subscriberEmail).toBe("off");
  expect([...first.withoutEmail]).toEqual([]);
  file = JSON.stringify({
    STEELE_SUBSTACK_SUBSCRIBER_EMAIL: "on",
    STEELE_SUBSTACK_PUBLISH_WITHOUT_EMAIL: "pub/a-post, pub/other",
  });
  const next = await current();
  expect(next.subscriberEmail).toBe("on");
  expect([...next.withoutEmail]).toEqual(["pub/a-post", "pub/other"]);
  expect(read).toHaveBeenCalledTimes(2);
});

it("lets the environment win and rejects malformed values instead of guessing", async () => {
  const fromEnv = emailPolicyFromConfiguration({
    env: {
      STEELE_SUBSTACK_SUBSCRIBER_EMAIL: "on",
      STEELE_SUBSTACK_PUBLISH_WITHOUT_EMAIL: "pub/env-post",
    },
  });
  expect(await fromEnv()).toMatchObject({ subscriberEmail: "on" });
  for (const env of [
    { STEELE_SUBSTACK_SUBSCRIBER_EMAIL: "maybe" },
    { STEELE_SUBSTACK_PUBLISH_WITHOUT_EMAIL: "not a post" },
  ]) {
    await expect(emailPolicyFromConfiguration({ env })()).rejects.toThrow();
  }
});
