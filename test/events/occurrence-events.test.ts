import { describe, expect, it } from "vite-plus/test";
import {
  CLAIM_OCCURRED_SUBJECT,
  claimOccurredDataJsonSchema,
  createClaimOccurredEvent,
  parseClaimOccurredEvent,
} from "../../src/events/claim-occurred-event.js";
import {
  THEME_OCCURRED_SUBJECT,
  createThemeOccurredEvent,
  parseThemeOccurredEvent,
  themeOccurredDataJsonSchema,
} from "../../src/events/theme-occurred-event.js";

const reference = (path: string) => ({
  repository: "test-archive",
  commit: "a".repeat(40),
  path,
  hash: `sha256:${"b".repeat(64)}`,
});
const base = {
  publicationId: "example-pub",
  postId: "a-post",
  sourceVersion: `sha256:${"c".repeat(64)}`,
  sourceArtifact: reference("substack/example-pub/a-post/collected.json"),
  themeResult: reference("theme-proposals/example-pub/a-post/one.json"),
  claimResult: reference("claim-extractions/example-pub/a-post/one.json"),
};
const themeData = {
  ...base,
  occurrenceId: "theme-occ-1",
  theme: { id: `theme-${"1".repeat(24)}`, title: "Geoengineering" },
};
const claimData = {
  ...base,
  occurrenceId: "occ-1",
  claimId: `claim-${"2".repeat(32)}`,
  kind: "assertion" as const,
  themeIds: [`theme-${"1".repeat(24)}`],
};
const valid = (data: object, id = "event-1") =>
  JSON.parse(
    JSON.stringify(
      createThemeOccurredEvent(data as never, { id, now: () => new Date(0) }).toJSON(),
    ),
  );

describe("theme occurrence event", () => {
  it("round-trips and uses the analysis occurrence subject", () => {
    const event = createThemeOccurredEvent(themeData, { id: "e1", now: () => new Date(0) });
    expect(event.subject).toBe("substack/example-pub/a-post");
    expect(THEME_OCCURRED_SUBJECT).toBe("steele.v1.theme.occurred");
    expect(parseThemeOccurredEvent(JSON.stringify(event.toJSON()))).toEqual(themeData);
  });

  it.each([
    ["missing source", (e: Record<string, unknown>) => ({ ...e, source: undefined })],
    ["bad time", (e: Record<string, unknown>) => ({ ...e, time: "yesterday" })],
    [
      "wrong content type",
      (e: Record<string, unknown>) => ({ ...e, datacontenttype: "text/plain" }),
    ],
    ["mismatched subject", (e: Record<string, unknown>) => ({ ...e, subject: "substack/x/y" })],
    [
      "missing occurrence identity",
      (e: Record<string, unknown>) => ({ ...e, data: { ...themeData, occurrenceId: "" } }),
    ],
  ])("rejects %s", (_name, mutate) => {
    expect(() => parseThemeOccurredEvent(JSON.stringify(mutate(valid(themeData))))).toThrow();
  });

  it("exports a portable JSON Schema", () => {
    expect(JSON.stringify(themeOccurredDataJsonSchema())).toContain("occurrenceId");
  });
});

describe("claim occurrence event", () => {
  it("round-trips and keeps the stable claim identity optional", () => {
    const event = createClaimOccurredEvent(claimData, { id: "e2", now: () => new Date(0) });
    expect(CLAIM_OCCURRED_SUBJECT).toBe("steele.v1.claim.occurred");
    expect(parseClaimOccurredEvent(JSON.stringify(event.toJSON()))).toEqual(claimData);

    const question = { ...claimData, occurrenceId: "occ-2", kind: "question" as const };
    delete (question as { claimId?: string }).claimId;
    expect(
      parseClaimOccurredEvent(
        JSON.stringify(createClaimOccurredEvent(question, { id: "e3", now: () => new Date(0) }).toJSON()),
      ),
    ).toEqual(question);
  });

  it.each([
    ["missing source", (e: Record<string, unknown>) => ({ ...e, source: undefined })],
    ["bad time", (e: Record<string, unknown>) => ({ ...e, time: "yesterday" })],
    ["wrong type", (e: Record<string, unknown>) => ({ ...e, type: "org.steele.other.v1" })],
    [
      "invalid kind",
      (e: Record<string, unknown>) => ({ ...e, data: { ...claimData, kind: "rumour" } }),
    ],
    [
      "malformed claim identity",
      (e: Record<string, unknown>) => ({ ...e, data: { ...claimData, claimId: "claim-oops" } }),
    ],
  ])("rejects %s", (_name, mutate) => {
    const payload = JSON.parse(
      JSON.stringify(
        createClaimOccurredEvent(claimData, { id: "e2", now: () => new Date(0) }).toJSON(),
      ),
    );
    expect(() => parseClaimOccurredEvent(JSON.stringify(mutate(payload)))).toThrow();
  });

  it("exports a portable JSON Schema", () => {
    expect(JSON.stringify(claimOccurredDataJsonSchema())).toContain("occurrenceId");
  });
});
