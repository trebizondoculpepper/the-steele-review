import { describe, expect, it } from "vite-plus/test";
import {
  sourceContextFor,
  sourceContextVersion,
  temporalContext,
} from "../../src/content/source-context.js";
import type { CollectionRecord } from "../../src/collection/collection-store.js";
const archive = {
  repository: "archive",
  commit: "a".repeat(40),
  path: "substack/synthetic/post/collected.json",
  sha256: "b".repeat(64),
};
const capture = (extra: Partial<CollectionRecord> = {}): CollectionRecord => ({
  item: {
    publicationId: "synthetic",
    postId: "post",
    url: "https://synthetic.example/p/post",
    title: "Source title",
    publishedAt: "2026-01-02T12:00:00Z",
  },
  ingestionReason: "backfill",
  text: "The source text",
  complete: true,
  supplied: { articleHtml: "<p>The source text</p>" },
  provenance: {
    sourceUrl: "https://synthetic.example/p/post",
    acquiredAt: "2026-02-03T10:00:00Z",
    method: "article-html",
    originalMedium: "written",
  },
  ...extra,
});
describe("pinned source provenance", () => {
  it.each([
    ["written", { articleHtml: "<p>text</p>" }, "article-text"],
    ["image", { articleHtml: "<p>caption</p>" }, "article-text"],
    ["video", { transcript: [{ start: 1, end: 2, text: "text" }] }, "transcript"],
    ["audio", { transcriptDocument: "text" }, "transcript"],
    [
      "video",
      { articleHtml: "<p>intro</p>", transcript: [{ text: "spoken" }] },
      "article-and-transcript",
    ],
  ] as const)(
    "separates %s original medium from %s representation",
    (medium, supplied, representation) => {
      const record = capture({
        supplied: structuredClone(supplied),
        provenance: {
          sourceUrl: "https://synthetic.example/p/post",
          acquiredAt: "2026-02-03T10:00:00Z",
          method:
            "transcript" in supplied || "transcriptDocument" in supplied
              ? "supplied-transcript"
              : "article-html",
          originalMedium: medium,
        },
      });
      const context = sourceContextFor(record, archive);
      expect(context.originalMedium).toBe(medium);
      expect(context.representation).toBe(representation);
      expect(context.inspected).toEqual({
        suppliedText: true,
        video: false,
        audio: false,
        images: false,
      });
    },
  );
  it("keeps legacy podcast medium unknown even with an audio transcription input", () => {
    const record = capture({
      supplied: { transcript: [{ text: "Spoken text" }] },
      provenance: {
        sourceUrl: "https://synthetic.example/p/post",
        acquiredAt: "2026-02-03T10:00:00Z",
        method: "supplied-transcript",
        postType: "podcast",
        mediaKind: "audio",
      },
    });
    expect(sourceContextFor(record, archive)).toMatchObject({
      originalMedium: "unknown",
      mediumBasis: "legacy-unknown",
      representation: "transcript",
    });
  });
  it("preserves observed offset/precision, date-only values, and distinct capture time", () => {
    const record = capture({
      provenance: {
        sourceUrl: "https://synthetic.example/p/post",
        acquiredAt: "2026-02-03T10:00:00Z",
        method: "article-html",
        observedPublishedAt: "2026-01-02T10:15:30.123456+02:00",
        observedUpdatedAt: "2026-01-03",
      },
    });
    const context = sourceContextFor(record, archive);
    expect(context.publishedAt).toEqual({
      kind: "timestamp",
      basis: "source-observed",
      original: "2026-01-02T10:15:30.123456+02:00",
      utc: "2026-01-02T08:15:30.123456Z",
      precision: "fractional-second",
      fractionDigits: 6,
      offset: "+02:00",
    });
    expect(context.sourceUpdatedAt).toEqual({
      kind: "date",
      basis: "source-observed",
      original: "2026-01-03",
      precision: "day",
    });
    expect(context.capturedAt).toMatchObject({
      kind: "timestamp",
      basis: "capture-clock",
      original: "2026-02-03T10:00:00Z",
    });
    expect(temporalContext(undefined)).toEqual({ kind: "unknown", reason: "not-supplied" });
    expect(temporalContext("not a date")).toEqual({
      kind: "unknown",
      reason: "invalid-observation",
    });
  });
  it.each([
    ["supplied-transcript", undefined, "source-supplied"],
    ["supplied-transcript", true, "source-supplied"],
    ["supplied-transcript+article-html", true, "source-supplied"],
    ["machine-transcript", true, "application-generated"],
    ["legacy-transcript", undefined, "unknown"],
    ["legacy-transcript", true, "unknown"],
  ] as const)("preserves transcript origin for %s", (method, machineGenerated, origin) => {
    const record = capture({
      supplied: { transcript: [{ text: "Spoken source", start: 1, end: 2 }] },
      provenance: {
        sourceUrl: "https://synthetic.example/p/post",
        acquiredAt: "2026-02-03T10:00:00Z",
        method,
        ...(machineGenerated === undefined ? {} : { machineGenerated }),
      },
    });
    expect(sourceContextFor(record, archive).transcript).toMatchObject({
      origin,
      segments: [{ index: 0, start: 1, end: 2 }],
    });
  });
  it("preserves a known observed byline without pretending a registry was loaded", () => {
    const record = capture();
    record.item.author = "Observed Author";
    expect(sourceContextFor(record, archive).author).toEqual({
      status: "resolved",
      author: "Observed Author",
      basis: "post-byline",
    });
    record.item.author = "One and Two";
    expect(sourceContextFor(record, archive).author).toMatchObject({
      status: "unknown",
      reason: "ambiguous-byline",
      observedByline: "One and Two",
    });
  });
  it("keeps unknown publication time unknown and authorship separate from medium", () => {
    const record = capture();
    delete record.item.publishedAt;
    const context = sourceContextFor(record, archive, {
      status: "resolved",
      author: "Synthetic Author",
      basis: "source-configured",
      sourceMetadataVersion: "source-metadata-sha256:synthetic",
    });
    expect(context.publishedAt).toEqual({ kind: "unknown", reason: "not-supplied" });
    expect(context.author).toMatchObject({
      status: "resolved",
      author: "Synthetic Author",
      basis: "source-configured",
    });
    expect(record.item.author).toBeUndefined();
    expect(sourceContextVersion(context)).not.toBe(
      sourceContextVersion({ ...context, originalMedium: "video" }),
    );
  });
});
