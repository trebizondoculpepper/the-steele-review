import { expect, it, vi } from "vite-plus/test";
import { draftDeliveryConfiguration } from "../../src/publishing/draft-delivery-configuration.js";
import { SubstackClient } from "../../src/publishing/substack/client.js";
import { SubstackDraftDestination } from "../../src/publishing/substack/destination.js";
it("uses current stop and target configuration at every delivery boundary without reading credentials", async () => {
  let settings = {
    STEELE_EDITORIAL_EXHAUSTION_ACTION: "create-unpublished-draft",
    STEELE_SUBSTACK_ORIGIN: "https://publication.example",
    STEELE_SUBSTACK_BYLINE_ID: "123",
    STEELE_DRAFT_SUBSTACK_DESTINATION: "substack",
  };
  const read = vi.fn(async () => JSON.stringify(settings));
  const config = draftDeliveryConfiguration({
    env: { STEELE_CONFIG_PATH: "synthetic.json", STEELE_PUBLISHER_DESTINATION: "dummy-a" },
    read,
  });
  const session = vi.fn(() => {
    throw new Error("no credential capability needed");
  });
  const destination = new SubstackDraftDestination(
    new SubstackClient({ origin: settings.STEELE_SUBSTACK_ORIGIN, session }),
    { bylineId: "123" },
  );
  const targets = (await config.current())!;
  expect(targets[2]).toEqual(destination.draftTarget);
  expect(await config.control.allow(targets[0]!)).toBe(true);
  expect(await config.control.allow(targets[2]!)).toBe(true);
  settings = { ...settings, STEELE_EDITORIAL_EXHAUSTION_ACTION: "stop" };
  expect(await config.control.allow(targets[0]!)).toBe(false);
  settings = {
    ...settings,
    STEELE_EDITORIAL_EXHAUSTION_ACTION: "create-unpublished-draft",
    STEELE_SUBSTACK_ORIGIN: "https://another-publication.example",
  };
  expect(await config.control.allow(targets[2]!)).toBe(false);
  expect(await config.control.allow((await config.current())![2]!)).toBe(true);
  expect(session).not.toHaveBeenCalled();
  expect(JSON.stringify(targets)).not.toContain("publication.example");
});
it("refuses unavailable, malformed or missing target configuration rather than allowing an old target", async () => {
  const missing = draftDeliveryConfiguration({
    env: { STEELE_EDITORIAL_EXHAUSTION_ACTION: "create-unpublished-draft" },
  });
  await expect(missing.current()).rejects.toMatchObject({ category: "invalid-setting" });
  const unavailable = draftDeliveryConfiguration({
    env: { STEELE_CONFIG_PATH: "synthetic.json" },
    read: async () => {
      throw new Error("private sentinel");
    },
  });
  await expect(unavailable.current()).rejects.toMatchObject({ category: "file-unavailable" });
});
