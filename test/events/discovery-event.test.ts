import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_DISCOVERY_SOURCE,
  DISCOVERY_DATASCHEMA_V1,
  DISCOVERY_EVENT_TYPE_V1,
  InvalidDiscoveryEventError,
  createDiscoveryEvent,
  discoveryEventDataJsonSchema,
  discoveryEventFieldDictionary,
  parseDiscoveryEvent,
  serializeDiscoveryEvent,
} from "../../src/events/discovery-event.js";
import type { SubstackItem } from "../../src/content/substack-item.js";

// Synthetic values only.
const item: SubstackItem = {
  publicationId: "example-pub",
  postId: "a-synthetic-post",
  url: "https://example-pub.substack.com/p/a-synthetic-post",
  title: "A synthetic post",
  publishedAt: "2026-01-02T03:04:05Z",
};

const fixedDeps = (id = "00000000-0000-4000-8000-000000000001") => ({
  newId: () => id,
  now: () => new Date("2026-02-01T00:00:00.000Z"),
});

describe("createDiscoveryEvent", () => {
  it("builds a valid CloudEvents 1.0 event with deterministic id and time", () => {
    const event = createDiscoveryEvent(
      item,
      { reason: "live", correlationId: "run-1", causationId: "tick-1" },
      fixedDeps(),
    );
    expect(event.specversion).toBe("1.0");
    expect(event.id).toBe("00000000-0000-4000-8000-000000000001");
    expect(event.time).toBe("2026-02-01T00:00:00.000Z");
    expect(event.type).toBe(DISCOVERY_EVENT_TYPE_V1);
    expect(event.dataschema).toBe(DISCOVERY_DATASCHEMA_V1);
    expect(event.source).toBe(DEFAULT_DISCOVERY_SOURCE);
    expect(event.subject).toBe("substack/example-pub/a-synthetic-post");
    expect(event.datacontenttype).toBe("application/json");
    expect(event.correlationid).toBe("run-1");
    expect(event.causationid).toBe("tick-1");
    expect(event.data).toEqual({ ...item, ingestionReason: "live" });
    expect(event.validate()).toBe(true);
  });

  it.each(["live", "backfill", "reprocess"] as const)("supports reason %s", (reason) => {
    expect(createDiscoveryEvent(item, { reason }, fixedDeps()).data?.ingestionReason).toBe(reason);
  });

  it("uses a random UUID by default", () => {
    const a = createDiscoveryEvent(item, { reason: "live" });
    const b = createDiscoveryEvent(item, { reason: "live" });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
  });

  it("keeps content identity equal across live and backfill events", () => {
    const live = createDiscoveryEvent(item, { reason: "live" }, fixedDeps("id-live"));
    const backfill = createDiscoveryEvent(item, { reason: "backfill" }, fixedDeps("id-back"));
    expect(live.id).not.toBe(backfill.id);
    expect(live.subject).toBe(backfill.subject);
    expect(live.data?.postId).toBe(backfill.data?.postId);
    expect(live.data?.publicationId).toBe(backfill.data?.publicationId);
  });

  it("rejects invalid items, reasons, extensions and sources", () => {
    expect(() =>
      createDiscoveryEvent({ ...item, url: "http://x.test/p/a" }, { reason: "live" }, fixedDeps()),
    ).toThrow();
    expect(() => createDiscoveryEvent(item, { reason: "manual" as never }, fixedDeps())).toThrow();
    expect(() =>
      createDiscoveryEvent(item, { reason: "live", correlationId: "has space" }, fixedDeps()),
    ).toThrow();
    expect(() =>
      createDiscoveryEvent(item, { reason: "live", source: "not a uri" }, fixedDeps()),
    ).toThrow();
  });
});

describe("serialise and parse", () => {
  it("round-trips through structured JSON unchanged, so retries can resend it", () => {
    const event = createDiscoveryEvent(
      item,
      { reason: "backfill", correlationId: "run-2" },
      fixedDeps(),
    );
    const wire = serializeDiscoveryEvent(event);
    const decoded = parseDiscoveryEvent(wire);
    expect(decoded.toJSON()).toEqual(event.toJSON());
    expect(serializeDiscoveryEvent(decoded)).toBe(wire);
  });

  const base = () =>
    JSON.parse(
      serializeDiscoveryEvent(createDiscoveryEvent(item, { reason: "live" }, fixedDeps())),
    ) as Record<string, unknown>;

  it.each([
    ["malformed JSON", "{not json"],
    ["array", "[]"],
    ["wrong specversion", { ...base(), specversion: "0.3" }],
    ["unsupported type", { ...base(), type: "org.steele.source.detected.v2" }],
    ["unsupported dataschema", { ...base(), dataschema: "urn:other" }],
    ["wrong content type", { ...base(), datacontenttype: "text/plain" }],
    ["missing id", { ...base(), id: undefined }],
    ["missing time", { ...base(), time: undefined }],
    ["invalid payload", { ...base(), data: { ...item } }],
    ["unknown payload field", { ...base(), data: { ...item, ingestionReason: "live", body: "x" } }],
    ["mismatched subject", { ...base(), subject: "substack/other/post" }],
    ["bad extension", { ...base(), correlationid: "has space" }],
  ])("rejects %s without echoing the payload", (_name, input) => {
    try {
      parseDiscoveryEvent(input as string | Record<string, unknown>);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidDiscoveryEventError);
      expect((error as Error).message).not.toContain("synthetic");
    }
  });
});

describe("schema export", () => {
  it("exports JSON Schema and a field dictionary from the same definition", () => {
    const schema = discoveryEventDataJsonSchema() as { required: string[] };
    expect(schema.required).toContain("ingestionReason");
    const dictionary = discoveryEventFieldDictionary();
    expect(dictionary.map((f) => f.field).sort()).toEqual(
      [
        "ingestionReason",
        "postId",
        "publicationId",
        "publishedAt",
        "title",
        "updatedAt",
        "url",
      ].sort(),
    );
    for (const entry of dictionary) expect(entry.description, entry.field).toBeTruthy();
    expect(dictionary.find((f) => f.field === "publishedAt")?.required).toBe(false);
  });
});
