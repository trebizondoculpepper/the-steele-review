import { describe, expect, it } from "vite-plus/test";
import {
  InvalidTextReadyEventError,
  createTextReadyEvent,
  parseTextReadyEvent,
} from "../../src/events/text-ready-event.js";

const data = {
  publicationId: "example-pub",
  postId: "a-post",
  url: "https://example-pub.substack.com/p/a-post",
  ingestionReason: "backfill" as const,
  artifact: {
    repository: "test-archive",
    commit: "a".repeat(40),
    path: "substack/example-pub/a-post/collected.json",
    hash: `sha256:${"b".repeat(64)}`,
  },
  acquisitionMethod: "supplied-transcript",
  complete: true,
};
const valid = () =>
  JSON.parse(JSON.stringify(createTextReadyEvent(data, { causationId: "evt-1" }).toJSON()));

describe("parseTextReadyEvent", () => {
  it("round-trips a valid event", () => {
    const event = parseTextReadyEvent(JSON.stringify(valid()));
    expect(event.data).toEqual(data);
    expect(event.causationid).toBe("evt-1");
  });

  it.each([
    ["missing subject", (e: Record<string, unknown>) => ({ ...e, subject: undefined })],
    [
      "mismatched subject",
      (e: Record<string, unknown>) => ({ ...e, subject: "substack/other/post" }),
    ],
    ["wrong specversion", (e: Record<string, unknown>) => ({ ...e, specversion: "0.3" })],
    [
      "wrong content type",
      (e: Record<string, unknown>) => ({ ...e, datacontenttype: "text/plain" }),
    ],
    ["bad time", (e: Record<string, unknown>) => ({ ...e, time: "yesterday" })],
    ["missing source", (e: Record<string, unknown>) => ({ ...e, source: undefined })],
    ["wrong type", (e: Record<string, unknown>) => ({ ...e, type: "org.steele.other.v1" })],
    [
      "invalid payload",
      (e: Record<string, unknown>) => ({ ...e, data: { ...data, url: "http://x.test" } }),
    ],
  ])("rejects %s", (_name, mutate) => {
    expect(() => parseTextReadyEvent(JSON.stringify(mutate(valid())))).toThrow(
      InvalidTextReadyEventError,
    );
  });

  it("rejects malformed JSON without echoing it", () => {
    expect(() => parseTextReadyEvent("{secret")).toThrow(/not valid JSON/);
  });
});
