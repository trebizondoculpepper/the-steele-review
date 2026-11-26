import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bundleBytes, bundleHash, canonicalize, sourceVersionId, type SourceBundle } from "../src/capture/bundle.js";

const fixtures = fileURLToPath(new URL("../../shared/fixtures/", import.meta.url));

test("reproduces the shared fixture's canonical bytes and expected hash (#911 contract)", () => {
  const bytes = readFileSync(`${fixtures}source-bundle-v1.example.json`, "utf8");
  const expected = readFileSync(`${fixtures}source-bundle-v1.example.sha256`, "utf8").trim();
  const bundle = JSON.parse(bytes) as SourceBundle;
  assert.equal(bundleBytes(bundle), bytes, "re-canonicalising the parsed fixture yields identical bytes");
  assert.equal(bundleHash(bundle), expected);
  assert.equal(sourceVersionId(bundle), `substack:example:1000001@sha256:${expected}`);
});

test("canonical form is independent of key order", () => {
  assert.equal(canonicalize({ b: "1", a: null, c: { y: "2", x: "3" } }), '{"a":null,"b":"1","c":{"x":"3","y":"2"}}');
});
