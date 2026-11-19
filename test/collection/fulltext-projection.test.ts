import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { CollectionRecord } from "../../src/collection/collection-store.js";
import {
  acquisitionOriginFor,
  projectCollectionArtifact,
} from "../../src/collection/fulltext-projection.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { FulltextDocumentSchema } from "../../src/content/fulltext-document.js";

const item = {
  publicationId: "example-pub",
  postId: "a-post",
  url: "https://example-pub.substack.com/p/a-post",
  title: "A synthetic post",
  publishedAt: "2026-01-02T03:04:05Z",
};
const record = (extra: Partial<CollectionRecord> = {}): CollectionRecord => ({
  item,
  ingestionReason: "backfill",
  text: "Synthetic transcript text.",
  complete: true,
  supplied: { transcript: [{ start: 0, end: 2, text: "Synthetic transcript text." }] },
  provenance: {
    sourceUrl: item.url,
    acquiredAt: "2026-02-01T00:00:00.000Z",
    method: "supplied-transcript",
  },
  ...extra,
});
const now = () => new Date("2026-03-01T00:00:00.000Z");
const expected = { publicationId: "example-pub", postId: "a-post" };

let dir: string;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-projection-"));
  await mkdir(join(dir, "archive"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "archive"), repository: "test-archive" });
  await artifacts.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function commit(r: unknown, path = "substack/example-pub/a-post/collected.json") {
  const ref = await artifacts.write(path, `${JSON.stringify(r, null, 2)}\n`);
  return {
    repository: ref.repository,
    commit: ref.commit,
    path: ref.path,
    hash: `sha256:${ref.sha256}`,
  };
}

describe("projectCollectionArtifact", () => {
  it("projects a supplied transcript with dates, provenance and a deterministic ID", async () => {
    const reference = await commit(record());
    const outcome = await projectCollectionArtifact({ artifacts, reference, expected, now });
    expect(outcome.kind).toBe("projected");
    if (outcome.kind !== "projected") return;
    expect(outcome.id).toBe("substack:example-pub:a-post");
    expect(FulltextDocumentSchema.parse(outcome.document)).toMatchObject({
      text: "Synthetic transcript text.",
      acquisitionOrigin: "transcript",
      publishedAt: "2026-01-02T03:04:05Z",
      sourceRetrievedAt: "2026-02-01T00:00:00.000Z",
      artifact: reference,
      indexedAt: "2026-03-01T00:00:00.000Z",
    });
  });

  it("projects article text as an archive fetch", async () => {
    const reference = await commit(
      record({
        text: "Article body.",
        supplied: { articleHtml: "<p>Article body.</p>" },
        provenance: {
          sourceUrl: item.url,
          acquiredAt: "2026-02-01T00:00:00.000Z",
          method: "article-html",
        },
      }),
    );
    const outcome = await projectCollectionArtifact({ artifacts, reference, expected, now });
    expect(outcome.kind === "projected" && outcome.document.acquisitionOrigin).toBe(
      "archive-fetch",
    );
  });

  it("leaves missing dates missing", async () => {
    const { publishedAt, ...undated } = item;
    void publishedAt;
    const reference = await commit(record({ item: undated }));
    const outcome = await projectCollectionArtifact({ artifacts, reference, expected, now });
    expect(outcome.kind).toBe("projected");
    if (outcome.kind === "projected") {
      expect(outcome.document).not.toHaveProperty("publishedAt");
      expect(outcome.document).not.toHaveProperty("updatedAt");
    }
  });

  it("reports incomplete content without projecting it", async () => {
    const reference = await commit(record({ complete: false }));
    expect(await projectCollectionArtifact({ artifacts, reference, expected, now })).toMatchObject({
      kind: "incomplete",
    });
  });

  it.each([["malformed reference", { repository: "x" }, "bad-reference"]])(
    "rejects a %s",
    async (_name, reference, reason) => {
      expect(await projectCollectionArtifact({ artifacts, reference, expected, now })).toEqual({
        kind: "invalid",
        reason,
      });
    },
  );

  it("detects a bad hash and a missing artifact", async () => {
    const reference = await commit(record());
    expect(
      await projectCollectionArtifact({
        artifacts,
        reference: { ...reference, hash: `sha256:${"0".repeat(64)}` },
        expected,
        now,
      }),
    ).toEqual({ kind: "invalid", reason: "hash-mismatch" });
    expect(
      await projectCollectionArtifact({
        artifacts,
        reference: { ...reference, path: "substack/example-pub/other/collected.json" },
        expected,
        now,
      }),
    ).toEqual({ kind: "missing" });
  });

  it("rejects identity mismatches, malformed records and unknown methods", async () => {
    const reference = await commit(record());
    expect(
      await projectCollectionArtifact({
        artifacts,
        reference,
        expected: { ...expected, postId: "other" },
        now,
      }),
    ).toEqual({ kind: "invalid", reason: "identity-mismatch" });
    const malformed = await commit({ not: "a record" }, "substack/example-pub/bad/collected.json");
    expect(
      await projectCollectionArtifact({ artifacts, reference: malformed, expected, now }),
    ).toEqual({
      kind: "invalid",
      reason: "malformed-record",
    });
    const unknown = await commit(
      record({
        provenance: {
          sourceUrl: item.url,
          acquiredAt: "2026-02-01T00:00:00.000Z",
          method: "telepathy",
        },
      }),
      "substack/example-pub/unknown/collected.json",
    );
    expect(
      await projectCollectionArtifact({ artifacts, reference: unknown, expected, now }),
    ).toEqual({
      kind: "invalid",
      reason: "unknown-acquisition-method",
    });
  });

  it("maps every collector method explicitly", () => {
    expect(acquisitionOriginFor("supplied-transcript+article-html")).toBe("transcript");
    expect(acquisitionOriginFor("machine-transcript")).toBe("transcript");
    expect(acquisitionOriginFor("reconciled")).toBeUndefined();
  });
});
