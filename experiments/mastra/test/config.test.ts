import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { ConfigDirectory, ConfigError, type ConfigReader } from "../src/common/config/index.js";
import { enabledSubstackFeeds, SubstackFeedsSection } from "../src/feed/substack-sources.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/config/${name}/`, import.meta.url));
const dir = (name: string) => new ConfigDirectory(fixture(name));

async function configError(work: Promise<unknown>): Promise<ConfigError> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the read to fail");
}

test("the poller gets a typed list of enabled Substack feeds from the existing document format", async () => {
  const feeds = await enabledSubstackFeeds(dir("valid"));
  assert.deepEqual(feeds, [
    {
      sourceId: "saveusnow",
      name: "Save Us Now",
      feedUrl: "https://saveusnow.substack.com/feed",
      publicationHost: "saveusnow.substack.com",
      defaultAuthor: { id: "example-author", name: "Example Author" },
    },
    {
      sourceId: "otherpub",
      name: "Other Publication",
      feedUrl: "https://news.example.org/feed",
      publicationHost: "news.example.org",
    },
  ]);
});

test("the earlier bare-array registry is still read", async () => {
  const feeds = await enabledSubstackFeeds(dir("legacy"));
  assert.deepEqual(feeds.map((f) => f.feedUrl), ["https://saveusnow.substack.com/feed"]);
});

test("a disabled source stays configured but is not polled", async () => {
  const feeds = await enabledSubstackFeeds(dir("disabled"));
  assert.deepEqual(feeds.map((f) => f.sourceId), ["otherpub"]);
});

test("invalid settings name each problem by location without quoting the value", async () => {
  const error = await configError(enabledSubstackFeeds(dir("invalid")));
  assert.equal(error.code, "invalid");
  assert.equal(error.file, "sources/sources.json");
  assert.deepEqual(error.issues.map((i) => i.path).sort(), ["sources[0].feedUrl", "sources[1].enabled"]);
  assert.doesNotMatch(error.message, /fixture-not-a-secret/);
  assert.doesNotMatch(JSON.stringify(error.issues), /fixture-not-a-secret/);
});

test("malformed JSON is reported without the parser's message, which can quote the file", async () => {
  const error = await configError(enabledSubstackFeeds(dir("malformed")));
  assert.equal(error.code, "malformed");
  assert.doesNotMatch(error.message, /fixture-not-a-secret/);
});

test("duplicate source IDs are rejected", async () => {
  const error = await configError(enabledSubstackFeeds(dir("duplicate")));
  assert.equal(error.code, "invalid");
  assert.deepEqual(error.issues.map((i) => i.path), ["sources[1].id"]);
});

test("a missing required file is an error; an optional one is undefined", async () => {
  const error = await configError(enabledSubstackFeeds(dir("empty")));
  assert.equal(error.code, "missing");
  assert.match(error.message, /sources\/sources\.json is missing/);
  assert.equal(await dir("empty").readOptional(SubstackFeedsSection), undefined);
});

test("the root comes from STEELE_CONFIG_PATH and must be a readable directory", async () => {
  assert.equal((await configError(Promise.resolve().then(() => ConfigDirectory.fromEnv({})))).code, "no-root");
  const fromEnv = ConfigDirectory.fromEnv({ STEELE_CONFIG_PATH: fixture("valid") });
  await fromEnv.check();
  assert.equal((await enabledSubstackFeeds(fromEnv)).length, 2);
  assert.equal((await configError(new ConfigDirectory(fixture("valid") + "nowhere").check())).code, "no-root");
});

test("paths outside the configuration root are refused", async () => {
  const config = dir("valid");
  for (const file of ["../legacy/sources/sources.json", "/etc/hosts", "sources/../../x.json"]) {
    const error = await configError(config.read({ file, schema: z.unknown() }));
    assert.equal(error.code, "outside-root", file);
  }
});

test("a directory where a file is expected is unreadable, not missing", async () => {
  const error = await configError(dir("valid").read({ file: "sources", schema: z.unknown() }));
  assert.equal(error.code, "unreadable");
});

test("consumers depend on the reader protocol, so a test double can stand in", async () => {
  const double: ConfigReader = {
    read: async <T>(section: { schema: z.ZodType<T> }) =>
      section.schema.parse({ schemaVersion: 1, revision: 1, sources: [{ id: "a", type: "substack", name: "A" }] }),
    readOptional: async () => undefined,
  };
  assert.deepEqual((await enabledSubstackFeeds(double)).map((f) => f.feedUrl), ["https://a.substack.com/feed"]);
});

test("schema diagnostics never echo keys, values or alternatives from the file", async () => {
  const section = {
    file: "settings.json",
    schema: z.strictObject({
      endpoints: z.record(z.string(), z.string()),
      mode: z.enum(["fixture-allowed-a", "fixture-allowed-b"]),
    }),
  };
  const error = await configError(dir("leaky").read(section));
  assert.equal(error.code, "invalid");
  assert.doesNotMatch(error.message, /fixture-not-a-secret|private-endpoint|fixture-allowed/);
  assert.doesNotMatch(JSON.stringify(error.issues), /fixture-not-a-secret|private-endpoint|fixture-allowed/);
  assert.deepEqual(
    error.issues.map((i) => `${i.path}: ${i.message}`).sort(),
    ["(root): unexpected key", "endpoints.[key]: expected string", "mode: not an allowed value"].map((s) => s.replace("(root)", "")).sort(),
  );
});
