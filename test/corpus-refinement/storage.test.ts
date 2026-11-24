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
let state: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "corpus-storage-"));
  archive = join(root, "archive");
  content = join(root, "content");
  state = join(root, "data", "state");
  await Promise.all([archive, content, state].map((d) => mkdir(d, { recursive: true })));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const live = () => [archive, content];

describe("Corpus Refinement storage isolation (#847)", () => {
  it("accepts the default location beside the state directory, before it exists", () => {
    const store = join(root, "data", "corpus-refinement-prototype");
    expect(assertIsolatedStore(store, live())).toMatch(/corpus-refinement-prototype$/);
  });

  it("accepts a valid isolated override", () => {
    expect(() => assertIsolatedStore(join(root, "elsewhere", "corpus"), live())).not.toThrow();
  });

  it("rejects the live repository itself, a path inside it, and a path containing it", () => {
    for (const store of [archive, join(content, "corpus"), root]) {
      expect(() => assertIsolatedStore(store, live())).toThrow(CorpusStorageConflictError);
    }
  });

  it("rejects an alias that resolves into a live repository", async () => {
    const alias = join(root, "alias-to-content");
    await symlink(content, alias);
    expect(() => assertIsolatedStore(alias, live())).toThrow(CorpusStorageConflictError);
    expect(() => assertIsolatedStore(join(alias, "not-yet", "corpus"), live())).toThrow(
      CorpusStorageConflictError,
    );
  });

  it("does not mistake a sibling with a shared prefix for an overlap", () => {
    expect(() => assertIsolatedStore(`${content}-corpus`, live())).not.toThrow();
  });
});
