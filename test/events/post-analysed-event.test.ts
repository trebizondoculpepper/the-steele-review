import { describe, expect, it } from "vite-plus/test";
import {
  POST_ANALYSED_SUBJECT,
  createPostAnalysedEvent,
  parsePostAnalysedEvent,
  postAnalysedDataJsonSchema,
} from "../../src/events/post-analysed-event.js";

const artifact = (path: string) => ({
  repository: "test-archive",
  commit: "a".repeat(40),
  path,
  hash: `sha256:${"b".repeat(64)}`,
});
const data = {
  publicationId: "example-pub",
  postId: "a-post",
  sourceVersion: `sha256:${"c".repeat(64)}`,
  sourceArtifact: artifact("substack/example-pub/a-post/collected.json"),
  themeResult: artifact("theme-proposals/example-pub/a-post/one.json"),
  claimResult: artifact("claim-extractions/example-pub/a-post/one.json"),
  themes: { model: "m", prompt: "theme-proposals-v2", schema: 1 },
  claims: { model: "m", prompt: "claims-v2", schema: 2 },
  counts: { themeProposals: 1, acceptedClaims: 1, candidates: 0, rejected: 0 },
};
const valid = () =>
  JSON.parse(
    JSON.stringify(createPostAnalysedEvent(data, { id: "e1", now: () => new Date(0) }).toJSON()),
  );

describe("parsePostAnalysedEvent", () => {
  it("round-trips a valid event", () => {
    const event = parsePostAnalysedEvent(JSON.stringify(valid()));
    expect(event).toEqual(data);
  });

  it("uses the analysis subject", () => {
    expect(POST_ANALYSED_SUBJECT).toBe("steele.v1.post.analysed");
  });

  it.each([
    ["missing subject", (e: Record<string, unknown>) => ({ ...e, subject: undefined })],
    [
      "mismatched subject",
      (e: Record<string, unknown>) => ({ ...e, subject: "substack/other/post" }),
    ],
    ["wrong specversion", (e: Record<string, unknown>) => ({ ...e, specversion: "0.3" })],
    ["missing source", (e: Record<string, unknown>) => ({ ...e, source: undefined })],
    [
      "wrong content type",
      (e: Record<string, unknown>) => ({ ...e, datacontenttype: "text/plain" }),
    ],
    ["bad time", (e: Record<string, unknown>) => ({ ...e, time: "yesterday" })],
    ["missing time", (e: Record<string, unknown>) => ({ ...e, time: undefined })],
    ["wrong type", (e: Record<string, unknown>) => ({ ...e, type: "org.steele.other.v1" })],
    [
      "invalid payload",
      (e: Record<string, unknown>) => ({ ...e, data: { ...data, sourceVersion: "nope" } }),
    ],
  ])("rejects %s", (_name, mutate) => {
    expect(() => parsePostAnalysedEvent(JSON.stringify(mutate(valid())))).toThrow();
  });

  it("rejects malformed JSON without echoing it", () => {
    expect(() => parsePostAnalysedEvent("{secret")).toThrow();
  });

  it("exports a portable JSON Schema for the payload", () => {
    const schema = postAnalysedDataJsonSchema();
    expect(schema).toMatchObject({ type: "object" });
    expect(JSON.stringify(schema)).toContain("sourceVersion");
  });
});
