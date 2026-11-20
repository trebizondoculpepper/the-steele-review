import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import {
  RESEARCH_COLLECTION_INDEX_V1,
  reconcileResearchIndex,
  researchDocumentId,
  researchDocumentKind,
} from "../../src/research/research-index.js";

/** In-memory stand-in for the controller methods the indexer uses. */
class FakeIndex {
  docs = new Map<string, Record<string, unknown>>();
  writes = 0;
  failNextIndex = false;
  async search(_index: string, query: { ids?: { values: string[] } }) {
    const id = query.ids?.values[0];
    const doc = id ? this.docs.get(id) : undefined;
    return doc ? [{ id: id!, score: 1, source: doc }] : [];
  }
  async indexDocument(_index: string, id: string, document: unknown) {
    if (this.failNextIndex) {
      this.failNextIndex = false;
      throw new Error("unavailable");
    }
    this.writes++;
    this.docs.set(id, document as Record<string, unknown>);
    return { index: RESEARCH_COLLECTION_INDEX_V1, id, result: "created" as const, version: 1 };
  }
  refreshes = 0;
  async refreshIndex() {
    this.refreshes++;
  }
  async deleteDocument(_index: string, id: string) {
    this.docs.delete(id);
  }
  async deleteMatching(
    _index: string,
    query: { bool: { must_not: [{ term: { generation: string } }, unknown] } },
  ) {
    const keep = query.bool.must_not[0].term.generation;
    let n = 0;
    for (const [id, d] of this.docs) {
      if (id !== "checkpoint" && d.generation !== keep) {
        this.docs.delete(id);
        n++;
      }
    }
    return n;
  }
  text(path: string) {
    return this.docs.get(researchDocumentId(path))?.text as string | undefined;
  }
}

let dir: string;
let artifacts: GitArtifactStore;
let es: FakeIndex;
const JOB = `research-jobs/research-${"a".repeat(32)}`;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-research-index-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await artifacts.initialise();
  es = new FakeIndex();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const rev = async (path: string, content: string) =>
  artifacts.revise(path, content, (await artifacts.lookup(path))?.sha256 ?? null);
const reconcile = () => reconcileResearchIndex({ artifacts, es });

describe("research collection indexing", () => {
  it("indexes only explicit research document kinds", () => {
    expect(researchDocumentKind("dossier/theme-x.md")).toBe("dossier");
    expect(researchDocumentKind("research-reports/manual/havana/abc.md")).toBe("research-report");
    expect(researchDocumentKind(`${JOB}/report.md`)).toBe("research-report");
    expect(researchDocumentKind(`${JOB}/covering-note.md`)).toBe("covering-note");
    expect(researchDocumentKind(`${JOB}/coverage.md`)).toBe("covering-note");
    expect(researchDocumentKind(`${JOB}/sources/1.json`)).toBe("source-snapshot");
    for (const excluded of [
      `${JOB}/request.json`,
      `${JOB}/result.json`,
      `${JOB}/manifest.json`,
      "catalogue/themes.json",
      "claims/claim-1.json",
      "theme-proposals/pub/p/x.json",
      "dossier/theme-x.json",
    ]) {
      expect(researchDocumentKind(excluded)).toBeUndefined();
    }
  });

  it("finds a new dossier, report and source text without a manual command, with exact provenance", async () => {
    await artifacts.write(
      `${JOB}/report.md`,
      "# Havana Syndrome\nThe 2023 assessment found no foreign adversary.\n",
    );
    await artifacts.write(
      `${JOB}/sources/1.json`,
      JSON.stringify({ url: "https://www.dni.gov/x", title: "ICA", text: "IC assessment text" }),
    );
    await artifacts.write(`${JOB}/request.json`, "{}");
    await rev("dossier/theme-havana.md", "# Havana Syndrome dossier\nv1\n");
    const first = await reconcile();
    expect(first).toMatchObject({ full: true, indexed: 3 });
    expect(es.text(`${JOB}/sources/1.json`)).toBe("IC assessment text");
    const dossier = es.docs.get(researchDocumentId("dossier/theme-havana.md"))!;
    const ref = (await artifacts.lookup("dossier/theme-havana.md"))!;
    expect(dossier).toMatchObject({
      kind: "dossier",
      title: "Havana Syndrome dossier",
      artifactCommit: ref.commit,
      artifactHash: `sha256:${ref.sha256}`,
    });
    expect([...es.docs.keys()]).not.toContain(researchDocumentId(`${JOB}/request.json`));
  });

  it("reflects a revision in place and replays the same revision safely", async () => {
    await rev("dossier/theme-havana.md", "# D\nv1\n");
    await reconcile();
    await rev("dossier/theme-havana.md", "# D\nv2\n");
    const second = await reconcile();
    expect(second).toMatchObject({ full: false, indexed: 1 });
    expect(es.text("dossier/theme-havana.md")).toBe("# D\nv2\n");
    const writes = es.writes;
    expect(await reconcile()).toMatchObject({ unchanged: true });
    expect(es.writes).toBe(writes);
    expect([...es.docs.keys()].filter((k) => k !== "checkpoint")).toHaveLength(1);
  });

  it("catches up after downtime with several commits, and keeps the checkpoint on failure", async () => {
    await rev("dossier/a.md", "# A\n");
    await reconcile();
    await rev("dossier/b.md", "# B\n");
    await rev("dossier/a.md", "# A2\n");
    es.failNextIndex = true;
    await expect(reconcile()).rejects.toThrow();
    const before = es.docs.get("checkpoint")?.checkpoint;
    const after = await reconcile();
    expect(after).toMatchObject({ full: false, indexed: 2 });
    expect(es.docs.get("checkpoint")?.checkpoint).not.toBe(before);
    expect(es.text("dossier/a.md")).toBe("# A2\n");
  });

  it("rebuilds from scratch when the checkpoint is lost, removing documents no longer present", async () => {
    await rev("dossier/a.md", "# A\n");
    await reconcile();
    es.docs.set(researchDocumentId("dossier/ghost.md"), { generation: "old", text: "stale" });
    es.docs.delete("checkpoint");
    const out = await reconcile();
    expect(out).toMatchObject({ full: true, indexed: 1, removed: 1 });
    expect(es.refreshes).toBeGreaterThan(0);
    expect(es.text("dossier/ghost.md")).toBeUndefined();
  });

  it("reconciles in full after an interrupted pass, so a later revert is not missed", async () => {
    await rev("dossier/a.md", "# A1\n");
    await reconcile();
    await rev("dossier/a.md", "# A2\n");
    await rev("dossier/b.md", "# B\n");
    // Fail after A2 is written but before the checkpoint advances.
    const original = es.indexDocument.bind(es);
    let calls = 0;
    es.indexDocument = async (i, id, d) => {
      if (++calls === 3) throw new Error("unavailable");
      return original(i, id, d);
    };
    await expect(reconcile()).rejects.toThrow();
    es.indexDocument = original;
    expect(es.text("dossier/a.md")).toBe("# A2\n");
    await rev("dossier/a.md", "# A1\n"); // reverted to the checkpointed content
    const out = await reconcile();
    expect(out.full).toBe(true);
    expect(es.text("dossier/a.md")).toBe("# A1\n");
  });

  it("reads each document at the pass's head, not a later commit", async () => {
    await rev("dossier/a.md", "# A1\n");
    const realChanges = artifacts.changesSince.bind(artifacts);
    artifacts.changesSince = async (from) => {
      const result = await realChanges(from);
      await rev("dossier/a.md", "# A2 committed mid-pass\n");
      return result;
    };
    await reconcile();
    artifacts.changesSince = realChanges;
    expect(es.text("dossier/a.md")).toBe("# A1\n");
    // The later commit is picked up by the next pass.
    await reconcile();
    expect(es.text("dossier/a.md")).toBe("# A2 committed mid-pass\n");
  });

  it("notifies through the artifact store when the branch moves", async () => {
    let calls = 0;
    const watcher = await artifacts.watchBranch(() => calls++);
    expect(watcher.active).toBe(true);
    await rev("dossier/a.md", "# A\n");
    await new Promise((r) => setTimeout(r, 300));
    watcher.close();
    expect(calls).toBeGreaterThan(0);
  });

  it("abandons a pass, keeping the checkpoint, when ownership is lost", async () => {
    await rev("dossier/a.md", "# A\n");
    await expect(
      reconcileResearchIndex({
        artifacts,
        es,
        keepAlive: () => {
          throw new Error("not-owner");
        },
      }),
    ).rejects.toThrow("not-owner");
    expect(es.docs.get("checkpoint")?.checkpoint).toBeUndefined();
    expect(es.text("dossier/a.md")).toBeUndefined();
  });

  it("skips unreadable source snapshots without leaving stale copies", async () => {
    await artifacts.write(`${JOB}/sources/2.json`, "not json");
    expect(await reconcile()).toMatchObject({ skipped: 1, indexed: 0 });
  });
});
