// Tests for scripts/ci/publish-image.sh (#959) against a stub `docker` that keeps
// registry state in a directory. Run: node --experimental-strip-types --test scripts/ci/publish-image.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./publish-image.sh", import.meta.url));

// Registry: <state>/registry/<ref-with-slashes-escaped> holds "revision digest".
// Local images: <state>/local/<name> holds "revision digest". Pushes are logged.
const STUB = String.raw`#!/bin/sh
state="$STUB_STATE"; key() { printf '%s' "$1" | tr '/:' '__'; }
case "$1 $2" in
  "buildx imagetools")
    sub="$3"
    if [ "$sub" = inspect ]; then
      f="$state/registry/$(key "$4")"
      [ -f "$f" ] || { echo "ERROR: $4: not found" >&2; exit 1; }
      read rev dig < "$f"
      case "$6" in
        *Labels*) printf '{"org.opencontainers.image.revision":"%s"}\n' "$rev" ;;
        *Digest*) printf '"%s"\n' "$dig" ;;
      esac
      exit 0
    fi
    if [ "$sub" = create ]; then
      # Like Docker: without --prefer-index=false, a single manifest is wrapped
      # in a new index, so the tag gets a different digest.
      keep=no
      if [ "$4" = --prefer-index=false ]; then keep=yes; shift; fi
      echo "create $5 from $6" >> "$state/log"
      read rev dig < "$state/registry/$(key "$6")"
      [ "$keep" = yes ] || dig="sha256:index-of-$dig"
      echo "$rev $dig" > "$state/registry/$(key "$5")"; exit 0
    fi ;;
esac
case "$1" in
  tag) cp "$state/local/$(key "$2")" "$state/local/$(key "$3")" ;;
  push) [ "$2" = --quiet ] && shift; echo "push $2" >> "$state/log"; cp "$state/local/$(key "$2")" "$state/registry/$(key "$2")" ;;
  *) echo "unexpected docker $*" >&2; exit 9 ;;
esac
`;

function harness(localDigest = "sha256:new") {
  const base = mkdtempSync(join(tmpdir(), "publish-"));
  const bin = join(base, "bin");
  const state = join(base, "state");
  for (const d of [bin, join(state, "registry"), join(state, "local")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "docker"), STUB, { mode: 0o755 });
  const key = (ref: string) => ref.replace(/[/:]/g, "_");
  writeFileSync(join(state, "local", key("local:img")), `abc ${localDigest}\n`);
  const registry = (ref: string, rev: string, digest: string) => writeFileSync(join(state, "registry", key(ref)), `${rev} ${digest}\n`);
  const run = () =>
    spawnSync("bash", [script, "local:img", "ghcr.io/o/r/mastra", "0.2.0", "abc"], {
      cwd: base,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_STATE: state },
      encoding: "utf8",
    });
  const log = () => (existsSync(join(state, "log")) ? readFileSync(join(state, "log"), "utf8").trim().split("\n") : []);
  return { registry, run, log };
}

test("a fresh publish pushes the commit and version tags", () => {
  const h = harness();
  const r = h.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.log(), ["push ghcr.io/o/r/mastra:sha-abc", "push ghcr.io/o/r/mastra:0.2.0"]);
  assert.equal(r.stdout.trim().split("\n").at(-1), "sha256:new");
});

test("a rerun after a full publish pushes nothing", () => {
  const h = harness("sha256:rebuilt");
  h.registry("ghcr.io/o/r/mastra:0.2.0", "abc", "sha256:first");
  h.registry("ghcr.io/o/r/mastra:sha-abc", "abc", "sha256:first");
  const r = h.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.log(), []);
  assert.equal(r.stdout.trim().split("\n").at(-1), "sha256:first");
});

test("a rerun after only the commit tag was pushed reuses that image and never pushes a rebuild (review on #964)", () => {
  const h = harness("sha256:rebuilt");
  h.registry("ghcr.io/o/r/mastra:sha-abc", "abc", "sha256:first");
  const r = h.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.log(), ["create ghcr.io/o/r/mastra:0.2.0 from ghcr.io/o/r/mastra:sha-abc"]);
  assert.equal(r.stdout.trim().split("\n").at(-1), "sha256:first", "the version tag names the already published image");
});

test("a tag naming another commit stops the job without pushing", () => {
  const h = harness();
  h.registry("ghcr.io/o/r/mastra:0.2.0", "other", "sha256:theirs");
  const r = h.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /already names another commit/);
  assert.deepEqual(h.log(), []);
});
