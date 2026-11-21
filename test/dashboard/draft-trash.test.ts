import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import {
  DraftTrashStore,
  TrashConflictError,
  trashMarkerPath,
} from "../../src/dashboard/draft-trash.js";

let dir: string;
let artifacts: GitArtifactStore;
let trash: DraftTrashStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-trash-"));
  await mkdir(join(dir, "c"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "c"), repository: "content" });
  await artifacts.initialise();
  trash = new DraftTrashStore(artifacts);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const draft = "drafts/pub/post/v1.json";
const deleteMarker = {
  schemaVersion: 1 as const,
  draftPath: draft,
  publicationHash: `sha256:${"a".repeat(64)}`,
  action: "delete" as const,
  requestId: "req-1",
  at: "2026-02-01T00:00:00.000Z",
};

describe("draft trash (#478)", () => {
  it("starts active and becomes trashed after a delete marker", async () => {
    expect(await trash.state(draft)).toBe("active");
    const { marker, recorded } = await trash.mark(deleteMarker);
    expect(recorded).toBe(true);
    expect(marker.draftPath).toBe(draft);
    expect(await trash.state(draft)).toBe("trashed");
  });

  it("restores with a later marker and keeps history", async () => {
    await trash.mark(deleteMarker);
    await trash.mark({ ...deleteMarker, action: "restore", requestId: "req-2", at: "2026-02-02T00:00:00.000Z" });
    expect(await trash.state(draft)).toBe("active");
    expect((await trash.markers()).map((m) => m.action)).toEqual(["delete", "restore"]);
  });

  it("retrying the same request does not duplicate the record", async () => {
    const first = await trash.mark(deleteMarker);
    const again = await trash.mark(deleteMarker);
    expect(first.recorded).toBe(true);
    expect(again.recorded).toBe(false);
    expect(again.marker).toEqual(first.marker);
    expect(await trash.markers()).toHaveLength(1);
  });

  it("refuses to reuse a request id for a different action or draft", async () => {
    await trash.mark(deleteMarker);
    await expect(trash.mark({ ...deleteMarker, action: "restore" })).rejects.toBeInstanceOf(
      TrashConflictError,
    );
    await expect(trash.mark({ ...deleteMarker, draftPath: "drafts/pub/post/v2.json" })).rejects.toBeInstanceOf(
      TrashConflictError,
    );
  });

  it("never rewrites the saved draft artifact", async () => {
    await artifacts.write(draft, '{"body":"saved"}\n');
    const before = await artifacts.lookup(draft);
    await trash.mark(deleteMarker);
    expect(await artifacts.lookup(draft)).toEqual(before);
  });

  it("records markers at a stable versioned path", async () => {
    await trash.mark(deleteMarker);
    expect(trashMarkerPath("req-1")).toBe("draft-trash/req-1.json");
    expect(await artifacts.lookup(trashMarkerPath("req-1"))).toBeDefined();
  });
});
