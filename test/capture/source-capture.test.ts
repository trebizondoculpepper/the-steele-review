import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  captureSource,
  dispatchPendingSources,
  resendSource,
  sourcePath,
} from "../../src/capture/source-capture.js";
import { CollectionRecordSchema } from "../../src/collection/collection-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { handleCapturedContent } from "../../src/workflow/captured-bridge.js";
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
let delivered: { id: string; path: string; hash: string; payload: string }[];
let publishFailures: number;
let operations: OperationStore;
const publisher = {
  async publish(
    _subject: string,
    payload: Uint8Array,
    { msgId }: { msgId: string },
  ) {
    if (publishFailures > 0) {
      publishFailures--;
      throw new Error("synthetic broker outage");
    }
    const text = new TextDecoder().decode(payload);
    const artifact = JSON.parse(text).data.artifact as {
      path: string;
      hash: string;
    };
    if (!delivered.some((d) => d.id === msgId))
      delivered.push({
        id: msgId,
        path: artifact.path,
        hash: artifact.hash,
        payload: text,
      });
  },
};
const commitsTouching = (path: string) =>
  Number(
    execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD", "--", path])
      .toString()
      .trim(),
  );

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "source-capture-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "archive" });
  await artifacts.initialise();
  delivered = [];
  publishFailures = 0;
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});
const deps = (result: () => CollectionResult, images = true) => ({
  collector: { collect: async () => result() },
  artifacts,
  operations,
  publisher,
  retryDelayMs: 0,
  ...(images
    ? {
        images: {
          fetch: async () => ({
            bytes: PNG,
            contentType: "image/png" as const,
          }),
        },
      }
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
    expect(saved.previewImage.retained.artifact.path).toMatch(
      /^substack\/example-pub\/a-post\/images\//,
    );
    // Only how the text was obtained; no collector details or retry state.
    expect(Object.keys(saved.provenance).sort()).toEqual([
      "acquiredAt",
      "method",
      "sourceUrl",
    ]);
    expect(saved.reingestion).toBeUndefined();
    expect(delivered.map(({ id, path, hash }) => ({ id, path, hash }))).toEqual(
      [
        {
          id: out.eventId,
          path: out.ref.path,
          hash: `sha256:${out.ref.sha256}`,
        },
      ],
    );
  });

  it("makes no content change for a refetch, retry or later capture time", async () => {
    const first = await captureSource(
      item,
      deps(() => fetched("Same text.")),
      { reason: "live" },
    );
    const again = await captureSource(
      item,
      deps(() =>
        fetched("Same text.", { acquiredAt: "2026-12-01T00:00:00.000Z" }),
      ),
      { reason: "backfill" },
    );
    if (first.status === "not-captured" || again.status === "not-captured")
      throw new Error();
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
    if (first.status === "not-captured" || edited.status === "not-captured")
      throw new Error();
    expect(edited.status).toBe("saved");
    expect(edited.ref.path).toBe(first.ref.path);
    expect(edited.ref.sha256).not.toBe(first.ref.sha256);
    expect(commitsTouching(sourcePath(item))).toBe(2);
    // Both versions stay readable by their pinned references.
    expect(JSON.parse(await artifacts.read(first.ref)).text).toBe(
      "Before the edit.",
    );
    expect(JSON.parse(await artifacts.read(edited.ref)).text).toBe(
      "After the edit.",
    );
    expect(delivered.map((d) => d.id)).toEqual([first.eventId, edited.eventId]);
  });

  it("announces a saved version whose announcement was lost to a crash before replacing it (#902)", async () => {
    // Crash after the save, before the announcement is recorded.
    const crashing = {
      ...deps(() => fetched("Before the edit.")),
      operations: Object.assign(Object.create(operations), {
        reconcileCompleted: () => {
          throw new Error("synthetic crash");
        },
      }),
    };
    await expect(
      captureSource(item, crashing as never, { reason: "live" }),
    ).rejects.toThrow("synthetic crash");
    expect(delivered).toHaveLength(0);
    const saved = (await artifacts.lookup(sourcePath(item)))!;
    // The retry finds changed content: the earlier saved version is announced too.
    const edited = await captureSource(
      item,
      deps(() => fetched("After the edit.")),
      {
        reason: "live",
      },
    );
    if (edited.status === "not-captured") throw new Error();
    expect(delivered.map((d) => d.hash)).toEqual([
      `sha256:${saved.sha256}`,
      `sha256:${edited.ref.sha256}`,
    ]);
    // Already-announced versions are not announced twice.
    const again = await captureSource(
      item,
      deps(() => fetched("Third version.")),
      {
        reason: "live",
      },
    );
    if (again.status === "not-captured") throw new Error();
    expect(delivered).toHaveLength(3);
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
      {
        ...deps(() => ({
          ...fetched("No image.", { preview: false }),
          item: other,
        })),
      },
      { reason: "live" },
    );
    if (none.status === "not-captured") throw new Error(none.reason);
    expect(none.preview).toBe("no-preview");
  });

  it("keeps a failed announcement pending and sends it before a later capture", async () => {
    publishFailures = 1;
    const first = await captureSource(
      item,
      deps(() => fetched("Saved, then the broker failed.")),
      {
        reason: "live",
      },
    );
    if (first.status === "not-captured") throw new Error(first.reason);
    expect(first).toMatchObject({ status: "saved", announced: false });
    expect(delivered).toHaveLength(0);

    // The source changes before the retry. The earlier version's announcement
    // still goes out first, then the new version's: no downstream work is lost.
    const second = await captureSource(
      item,
      deps(() => fetched("Edited after the outage.")),
      {
        reason: "live",
      },
    );
    if (second.status === "not-captured") throw new Error(second.reason);
    expect(second).toMatchObject({ status: "saved", announced: true });
    expect(delivered.map((d) => d.id)).toEqual([first.eventId, second.eventId]);
    expect(delivered[0]!.hash).toBe(`sha256:${first.ref.sha256}`);
    // Both versions stay readable by the references their events carry.
    expect(JSON.parse(await artifacts.read(first.ref)).text).toBe(
      "Saved, then the broker failed.",
    );
  });

  it("sends pending announcements on their own, without fetching", async () => {
    publishFailures = 1;
    const out = await captureSource(
      item,
      deps(() => fetched("Pending.")),
      { reason: "live" },
    );
    if (out.status === "not-captured") throw new Error();
    expect(
      await dispatchPendingSources({ operations, publisher }, item),
    ).toEqual({
      sent: [out.eventId],
      failed: [],
    });
    expect(
      await dispatchPendingSources({ operations, publisher }, item),
    ).toEqual({
      sent: [],
      failed: [],
    });
    expect(delivered).toHaveLength(1);
  });

  it("saves a record the existing capture consumers read, through to the article run", async () => {
    const out = await captureSource(
      item,
      deps(() => fetched("Readable downstream.")),
      {
        reason: "live",
      },
    );
    if (out.status === "not-captured") throw new Error();
    // The saved file is a valid capture record.
    const saved = CollectionRecordSchema.parse(
      JSON.parse(await artifacts.read(out.ref)),
    );
    expect(saved).toMatchObject({
      text: "Readable downstream.",
      ingestionReason: "live",
    });
    // The bridge admits the announced source, and the workflow input points at it.
    const submitted: {
      key: string;
      source: {
        artifact: {
          repository: string;
          commit: string;
          path: string;
          sha256: string;
        };
      };
    }[] = [];
    const decision = await handleCapturedContent(delivered[0]!.payload, {
      enabledSources: new Set(["substack/example-pub"]),
      researchDeadlineMs: 60_000,
      submit: async (key, input) => {
        submitted.push({ key, source: input.source as never });
        return "started";
      },
    });
    expect(decision).toMatchObject({ action: "ack", outcome: "started" });
    expect(submitted[0]!.source.artifact).toMatchObject({
      path: out.ref.path,
      sha256: out.ref.sha256,
      commit: out.ref.commit,
    });
    // What the workflow reads back through that reference parses as a capture.
    const read = await artifacts.read(submitted[0]!.source.artifact);
    expect(CollectionRecordSchema.safeParse(JSON.parse(read)).success).toBe(
      true,
    );
  });

  it("resends the saved references with the same event identity, without fetching", async () => {
    const out = await captureSource(
      item,
      deps(() => fetched("Resend me.")),
      { reason: "live" },
    );
    if (out.status === "not-captured") throw new Error();
    const resent = await resendSource(item, { artifacts, publisher });
    expect(resent).toMatchObject({ status: "resent", eventId: out.eventId });
    expect(delivered).toHaveLength(1);
    expect(
      await resendSource(
        { ...item, postId: "never-captured" },
        { artifacts, publisher },
      ),
    ).toEqual({ status: "not-saved" });
  });

  it("captures nothing when the source has no text yet", async () => {
    const out = await captureSource(
      item,
      deps(
        () =>
          ({
            kind: "transient-failure",
            item,
            reason: "timeout",
          }) as CollectionResult,
      ),
      { reason: "live" },
    );
    expect(out).toEqual({
      status: "not-captured",
      reason: "transient-failure",
    });
    expect(await artifacts.lookup(sourcePath(item))).toBeUndefined();
    expect(delivered).toHaveLength(0);
  });
});
