import { describe, expect, it } from "vite-plus/test";
import { createArticleApprovedEvent } from "../../src/events/article-approved-event.js";
import { createDiscoveryEvent } from "../../src/events/discovery-event.js";
import {
  capturedContentDataJsonSchema,
  createCapturedContentEvent,
  parseCapturedContentEvent,
  substackCapturedContent,
  type CapturedContentData,
} from "../../src/events/captured-content-event.js";

const artifact = {
  repository: "steele-archive",
  commit: "a".repeat(40),
  path: "substack/saveusnow/p/collected.json",
  hash: `sha256:${"b".repeat(64)}`,
};
const sourceVersion = `sha256:${"c".repeat(64)}`;

describe("captured-content contract (#269)", () => {
  it("maps an archived Substack post, including supplied transcript provenance", () => {
    const data = substackCapturedContent({
      artifact,
      sourceVersion,
      record: {
        item: {
          publicationId: "saveusnow",
          postId: "p",
          url: "https://saveusnow.substack.com/p/p",
          title: "T",
          publishedAt: "2026-01-05T08:27:15.103Z",
        },
        ingestionReason: "live",
        complete: true,
        provenance: { method: "supplied-transcript+article-html", transcriptVariant: "aligned" },
      },
    });
    expect(data).toMatchObject({
      source: { namespace: "substack/saveusnow", kind: "substack" },
      itemId: "p",
      originalUrl: "https://saveusnow.substack.com/p/p",
      transcript: { kind: "supplied", variant: "aligned" },
    });
    const article = substackCapturedContent({
      artifact,
      sourceVersion,
      record: {
        item: {
          publicationId: "saveusnow",
          postId: "q",
          url: "https://saveusnow.substack.com/p/q",
        },
        ingestionReason: "backfill",
        complete: true,
        provenance: { method: "article-html" },
      },
    });
    expect(article.transcript).toEqual({ kind: "none" });
    const machine = substackCapturedContent({
      artifact,
      sourceVersion,
      record: {
        item: {
          publicationId: "saveusnow",
          postId: "r",
          url: "https://saveusnow.substack.com/p/r",
        },
        ingestionReason: "live",
        complete: true,
        provenance: { method: "machine-transcript" },
      },
    });
    expect(machine.transcript).toEqual({ kind: "generated", engine: "machine-transcript" });
  });

  it("serves a second, non-Substack source with the same contract", () => {
    const blog: CapturedContentData = {
      source: { namespace: "blog/example-site", kind: "blog" },
      itemId: "2026-11-20-a-post",
      originalUrl: "https://example-site.test/2026/11/a-post",
      artifact: { ...artifact, path: "blog/example-site/2026-11-20-a-post/collected.json" },
      sourceVersion,
      complete: true,
      transcript: { kind: "generated", engine: "hosted-transcription" },
      ingestionReason: "live",
    };
    const event = createCapturedContentEvent(blog);
    const parsed = parseCapturedContentEvent(JSON.stringify(event.toJSON()));
    expect(parsed).toMatchObject({
      source: { namespace: "blog/example-site" },
      itemId: "2026-11-20-a-post",
      eventId: event.id,
    });
    expect(event.subject).toBe("blog/example-site/2026-11-20-a-post");
  });

  it("correlates discovery, revisions, and approval for the same original post", () => {
    const item = {
      publicationId: "synthetic-feed",
      postId: "fixture-post",
      title: "Fixture post",
      url: "https://example.test/p/fixture-post",
    };
    const discovery = createDiscoveryEvent(item, { reason: "live", correlationId: "poll-1" });
    const base = substackCapturedContent({
      artifact,
      sourceVersion,
      record: {
        item,
        ingestionReason: "live",
        complete: true,
        provenance: { method: "article-html" },
      },
    });
    const capture = createCapturedContentEvent(base);
    const next = createCapturedContentEvent({ ...base, sourceVersion: `sha256:${"d".repeat(64)}` });
    const approval = createArticleApprovedEvent(
      {
        publicationId: item.publicationId,
        postId: item.postId,
        draft: artifact,
        approval: artifact,
        package: artifact,
        approvedAt: "2026-01-05T08:27:15.103Z",
      },
      "approved-1",
    );
    expect(discovery.correlationid).toBe("poll-1");
    expect(discovery.postcorrelationid).toMatch(/^post-[0-9a-f]{64}$/);
    expect(capture.correlationid).toBe(discovery.postcorrelationid);
    expect(next.correlationid).toBe(discovery.postcorrelationid);
    expect(approval.correlationid).toBe(discovery.postcorrelationid);
    expect(
      createDiscoveryEvent({ ...item, postId: "other" }, { reason: "live" }).postcorrelationid,
    ).not.toBe(discovery.postcorrelationid);
  });

  it("gives one item revision a stable event ID, and a new revision a new one", () => {
    const base = substackCapturedContent({
      artifact,
      sourceVersion,
      record: {
        item: {
          publicationId: "saveusnow",
          postId: "p",
          url: "https://saveusnow.substack.com/p/p",
        },
        ingestionReason: "live",
        complete: true,
        provenance: { method: "article-html" },
      },
    });
    expect(createCapturedContentEvent(base).id).toBe(createCapturedContentEvent(base).id);
    expect(
      createCapturedContentEvent({
        ...base,
        artifact: { ...artifact, hash: `sha256:${"d".repeat(64)}` },
      }).id,
    ).not.toBe(createCapturedContentEvent(base).id);
  });

  it("rejects inconsistent or unsafe input", () => {
    const good = substackCapturedContent({
      artifact,
      sourceVersion,
      record: {
        item: {
          publicationId: "saveusnow",
          postId: "p",
          url: "https://saveusnow.substack.com/p/p",
        },
        ingestionReason: "live",
        complete: true,
        provenance: { method: "article-html" },
      },
    });
    expect(() =>
      createCapturedContentEvent({
        ...good,
        source: { namespace: "substack/saveusnow", kind: "blog" },
      }),
    ).toThrow();
    expect(() =>
      createCapturedContentEvent({ ...good, originalUrl: "http://insecure.test/x" }),
    ).toThrow();
    const event = createCapturedContentEvent(good).toJSON() as Record<string, unknown>;
    expect(() =>
      parseCapturedContentEvent(JSON.stringify({ ...event, subject: "substack/saveusnow/other" })),
    ).toThrow("subject");
    expect(capturedContentDataJsonSchema()).toMatchObject({ type: "object" });
  });
});
