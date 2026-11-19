import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  ArtifactStoreError,
  GitArtifactStore,
  assertArtifactPath,
  sha256,
} from "../../src/controllers/artifact-store.js";

let dir: string;
let store: GitArtifactStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-artifacts-"));
  store = new GitArtifactStore({ repoPath: dir, repository: "test-archive" });
  await store.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const code = (error: unknown) => (error as ArtifactStoreError).code;

describe("assertArtifactPath", () => {
  it("accepts plain relative paths", () => {
    expect(assertArtifactPath("substack/example-pub/a-post/text.json")).toBeTruthy();
  });

  it.each([
    "",
    "/abs/path",
    "../escape",
    "a/../b",
    "a//b",
    ".git/config",
    "a/.hidden",
    "a/$(rm -rf x)",
    "a/b;c",
    "a\\b",
    "a/ b",
  ])("rejects %j", (path) => {
    expect(() => assertArtifactPath(path)).toThrow(ArtifactStoreError);
  });
});

describe("GitArtifactStore", () => {
  it("writes and reads an exact version with hash verification", async () => {
    const ref = await store.write("pub/post/text.txt", "hello\n");
    expect(ref).toMatchObject({
      repository: "test-archive",
      path: "pub/post/text.txt",
      sha256: sha256("hello\n"),
    });
    expect(ref.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await store.read(ref)).toBe("hello\n");
  });

  it("returns the original reference for a repeat write of identical content", async () => {
    const first = await store.write("a/one.txt", "same");
    await store.write("a/two.txt", "other");
    const again = await store.write("a/one.txt", "same");
    expect(again).toEqual(first);
  });

  it("refuses to change an existing artifact", async () => {
    await store.write("a/one.txt", "v1");
    await expect(store.write("a/one.txt", "v2")).rejects.toSatisfy(
      (e) => code(e) === "immutable-conflict",
    );
  });

  it("keeps earlier references readable after later commits", async () => {
    const first = await store.write("a/one.txt", "first");
    for (let i = 0; i < 3; i++) await store.write(`a/n${i}.txt`, `n${i}`);
    expect(await store.read(first)).toBe("first");
  });

  it("checks the caller's expected hash", async () => {
    await expect(store.write("a/x.txt", "content", sha256("different"))).rejects.toSatisfy(
      (e) => code(e) === "hash-mismatch",
    );
    const ref = await store.write("a/x.txt", "content", sha256("content"));
    expect(ref.sha256).toBe(sha256("content"));
  });

  it("detects tampered or unknown references", async () => {
    const ref = await store.write("a/x.txt", "content");
    await expect(store.read({ ...ref, sha256: sha256("other") })).rejects.toSatisfy(
      (e) => code(e) === "hash-mismatch",
    );
    await expect(store.read({ ...ref, path: "a/missing.txt" })).rejects.toSatisfy(
      (e) => code(e) === "not-found",
    );
    await expect(store.read({ ...ref, repository: "other" })).rejects.toSatisfy(
      (e) => code(e) === "not-found",
    );
  });

  it("serialises concurrent writes from one instance without losing any", async () => {
    const refs = await Promise.all(
      Array.from({ length: 12 }, (_, i) => store.write(`c/${i}.txt`, `content ${i}`)),
    );
    expect(new Set(refs.map((r) => r.commit)).size).toBe(12);
    for (const [i, ref] of refs.entries()) {
      expect(await store.read(ref)).toBe(`content ${i}`);
    }
  });

  it("detects a concurrent update by another writer instead of overwriting it", async () => {
    await store.write("seed.txt", "seed");
    const other = new GitArtifactStore({ repoPath: dir, repository: "test-archive" });
    // Interleave: both instances read the same parent, the second update must fail CAS.
    const results = await Promise.allSettled([
      store.write("race/a.txt", "a"),
      other.write("race/b.txt", "b"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      if (r.status === "rejected") expect(code(r.reason)).toBe("concurrent-update");
    }
  });

  it("reports an interrupted commit left as a stale ref lock", async () => {
    await store.write("seed.txt", "seed");
    await writeFile(join(dir, "refs", "heads", "main.lock"), "");
    await expect(store.write("after/crash.txt", "x")).rejects.toSatisfy(
      (e) => code(e) === "interrupted-commit",
    );
  });

  it("enforces the size limit", async () => {
    const small = new GitArtifactStore({ repoPath: dir, repository: "test-archive", maxBytes: 4 });
    await expect(small.write("big.txt", "12345")).rejects.toSatisfy((e) => code(e) === "too-large");
  });

  it("fails closed when an existing artifact is larger than this instance reads", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    await store.write("big/artifact.txt", big);
    const small = new GitArtifactStore({ repoPath: dir, repository: "test-archive", maxBytes: 4 });
    await expect(small.write("big/artifact.txt", "new")).rejects.toSatisfy(
      (e) => code(e) === "immutable-conflict",
    );
    // The identical large content is still recognised without being read.
    const same = await store.write("big/artifact.txt", big);
    expect(same.sha256).toBe(sha256(big));
  });

  it("rejects instead of crashing when git cannot read a large input", async () => {
    const missing = new GitArtifactStore({
      repoPath: join(dir, "does-not-exist"),
      repository: "test-archive",
    });
    const error = await missing.write("a/x.txt", "y".repeat(2 * 1024 * 1024)).catch((e) => e);
    expect(error).toBeInstanceOf(ArtifactStoreError);
    expect(String(error)).not.toContain(dir);
  });

  it("sanitises history lookup failures on an identical retry", async () => {
    const ref = await store.write("a/x.txt", "content");
    const broken = new GitArtifactStore({
      repoPath: dir,
      repository: "test-archive",
      gitBinary: join(dir, "fake-git.sh"),
    });
    // A git wrapper that fails only for `log`, standing in for a damaged history.
    await writeFile(
      join(dir, "fake-git.sh"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = log ] && { echo "fatal: bad object in ${dir}" >&2; exit 128; }; done\nexec git "$@"\n`,
      { mode: 0o755 },
    );
    const error = await broken.write(ref.path, "content").catch((e) => e);
    expect(error).toBeInstanceOf(ArtifactStoreError);
    expect((error as ArtifactStoreError).code).toBe("git-failed");
    expect(String(error)).not.toContain(dir);
  });

  it("reports an unknown commit as not found", async () => {
    const ref = await store.write("a/x.txt", "content");
    await expect(store.read({ ...ref, commit: "f".repeat(40) })).rejects.toSatisfy(
      (e) => code(e) === "not-found",
    );
  });

  it("does not leak the repository path in errors", async () => {
    const error = await store.write("../x", "y").catch((e: unknown) => e);
    expect(String(error)).not.toContain(dir);
  });
});
