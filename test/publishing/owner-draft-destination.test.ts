import { describe, expect, it } from "vite-plus/test";
import { ArticleApprovedDataSchema } from "../../src/events/article-approved-event.js";
import {
  SimulatedDestination,
  UncertainDeliveryError,
} from "../../src/publishing/approved-article.js";
import { SubstackDraftDestination } from "../../src/publishing/substack/destination.js";
import {
  SubstackClient,
  SubstackError,
  type SubstackDraft,
} from "../../src/publishing/substack/client.js";
import {
  publicationContentHash,
  type PublicationPayload,
} from "../../src/drafting/publication-payload.js";
import { localDraftDestination } from "./draft-destination-fixture.js";

const ref = {
  repository: "content",
  commit: "a".repeat(40),
  path: "synthetic.json",
  hash: `sha256:${"b".repeat(64)}`,
};
function previewFor(destination: SubstackDraftDestination) {
  const fields = {
    title: "A retained article",
    subtitle: "An unresolved scope question",
    excerpt: "Internal excerpt only.",
  };
  const publication: PublicationPayload = {
    schemaVersion: 1,
    mode: "structured",
    body: ref,
    metadata: ref,
    fields,
    contentHash: publicationContentHash({ mode: "structured", body: ref, fields }),
  };
  const data = ArticleApprovedDataSchema.parse({
    publicationId: "pub",
    postId: "post",
    draft: ref,
    approval: ref,
    package: ref,
    publication: ref,
    assessment: ref,
    approvedAt: "2026-01-01T00:00:00Z",
    approvalKind: "owner-draft-rehearsal",
    authorizationOutcome: "owner-authorized-draft",
    draftTargets: [
      new SimulatedDestination("dummy-a", "draft").draftTarget,
      new SimulatedDestination("dummy-b", "draft").draftTarget,
      destination.draftTarget,
    ],
  });
  return destination.render({
    markdown: "The evidence leaves a scope question unresolved.",
    data,
    publication,
  });
}
describe("draft-only destination authority (fast, synthetic transport)", () => {
  it("binds opaque publication/byline identity and rejects drift before any network action", async () => {
    const t = localDraftDestination(),
      preview = previewFor(t.destination);
    const changed = new SubstackDraftDestination(t.client, { bylineId: "123" });
    await expect(changed.deliver(preview, "same")).rejects.toThrow("target mismatch");
    expect(await changed.reconcile("same", { preview })).toBe("unknown");
    expect(t.calls).toEqual({ create: 0, get: 0, list: 0 });
    const a = new SubstackClient({
      origin: "https://one.example",
      session: async () => "synthetic",
    });
    const b = new SubstackClient({
      origin: "https://two.example",
      session: async () => "synthetic",
    });
    expect(a.draftTargetIdentity).not.toBe(b.draftTargetIdentity);
    expect(a.draftTargetIdentity).not.toContain("one.example");
  });
  it.each([
    (d: SubstackDraft) => {
      d.is_published = true;
    },
    (d: SubstackDraft) => {
      d.email_sent_at = "2026-01-01T00:00:00Z";
    },
    (d: SubstackDraft) => {
      delete d.email_sent_at;
    },
    (d: SubstackDraft) => {
      delete d.is_published;
    },
  ])(
    "never accepts published, emailed, or unproved state on initial readback or reconciliation",
    async (mutate) => {
      const t = localDraftDestination(),
        get = t.client.getDraft;
      t.client.getDraft = async (id) => {
        const draft = await get(id);
        mutate(draft);
        return draft;
      };
      const preview = previewFor(t.destination);
      await expect(t.destination.deliver(preview, "one")).rejects.toBeInstanceOf(
        UncertainDeliveryError,
      );
      expect(await t.destination.reconcile("one", { preview })).toBe("unknown");
      expect(t.calls.create).toBe(1);
    },
  );
  it("reconciles an uncertain create to the exact unpublished/no-email draft without creating again", async () => {
    const t = localDraftDestination(),
      create = t.client.createDraft;
    t.client.createDraft = async (input) => {
      await create(input);
      throw new SubstackError("uncertain");
    };
    const preview = previewFor(t.destination);
    await expect(t.destination.deliver(preview, "once")).rejects.toBeInstanceOf(
      UncertainDeliveryError,
    );
    const result = await t.destination.reconcile("once", { preview });
    expect(result).toMatchObject({
      delivered: {
        simulated: false,
        externalId: "1",
        draftSafety: { unpublished: true, emailTimestampAbsent: true },
      },
    });
    expect(t.calls.create).toBe(1);
    expect(JSON.parse(preview.body)).toMatchObject({
      title: "A retained article",
      subtitle: "An unresolved scope question",
    });
    expect(JSON.parse(preview.body)).not.toHaveProperty("excerpt");
  });
  it("requires a live control and re-reads it after preflight before creating", async () => {
    const t = localDraftDestination(),
      preview = previewFor(t.destination);
    const noControl = new SubstackDraftDestination(t.client);
    await expect(noControl.deliver(preview, "no-control")).rejects.toMatchObject({
      reason: "paused",
    });
    expect(t.calls.create).toBe(0);
    expect(t.calls.list).toBe(0);
    const list = t.client.listDrafts;
    t.client.listDrafts = async () => {
      const rows = await list();
      t.policy.allowed = false;
      return rows;
    };
    await expect(t.destination.deliver(preview, "stop-during-preflight")).rejects.toMatchObject({
      reason: "paused",
    });
    expect(t.calls.create).toBe(0);
    expect(t.policy.reads).toBeGreaterThanOrEqual(2);
  });
  it("refuses a stale adapter when current configuration changes target or capability", async () => {
    const t = localDraftDestination(),
      preview = previewFor(t.destination);
    t.policy.currentRealIdentity = `sha256:${"0".repeat(64)}`;
    await expect(t.destination.deliver(preview, "changed-target")).rejects.toMatchObject({
      reason: "paused",
    });
    t.policy.currentRealIdentity = t.destination.draftTarget!.identity;
    t.policy.draftOnly = false;
    await expect(t.destination.deliver(preview, "changed-capability")).rejects.toMatchObject({
      reason: "paused",
    });
    expect(t.calls).toEqual({ create: 0, get: 0, list: 0 });
  });
});
