import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ARTICLE_APPROVED_EVENT_TYPE_V1,
  ARTICLE_APPROVED_SUBJECT,
  ARTICLE_DRAFT_AUTHORIZED_EVENT_TYPE_V2,
  ARTICLE_DRAFT_AUTHORIZED_DATASCHEMA_V2,
  articleApprovedDataJsonSchema,
  ArticleApprovedDataSchema,
  createArticleApprovedEvent,
  parseArticleApprovedEvent,
} from "../../src/events/article-approved-event.js";
import { MESSAGES } from "../../src/events/registry.js";

const ref = (path: string) => ({
  repository: "content",
  commit: "a".repeat(40),
  path,
  hash: `sha256:${"b".repeat(64)}`,
});
const data = {
  publicationId: "saveusnow",
  postId: "a-post",
  draft: ref("drafts/d.md"),
  approval: ref("verifications/v.json"),
  package: ref("packages/p.json"),
  approvedAt: "2026-11-20T12:00:00.000Z",
};

describe("article approved contract (#274)", () => {
  it("documents exactly the fields of the registered schema", () => {
    const doc = readFileSync(
      new URL("../../doc/operations/publishing-contract.md", import.meta.url),
      "utf8",
    );
    const section = doc.slice(doc.indexOf("### Event contract"), doc.indexOf("**Envelope:**"));
    const documented = [...section.matchAll(/^\|\s+`(\w+)`\s+\|/gm)].map((m) => m[1]).sort();
    expect(documented).toEqual(Object.keys(ArticleApprovedDataSchema.shape).sort());
    expect(doc).toContain(ARTICLE_APPROVED_EVENT_TYPE_V1);
  });

  it("is registered on its stream with an emission condition and guarantees", () => {
    const entry = MESSAGES.find((m) => m.subject === ARTICLE_APPROVED_SUBJECT);
    expect(entry).toMatchObject({
      eventType: ARTICLE_APPROVED_EVENT_TYPE_V1,
      stream: "STEELE_PUBLICATION",
    });
    expect(entry?.emittedWhen).toBeTruthy();
    expect(entry?.guarantees).toBeTruthy();
  });

  it("round-trips, keeps approvedAt as the event time, and rejects a mismatched subject or extra field", () => {
    const json = JSON.stringify(createArticleApprovedEvent(data, "approved-1").toJSON());
    expect(JSON.parse(json).time).toBe(data.approvedAt);
    expect(parseArticleApprovedEvent(json)).toEqual({ eventId: "approved-1", ...data });
    const wrong = JSON.parse(json);
    wrong.subject = "article/saveusnow/other";
    expect(() => parseArticleApprovedEvent(JSON.stringify(wrong))).toThrow();
    const extra = JSON.parse(json);
    extra.data.originalUrl = "https://example.com";
    expect(() => parseArticleApprovedEvent(JSON.stringify(extra))).toThrow();
  });

  it("versions owner draft authorization separately without changing legacy envelopes", () => {
    const targets = ["dummy-a", "dummy-b", "substack"].map((name, i) => ({
      name,
      provider: i < 2 ? "dummy" : "substack",
      action: "draft",
      capability: "unpublished-no-email-v1",
      identity: `sha256:${"c".repeat(64)}`,
    }));
    const owner = ArticleApprovedDataSchema.parse({
      ...data,
      approvalKind: "owner-draft-rehearsal",
      authorizationOutcome: "owner-authorized-draft",
      draftTargets: targets,
      publication: ref("publication.json"),
      assessment: ref("assessment.json"),
    });
    const event = createArticleApprovedEvent(owner, "approved-owner").toJSON();
    expect(event).toMatchObject({
      type: ARTICLE_DRAFT_AUTHORIZED_EVENT_TYPE_V2,
      dataschema: ARTICLE_DRAFT_AUTHORIZED_DATASCHEMA_V2,
    });
    expect(parseArticleApprovedEvent(JSON.stringify(event))).toMatchObject({
      eventId: "approved-owner",
      authorizationOutcome: "owner-authorized-draft",
    });
    expect(() =>
      parseArticleApprovedEvent(JSON.stringify({ ...event, type: ARTICLE_APPROVED_EVENT_TYPE_V1 })),
    ).toThrow();
    const v1 = createArticleApprovedEvent(data, "approved-legacy").toJSON();
    expect(v1.type).toBe(ARTICLE_APPROVED_EVENT_TYPE_V1);
    expect(v1.data).not.toHaveProperty("authorizationOutcome");
    expect(() => parseArticleApprovedEvent(JSON.stringify({ ...v1, data: owner }))).toThrow();
    expect(articleApprovedDataJsonSchema(1).properties).not.toHaveProperty("draftTargets");
    expect(articleApprovedDataJsonSchema(2).required).toEqual(
      expect.arrayContaining([
        "approvalKind",
        "authorizationOutcome",
        "draftTargets",
        "publication",
        "assessment",
      ]),
    );
    expect(MESSAGES.filter((m) => m.subject === ARTICLE_APPROVED_SUBJECT)).toHaveLength(1);
    expect(
      MESSAGES.find((m) => m.subject === ARTICLE_APPROVED_SUBJECT)?.supportedEventTypes,
    ).toContain(ARTICLE_DRAFT_AUTHORIZED_EVENT_TYPE_V2);
  });
});
