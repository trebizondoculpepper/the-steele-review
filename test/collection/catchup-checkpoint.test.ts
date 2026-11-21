import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fileCheckpoint } from "../../src/collection/catchup-checkpoint.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-checkpoint-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("catch-up checkpoint file (#252)", () => {
  it("is absent until saved, round-trips, and leaves no temporary file", async () => {
    const cp = fileCheckpoint(join(dir, "captured.json"));
    expect(await cp.load()).toBeUndefined();
    await cp.save({ publicationId: "saveusnow", commit: "a".repeat(40), pending: "b".repeat(40) });
    await cp.save({ publicationId: "saveusnow", commit: "b".repeat(40) });
    expect(await cp.load()).toEqual({ publicationId: "saveusnow", commit: "b".repeat(40) });
    expect(await readdir(dir)).toEqual(["captured.json"]);
  });
});
