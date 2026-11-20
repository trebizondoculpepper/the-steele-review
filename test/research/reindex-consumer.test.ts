import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import {
  createResearchReindexEvent,
  researchReindexDataJsonSchema,
} from "../../src/events/research-reindex-event.js";
import { handleReindexRequest, requestKey } from "../../src/research/reindex-consumer.js";
import { reconcileResearchIndex, researchDocumentId } from "../../src/research/research-index.js";

const encode = (route: string, id = "r1") =>
  new TextEncoder().encode(
    JSON.stringify(createResearchReindexEvent({ route }, { id, now: () => new Date(0) }).toJSON()),
  );

class FakeIndex {
  docs = new Map<string, Record<string, unknown>>();
  writes = new Map<string, number>();
  async search(_i: string, q: { ids?: { values: string[] } }) {
    const d = this.docs.get(q.ids!.values[0]);
    return d ? [{ id: q.ids!.values[0], score: 1, source: d }] : [];
  }
  async indexDocument(_i: string, id: string, doc: unknown) {
    this.docs.set(id, doc as Record<string, unknown>);
    this.writes.set(id, (this.writes.get(id) ?? 0) + 1);
    return { index: "i", id, result: "created" as const, version: 1 };
  }
  async deleteDocument(_i: string, id: string) {
    this.docs.delete(id);
  }
  async deleteMatching() {
    return 0;
  }
  async refreshIndex() {}
}

let dir: string;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-reindex-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await artifacts.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const rev = async (path: string, content: string) =>
  artifacts.revise(path, content, (await artifacts.lookup(path))?.sha256 ?? null);

describe("research reindex requests (#232)", { timeout: 60_000 }, () => {
  it("rejects malformed requests and unknown routes without retrying", async () => {
    const routes = new Set(["havana"]);
    let ran = 0;
    const reconcile = async () => (ran++, true as const);
    expect(
      await handleReindexRequest(new TextEncoder().encode("{}"), routes, reconcile),
    ).toMatchObject({
      action: "term",
      reason: "malformed-request",
      requestId: expect.stringMatching(/^payload-/),
    });
    expect(await handleReindexRequest(encode("other"), routes, reconcile)).toMatchObject({
      action: "term",
      reason: "unknown-route",
      route: "other",
      requestId: expect.stringMatching(/^req-[0-9a-f]{40}$/),
    });
    // A request without the required CloudEvents source is malformed.
    const noSource = JSON.parse(new TextDecoder().decode(encode("havana")));
    delete noSource.source;
    expect(
      await handleReindexRequest(
        new TextEncoder().encode(JSON.stringify(noSource)),
        routes,
        reconcile,
      ),
    ).toMatchObject({ reason: "malformed-request" });
    expect(ran).toBe(0);
    // Same ID from two sources: distinct failure identities.
    expect(requestKey({ source: "a", id: "x" })).not.toBe(requestKey({ source: "b", id: "x" }));
    expect(researchReindexDataJsonSchema()).toMatchObject({ type: "object" });
  });

  it("acks after reconciliation, and asks for redelivery when busy or failed", async () => {
    const routes = new Set(["havana"]);
    expect(await handleReindexRequest(encode("havana"), routes, async () => true)).toMatchObject({
      action: "ack",
    });
    expect(await handleReindexRequest(encode("havana"), routes, async () => "busy")).toMatchObject({
      action: "nak",
      why: "busy",
    });
    expect(await handleReindexRequest(encode("havana"), routes, async () => false)).toMatchObject({
      action: "nak",
      why: "failed",
    });
    expect(
      await handleReindexRequest(
        encode("havana", "req-9"),
        routes,
        async () => false,
        30_000,
        5_000,
        { count: 10, max: 10 },
      ),
    ).toMatchObject({
      action: "term",
      reason: "retries-exhausted",
      route: "havana",
      requestId: expect.stringMatching(/^req-/),
    });
  });

  it("indexes a revision with no filesystem notification exactly once, and replays safely", async () => {
    const es = new FakeIndex();
    const reconcile = async () => {
      await reconcileResearchIndex({ artifacts, es });
      return true as const;
    };
    const routes = new Set(["havana"]);
    await rev("dossier/havana.md", "# Havana\nv1\n");
    await handleReindexRequest(encode("havana", "a"), routes, reconcile);
    const id = researchDocumentId("dossier/havana.md");
    expect(es.docs.get(id)?.text).toBe("# Havana\nv1\n");

    // A revision committed while nothing is watching.
    await rev("dossier/havana.md", "# Havana\nv2\n");
    const before = es.writes.get(id)!;
    expect(await handleReindexRequest(encode("havana", "b"), routes, reconcile)).toMatchObject({
      action: "ack",
    });
    expect(es.docs.get(id)?.text).toBe("# Havana\nv2\n");
    expect(es.writes.get(id)).toBe(before + 1);

    // Duplicate delivery: no further write, still one current document.
    await handleReindexRequest(encode("havana", "b"), routes, reconcile);
    expect(es.writes.get(id)).toBe(before + 1);
    expect([...es.docs.keys()].filter((k) => k !== "checkpoint")).toEqual([id]);
  });
});
