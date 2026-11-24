import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { captureSource, resendSource, sourcePath } from "../../src/capture/source-capture.js";
import type { SubstackItem } from "../../src/content/substack-item.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import type { CollectionResult } from "../../src/controllers/substack/collect.js";

// Synthetic source, a temporary Git store and an in-memory publisher (#865).
const item: SubstackItem = {
  publicationId: "example-pub",
  postId: "a-post",
  url: "https://example-pub.substack.com/p/a-post",
  title: "A synthetic post",
};
const PREVIEW = {
  url: "https://substackcdn.example/image/upload/cover.png",
  source: "cover_image" as const,
  kind: "uploaded" as const,
};
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const fetched = (
  text: string,
  over: {
    acquiredAt?: string;
    method?: "article-html" | "supplied-transcript";
    preview?: boolean;
  } = {},
): CollectionResult => ({
  kind: "text",
  item,
  supplied: { articleHtml: `<p>${text}</p>` },
  text,
  complete: true,
  ...(over.preview === false ? {} : { previewImage: PREVIEW }),
  provenance: {
    sourceUrl: item.url,
    acquiredAt: over.acquiredAt ?? "2026-11-24T10:00:00.000Z",
    method: over.method ?? "article-html",
  },
});

let dir: string;
let artifacts: GitArtifactStore;
/** Like a deduplicating consumer: a repeated event ID is not a new event. */
let delivered: { id: string; path: string; hash: string }[];
let failNextPublish: boolean;
const publisher = {
  async publish(event: { id: string; data?: { artifact: { path: string; hash: string } } }) {
    if (failNextPublish) {
      failNextPublish = false;
      throw new Error("synthetic broker outage");
    }
    if (!delivered.some((d) => d.id === event.id))
      delivered.push({
        id: event.id,
        path: event.data!.artifact.path,
        hash: event.data!.artifact.hash,
      });
  },
};
const commitsTouching = (path: string) =>
  Number(
    execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD", "--", path]).toString().trim(),
  );

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "source-capture-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "archive" });
  await artifacts.initialise();
  delivered = [];
  failNextPublish = false;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const deps = (result: () => CollectionResult, images = true) => ({
  collector: { collect: async () => result() },
  artifacts,
  publisher: publisher as never,
  ...(images
    ? { images: { fetch: async () => ({ bytes: PNG, contentType: "image/png" as const }) } }
    : {}),
});

describe("source capture as one block (#865)", () => {
  it("saves one stable file with its image, then announces it", async () => {
    const out = await captureSource(
      item,
      deps(() => fetched("First version.")),
      { reason: "live" },
    );
    if (out.status === "not-captured") throw new Error(out.reason);
    expect(out.status).toBe("saved");
    expect(out.ref.path).toBe("substack/example-pub/a-post/source.json");
    expect(out.preview).toBe("retained");
    const saved = JSON.parse(await artifacts.read(out.ref));
    expect(saved.previewImage.retained.artifact.path).toMatch(/^substack\/example-pub\/a-post\/images\//);
    // Nothing volatile is saved: no capture time, reason or collector state.
    expect(JSON.stringify(saved)).not.toMatch(/acquiredAt|ingestionReason|reingestion/);
    expect(delivered).toEqual([
      { id: out.eventId, path: out.ref.path, hash: `sha256:${out.ref.sha256}` },
    ]);
  });

  it("makes no content change for a refetch, retry or later capture time", async () => {
    const first = await captureSource(
      item,
      deps(() => fetched("Same text.")),
      { reason: "live" },
    );
    const again = await captureSource(
      item,
      deps(() => fetched("Same text.", { acquiredAt: "2026-12-01T00:00:00.000Z" })),
      { reason: "backfill" },
    );
    if (first.status === "not-captured" || again.status === "not-captured") throw new Error();
    expect(again.status).toBe("unchanged");
    expect(again.ref.sha256).toBe(first.ref.sha256);
    expect(commitsTouching(sourcePath(item))).toBe(1);
    // The same saved file means the same logical event: one delivery.
    expect(again.eventId).toBe(first.eventId);
    expect(delivered).toHaveLength(1);
  });

  it("updates the same path in place when the source changes, keeping history", async () => {
    const first = await captureSource(
      item,
      deps(() => fetched("Before the edit.")),
      { reason: "live" },
    );
    const edited = await captureSource(
      item,
      deps(() => fetched("After the edit.")),
      { reason: "live" },
    );
    if (first.status === "not-captured" || edited.status === "not-captured") throw new Error();
    expect(edited.status).toBe("saved");
    expect(edited.ref.path).toBe(first.ref.path);
    expect(edited.ref.sha256).not.toBe(first.ref.sha256);
    expect(commitsTouching(sourcePath(item))).toBe(2);
    // Both versions stay readable by their pinned references.
    expect(JSON.parse(await artifacts.read(first.ref)).text).toBe("Before the edit.");
    expect(JSON.parse(await artifacts.read(edited.ref)).text).toBe("After the edit.");
    expect(delivered.map((d) => d.id)).toEqual([first.eventId, edited.eventId]);
  });

  it("saves the source when its image cannot be fetched, and when it has none", async () => {
    const failing = {
      ...deps(() => fetched("Text with a broken image.")),
      images: { fetch: async () => Promise.reject(new Error("synthetic 404")) },
    };
    const out = await captureSource(item, failing, { reason: "live" });
    if (out.status === "not-captured") throw new Error(out.reason);
    expect(out.preview).toBe("failed");
    const saved = JSON.parse(await artifacts.read(out.ref));
    expect(saved.previewImage.retained).toBeUndefined();

    const other = { ...item, postId: "no-image" };
    const none = await captureSource(
      other,
      { ...deps(() => ({ ...fetched("No image.", { preview: false }), item: other })) },
      { reason: "live" },
    );
    if (none.status === "not-captured") throw new Error(none.reason);
    expect(none.preview).toBe("no-preview");
  });

  it("recovers from an interruption between save and announce without a second event", async () => {
    failNextPublish = true;
    await expect(
      captureSource(
        item,
        deps(() => fetched("Saved, then the broker failed.")),
        { reason: "live" },
      ),
    ).rejects.toThrow(/broker outage/);
    expect(await artifacts.lookup(sourcePath(item))).toBeDefined();
    expect(delivered).toHaveLength(0);
    const retried = await captureSource(
      item,
      deps(() => fetched("Saved, then the broker failed.")),
      {
        reason: "live",
      },
    );
    if (retried.status === "not-captured") throw new Error();
    expect(retried.status).toBe("unchanged");
    expect(delivered).toHaveLength(1);
    expect(commitsTouching(sourcePath(item))).toBe(1);
  });

  it("resends the saved references with the same event identity, without fetching", async () => {
    const out = await captureSource(
      item,
      deps(() => fetched("Resend me.")),
      { reason: "live" },
    );
    if (out.status === "not-captured") throw new Error();
    const resent = await resendSource(
      item,
      { artifacts, publisher: publisher as never },
      { reason: "live" },
    );
    expect(resent).toMatchObject({ status: "resent", eventId: out.eventId });
    expect(delivered).toHaveLength(1);
    expect(
      await resendSource(
        { ...item, postId: "never-captured" },
        { artifacts, publisher: publisher as never },
        { reason: "live" },
      ),
    ).toEqual({
      status: "not-saved",
    });
  });

  it("captures nothing when the source has no text yet", async () => {
    const out = await captureSource(
      item,
      deps(() => ({ kind: "transient-failure", item, reason: "timeout" }) as CollectionResult),
      { reason: "live" },
    );
    expect(out).toEqual({ status: "not-captured", reason: "transient-failure" });
    expect(await artifacts.lookup(sourcePath(item))).toBeUndefined();
    expect(delivered).toHaveLength(0);
  });
});
