import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ArtifactStoreError, GitArtifactStore } from "../../src/controllers/artifact-store.js";
import {
  DossierStore,
  InvalidDossierError,
  StaleDossierError,
  parseDossier,
  renderDossier,
  type Dossier,
} from "../../src/research/dossier.js";

let dir: string;
let artifacts: GitArtifactStore;
let store: DossierStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-dossier-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await artifacts.initialise();
  store = new DossierStore(artifacts);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base: Dossier = {
  metadata: {
    schemaVersion: 1,
    themeId: "geoengineering",
    title: "Geoengineering and weather modification",
    scope: "Claims that weather is deliberately modified at scale.",
    claims: [{ claimId: "claim-a", status: "gap", reason: "not yet researched" }],
    citations: [],
    gaps: ["claim-a"],
    updatedAt: "2026-11-19T00:00:00Z",
  },
  body: "# Geoengineering\n\nNo research yet.",
};

const revised: Dossier = {
  metadata: {
    ...base.metadata,
    claims: [{ claimId: "claim-a", status: "covered", citations: ["royal-society-2009"] }],
    citations: [
      {
        id: "royal-society-2009",
        url: "https://royalsociety.org/geoengineering",
        title: "Geoengineering the climate",
        passage: "Solar radiation management methods have not been deployed.",
        sourceDate: "2009-09-01",
        checkedAt: "2026-11-19T00:00:00Z",
      },
    ],
    gaps: [],
    updatedAt: "2026-11-20T00:00:00Z",
  },
  body: "# Geoengineering\n\nSee [royal-society-2009].",
};

describe("DossierStore", () => {
  it("creates, revises and keeps old versions readable and hash-verified", async () => {
    expect(await store.current("geoengineering")).toBeUndefined();
    const v1 = await store.save(base, undefined);
    expect(v1.ref.path).toBe("dossier/geoengineering.md");
    const v2 = await store.save(revised, v1.ref);
    expect(v2.ref.commit).not.toBe(v1.ref.commit);

    const now = await store.current("geoengineering");
    expect(now?.ref).toEqual(v2.ref);
    expect(now?.metadata.claims[0].status).toBe("covered");

    const old = await store.at(v1.ref);
    expect(old.metadata.claims[0].status).toBe("gap");
    await expect(artifacts.read({ ...v1.ref, sha256: v2.ref.sha256 })).rejects.toThrow(
      ArtifactStoreError,
    );
  });

  it("rejects a stale writer instead of overwriting", async () => {
    const v1 = await store.save(base, undefined);
    await store.save(revised, v1.ref);
    await expect(store.save({ ...base, body: "# Other edit" }, v1.ref)).rejects.toBeInstanceOf(
      StaleDossierError,
    );
    await expect(store.save(base, undefined)).rejects.toBeInstanceOf(StaleDossierError);
  });

  it("treats an unchanged write and a retried landed write as no-ops", async () => {
    const v1 = await store.save(base, undefined);
    const again = await store.save(base, v1.ref);
    expect(again.ref).toEqual(v1.ref);
    const retry = await store.save(base, undefined); // create retried after it landed
    expect(retry.ref).toEqual(v1.ref);
  });

  it("validates metadata and paths", () => {
    expect(() =>
      renderDossier({ ...base, metadata: { ...base.metadata, themeId: "../x" } }),
    ).toThrow();
    expect(() =>
      renderDossier({
        ...base,
        metadata: {
          ...base.metadata,
          claims: [{ claimId: "c", status: "covered", citations: ["missing"] }],
        },
      }),
    ).toThrow();
    expect(() => parseDossier("no metadata")).toThrow(InvalidDossierError);
    expect(parseDossier(renderDossier(revised))).toEqual(revised);
  });
});

describe("artifact immutability is preserved", () => {
  it("keeps write-once paths write-once and dossiers out of the immutable API", async () => {
    const capture = await artifacts.write("substack/pub/post/collected.json", "{}");
    // Owner-authorised reingestion (#558): a capture record may be revised in
    // place, but only against its exact current version.
    await expect(artifacts.revise("substack/pub/post/collected.json", "{1}", null)).rejects.toThrow(
      "stale-revision",
    );
    const revised = await artifacts.revise(
      "substack/pub/post/collected.json",
      "{1}",
      capture.sha256,
    );
    expect((await artifacts.lookupAt(capture.commit, capture.path))?.content).toBe("{}");
    expect(revised.commit).not.toBe(capture.commit);
    // Every other archived source artifact stays write-once.
    await artifacts.write("substack/pub/post/media.json", "{}");
    await expect(artifacts.revise("substack/pub/post/media.json", "{1}", null)).rejects.toThrow(
      "invalid-path",
    );
    await expect(artifacts.write("dossier/x.md", "x")).rejects.toThrow("invalid-path");
    await expect(artifacts.write("substack/pub/post/media.json", "changed")).rejects.toThrow(
      "immutable-conflict",
    );
  });
});
