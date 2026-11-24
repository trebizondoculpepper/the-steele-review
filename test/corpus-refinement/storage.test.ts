import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  assertIsolatedStore,
  CorpusStorageConflictError,
} from "../../src/corpus-refinement/storage.js";

// Temporary directories only: no live repository is touched (#847).
let root: string;
let archive: string;
let content: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "corpus-storage-"));
  archive = join(root, "archive");
  content = join(root, "content");
  await Promise.all(
    [archive, content, join(root, "data", "state"), join(root, "deep", "child")].map((d) =>
      mkdir(d, { recursive: true }),
    ),
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const live = () => [
  { name: "STEELE_ARCHIVE_PATH", path: archive },
  { name: "STEELE_CONTENT_PATH", path: content },
];
const store = (path: string) => ({ name: "STEELE_CORPUS_REFINEMENT_PATH", path });
const check =
  (path: string, liveRepos = live()) =>
  () =>
    assertIsolatedStore(store(path), liveRepos);

describe("Corpus Refinement storage isolation (#847)", () => {
  it("accepts the default location beside the state directory, before it exists", () => {
    expect(check(join(root, "data", "corpus-refinement-prototype"))()).toMatch(
      /corpus-refinement-prototype$/,
    );
  });

  it("accepts a valid isolated override", () => {
    expect(check(join(root, "elsewhere", "corpus"))).not.toThrow();
  });

  it("rejects the live repository itself, a path inside it, and a path containing it", () => {
    for (const path of [archive, join(content, "corpus"), root]) {
      expect(check(path)).toThrow(CorpusStorageConflictError);
    }
  });

  it("rejects an alias that resolves into a live repository", async () => {
    const alias = join(root, "alias-to-content");
    await symlink(content, alias);
    expect(check(alias)).toThrow(CorpusStorageConflictError);
    expect(check(join(alias, "not-yet", "corpus"))).toThrow(CorpusStorageConflictError);
  });

  it("follows a symbolic link before '..', as the kernel does", async () => {
    // outer/link -> deep/child, so outer/link/.. is deep, not outer. Spelled
    // as a string: path.join would collapse the ".." before the check sees it.
    await mkdir(join(root, "outer"));
    await symlink(join(root, "deep", "child"), join(root, "outer", "link"));
    const liveThroughLink = [{ name: "STEELE_ARCHIVE_PATH", path: `${root}/outer/link/..` }];
    expect(check(join(root, "deep"), liveThroughLink)).toThrow(CorpusStorageConflictError);
    expect(check(join(root, "outer"), liveThroughLink)).not.toThrow();
  });

  it("refuses '..' after a missing directory", () => {
    expect(check(`${root}/missing/../archive`)).toThrow(/has '\.\.' after a missing/);
  });

  it("treats spellings that differ only in case as one directory where the volume does", () => {
    const upper = join(root, "ARCHIVE");
    if (!existsSync(upper)) return; // case-sensitive volume: distinct directories
    expect(check(upper)).toThrow(CorpusStorageConflictError);
  });

  it("does not mistake a sibling with a shared prefix for an overlap", () => {
    expect(check(`${content}-corpus`)).not.toThrow();
  });

  it("names configuration variables in its message, never their values", () => {
    try {
      check(join(archive, "corpus"))();
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe(
        "Corpus Refinement store (STEELE_CORPUS_REFINEMENT_PATH) overlaps the live repository (STEELE_ARCHIVE_PATH)",
      );
      expect((error as Error).message).not.toContain(root);
    }
  });
});
