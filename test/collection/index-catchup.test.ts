import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { CollectionRecord } from "../../src/collection/collection-store.js";
import { catchUpIndex, type CatchUpCheckpointState } from "../../src/collection/index-catchup.js";
import { replayArchiveToIndex } from "../../src/collection/index-replay.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { IndexingError } from "../../src/controllers/elasticsearch.js";

const run = promisify(execFile);
let dir: string;
let repo: string;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-catchup-"));
  repo = join(dir, "archive");
  await mkdir(repo);
  artifacts = new GitArtifactStore({ repoPath: repo, repository: "test-archive" });
  await artifacts.initialise();
  // Seed the branch so plumbing commits have a parent.
  await artifacts.write("seed/readme.md", "seed\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const path = (postId: string, pub = "example-pub") => `substack/${pub}/${postId}/collected.json`;
const record = (postId: string, retrievedAt = "2026-02-01T00:00:00.000Z", pub = "example-pub") =>
  `${JSON.stringify({
    item: {
      publicationId: pub,
      postId,
      url: `https://${pub}.substack.com/p/${postId}`,
      title: `Synthetic ${postId}`,
    },
    ingestionReason: "backfill",
    text: `Synthetic text of ${postId} at ${retrievedAt}.`,
    complete: true,
    supplied: {},
    provenance: {
      sourceUrl: `https://${pub}.substack.com/p/${postId}`,
      acquiredAt: retrievedAt,
      method: "article-html",
    },
  } satisfies CollectionRecord)}\n`;

/** Commit adds, revisions and removals on the archive branch with Git plumbing. */
async function commit(changes: Record<string, string | null>) {
  const git = (args: string[], env: Record<string, string> = {}, input?: string) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        "git",
        ["-C", repo, ...args],
        { env: { ...process.env, ...env } },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
      );
      if (input !== undefined) child.stdin!.end(input);
    });
  const env = {
    GIT_INDEX_FILE: join(dir, "index.tmp"),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const head = await git(["rev-parse", "refs/heads/main"]);
  await git(["read-tree", head], env);
  for (const [p, content] of Object.entries(changes)) {
    if (content === null) {
      await git(["update-index", "--index-info"], env, `0 ${"0".repeat(40)}\t${p}\n`);
    } else {
      const blob = await git(["hash-object", "-w", "--stdin"], env, content);
      await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${p}`], env);
    }
  }
  const tree = await git(["write-tree"], env);
  const next = await git(["commit-tree", tree, "-p", head, "-m", "change"], env);
  await git(["update-ref", "refs/heads/main", next, head]);
  return next;
}

function fakeIndex(failIds: (id: string) => boolean = () => false) {
  const docs = new Map<string, { version: number; doc: Record<string, unknown> }>();
  return {
    docs,
    async indexDocument(
      _index: string,
      id: string,
      document: unknown,
      options?: { version?: number },
    ) {
      if (failIds(id)) throw new IndexingError("unavailable", true);
      const existing = docs.get(id);
      if (existing && options?.version !== undefined && options.version <= existing.version) {
        throw new IndexingError("stale-version", false);
      }
      docs.set(id, { version: options?.version ?? 0, doc: document as Record<string, unknown> });
    },
    async deleteDocument(_index: string, id: string) {
      docs.delete(id);
    },
  };
}

function memoryCheckpoint(initial?: CatchUpCheckpointState) {
  let state = initial;
  const saved: CatchUpCheckpointState[] = [];
  return {
    saved,
    get state() {
      return state;
    },
    store: {
      async load() {
        return state;
      },
      async save(next: CatchUpCheckpointState) {
        state = next;
        saved.push(next);
      },
    },
  };
}

const id = (postId: string, pub = "example-pub") => `substack:${pub}:${postId}`;

describe("incremental captured-post indexing from Git (#250)", { timeout: 60_000 }, () => {
  it("catches up adds, revisions and deletes over several commits from a bulk-load checkpoint", async () => {
    await artifacts.write(path("a"), record("a"));
    await artifacts.write(path("b"), record("b"));
    const loadedAt = await run("git", ["-C", repo, "rev-parse", "refs/heads/main"]).then((r) =>
      r.stdout.trim(),
    );
    const index = fakeIndex();
    // The #249 bulk load, pinned and checkpointed.
    const cp = memoryCheckpoint();
    await replayArchiveToIndex({
      selection: { publicationId: "example-pub", limit: 10, commit: loadedAt },
      artifacts,
      index,
      checkpoint: { save: (s) => cp.store.save(s as unknown as CatchUpCheckpointState) },
    });
    expect([...index.docs.keys()].sort()).toEqual([id("a"), id("b")]);

    // Several commits: add c, revise a, delete b.
    await commit({ [path("c")]: record("c") });
    await commit({ [path("a")]: record("a", "2026-03-01T00:00:00.000Z") });
    const head = await commit({ [path("b")]: null });

    const report = await catchUpIndex({
      artifacts,
      index,
      checkpoint: cp.store,
      publicationId: "example-pub",
    });
    expect(report).toMatchObject({
      ok: true,
      full: false,
      head,
      indexed: 2,
      removed: 1,
      checkpointAdvanced: true,
    });
    expect([...index.docs.keys()].sort()).toEqual([id("a"), id("c")]);
    expect(
      String(index.docs.get(id("a"))!.doc.text ?? JSON.stringify(index.docs.get(id("a")))),
    ).toContain("2026-03-01");
    // The bulk-load fields are kept; the commit advances; nothing is pending.
    expect(cp.state).toMatchObject({ publicationId: "example-pub", commit: head });
    expect(cp.state).not.toHaveProperty("pending");

    // Nothing new: an unchanged pass writes nothing.
    const again = await catchUpIndex({
      artifacts,
      index,
      checkpoint: cp.store,
      publicationId: "example-pub",
    });
    expect(again).toMatchObject({ unchanged: true, indexed: 0, removed: 0 });
  });

  it("does not advance after a failed change, and recovers an interrupted pass with a full reconcile", async () => {
    const first = await commit({ [path("a")]: record("a"), [path("b")]: record("b") });
    const cp = memoryCheckpoint({ commit: first });
    await commit({ [path("c")]: record("c"), [path("d")]: record("d") });

    // c fails transiently: the checkpoint stays pending.
    const flaky = fakeIndex((docId) => docId === id("c"));
    const failed = await catchUpIndex({ artifacts, index: flaky, checkpoint: cp.store });
    expect(failed).toMatchObject({ ok: false, checkpointAdvanced: false });
    expect(failed.failed.map((f) => f.path)).toEqual([path("c")]);
    expect(cp.state).toMatchObject({ commit: first, pending: expect.any(String) });

    // An aborted pass is also left pending.
    const abort = new AbortController();
    abort.abort();
    const index = fakeIndex();
    expect(
      await catchUpIndex({ artifacts, index, checkpoint: cp.store, signal: abort.signal }),
    ).toMatchObject({ interrupted: true, checkpointAdvanced: false });

    // The next pass reapplies every change since the last good commit.
    const recovered = await catchUpIndex({ artifacts, index, checkpoint: cp.store });
    expect(recovered).toMatchObject({ ok: true, full: false, checkpointAdvanced: true });
    expect([...index.docs.keys()].sort()).toEqual([id("c"), id("d")]);
    expect(cp.state).not.toHaveProperty("pending");
  });

  it("limits a pass to one publication and ignores non-capture paths", async () => {
    const first = await commit({ "README.md": "x\n" });
    const cp = memoryCheckpoint({ commit: first });
    await commit({
      [path("a")]: record("a"),
      [path("z", "other-pub")]: record("z", undefined, "other-pub"),
      "notes/x.md": "y\n",
    });
    const index = fakeIndex();
    const report = await catchUpIndex({
      artifacts,
      index,
      checkpoint: cp.store,
      publicationId: "example-pub",
    });
    expect(report).toMatchObject({ ok: true, indexed: 1 });
    expect([...index.docs.keys()]).toEqual([id("a")]);
  });

  it("keeps a deletion that failed until a later pass applies it", async () => {
    const first = await commit({ [path("a")]: record("a") });
    const index = fakeIndex();
    await index.indexDocument("i", id("a"), {}, {});
    const cp = memoryCheckpoint({ commit: first });
    await commit({ [path("a")]: null });
    let failDelete = true;
    const flaky = {
      ...index,
      async deleteDocument(i: string, docId: string) {
        if (failDelete) throw new IndexingError("unavailable", true);
        return index.deleteDocument(i, docId);
      },
    };
    expect(await catchUpIndex({ artifacts, index: flaky, checkpoint: cp.store })).toMatchObject({
      ok: false,
    });
    // Another commit lands before the retry; the deletion is still applied.
    await commit({ [path("b")]: record("b") });
    failDelete = false;
    expect(await catchUpIndex({ artifacts, index: flaky, checkpoint: cp.store })).toMatchObject({
      ok: true,
      removed: 1,
    });
    expect(index.docs.has(id("a"))).toBe(false);
  });

  it("refuses a checkpoint made for another publication scope", async () => {
    const first = await commit({ [path("a")]: record("a") });
    const cp = memoryCheckpoint({ publicationId: "example-pub", commit: first });
    const report = await catchUpIndex({ artifacts, index: fakeIndex(), checkpoint: cp.store });
    expect(report.failed).toEqual([{ path: "", reason: "checkpoint-scope-mismatch" }]);
    expect(
      await catchUpIndex({
        artifacts,
        index: fakeIndex(),
        checkpoint: cp.store,
        publicationId: "example-pub",
      }),
    ).toMatchObject({ ok: true });
    expect(cp.state).toMatchObject({ publicationId: "example-pub" });
  });

  it("removes a document a failed pass wrote when a later commit deletes its post", async () => {
    const first = await commit({ [path("a")]: record("a") });
    const cp = memoryCheckpoint({ commit: first });
    await commit({ [path("new")]: record("new"), [path("bad")]: record("bad") });
    const index = fakeIndex((docId) => docId === id("bad"));
    expect(await catchUpIndex({ artifacts, index, checkpoint: cp.store })).toMatchObject({
      ok: false,
    });
    expect(index.docs.has(id("new"))).toBe(true);
    // Both posts are removed before the retry: net change from the good commit is nothing.
    await commit({ [path("new")]: null, [path("bad")]: null });
    const healthy = fakeIndex();
    for (const [k, v] of index.docs) healthy.docs.set(k, v);
    expect(await catchUpIndex({ artifacts, index: healthy, checkpoint: cp.store })).toMatchObject({
      ok: true,
    });
    expect(healthy.docs.has(id("new"))).toBe(false);
  });

  it("refuses a checkpoint from a filtered bulk load", async () => {
    const first = await commit({ [path("a")]: record("a") });
    const cp = memoryCheckpoint({
      publicationId: "example-pub",
      commit: first,
      wholePublication: false,
    });
    const report = await catchUpIndex({
      artifacts,
      index: fakeIndex(),
      checkpoint: cp.store,
      publicationId: "example-pub",
    });
    expect(report.failed).toEqual([{ path: "", reason: "checkpoint-incomplete" }]);
  });
});
