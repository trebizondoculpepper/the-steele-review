import { describe, expect, it } from "vite-plus/test";
import { ControlledSubstackClient } from "../../src/publishing/controlled-destination.js";
import {
  DestinationError,
  SubstackDestinationController,
  reconcilePublication,
  renderDraftBody,
  type DraftContent,
  type PublicationDestination,
} from "../../src/publishing/destination.js";

const content: DraftContent = {
  title: "A synthetic response",
  subtitle: "Synthetic subtitle",
  bodyMarkdown:
    "## Summary\n\nSynthetic article text with a [citation](https://evidence.example.org/x).",
  sourceUrl: "https://example-pub.substack.com/p/a-post",
};
const now = () => new Date("2026-05-01T12:00:00Z");

function setup() {
  const client = new ControlledSubstackClient("https://destination.example", now);
  const destination = new SubstackDestinationController(client);
  return { client, destination };
}

/**
 * Contract every PublicationDestination must satisfy. Runs here against the
 * controlled client; a live client can reuse it once an authorised test
 * destination exists.
 */
function destinationContract(make: () => PublicationDestination) {
  it("creates a draft whose stable ID reads back as an unpublished draft", async () => {
    const destination = make();
    const { draftId } = await destination.createDraft(content);
    expect(draftId).toMatch(/\S/);
    expect(await destination.getStatus(draftId)).toEqual({ state: "draft", draftId });
  });

  it("publishes by draft ID and confirms by read-back", async () => {
    const destination = make();
    const { draftId } = await destination.createDraft(content);
    const receipt = await destination.publish(draftId);
    expect(receipt).toMatchObject({ draftId });
    expect(await destination.getStatus(draftId)).toMatchObject({
      state: "published",
      url: receipt.url,
    });
  });

  it("reports an unknown draft as not found", async () => {
    expect(await make().getStatus("999999")).toEqual({ state: "not-found", draftId: "999999" });
  });
}

describe("SubstackDestinationController contract (controlled client)", () => {
  destinationContract(() => setup().destination);
});

describe("SubstackDestinationController", () => {
  it("formats the agreed draft body with the original-post link", async () => {
    const { client, destination } = setup();
    const { draftId } = await destination.createDraft(content);
    const stored = client.drafts.get(draftId)!;
    expect(stored.body).toBe(renderDraftBody(content));
    expect(stored.body).toContain("Original post: https://example-pub.substack.com/p/a-post");
    expect(stored).toMatchObject({ title: content.title, subtitle: content.subtitle });
  });

  it("validates draft content before calling the vendor", async () => {
    const { client, destination } = setup();
    await expect(destination.createDraft({ ...content, title: " " })).rejects.toThrow();
    await expect(
      destination.createDraft({ ...content, sourceUrl: "http://insecure.test/p" }),
    ).rejects.toThrow();
    expect(client.drafts.size).toBe(0);
  });

  it("does not email subscribers unless asked", async () => {
    const { client, destination } = setup();
    const quiet = await destination.createDraft(content);
    await destination.publish(quiet.draftId);
    expect(client.drafts.get(quiet.draftId)!.emailed).toBe(false);
    const loud = await destination.createDraft(content);
    await destination.publish(loud.draftId, { sendEmail: true });
    expect(client.drafts.get(loud.draftId)!.emailed).toBe(true);
  });

  it("treats a lost publish response as uncertain and reconciles it by draft ID", async () => {
    const { client, destination } = setup();
    const { draftId } = await destination.createDraft(content);
    client.inject("publishDraft", "lost-response");
    await expect(destination.publish(draftId)).rejects.toMatchObject({ category: "uncertain" });
    // The side effect happened; read-back settles it without a second draft or publish.
    const result = await reconcilePublication(destination, draftId);
    expect(result).toMatchObject({ outcome: "published", receipt: { draftId } });
    expect(client.drafts.size).toBe(1);
  });

  it("leaves a publication uncertain while read-back is unavailable", async () => {
    const { client, destination } = setup();
    const { draftId } = await destination.createDraft(content);
    client.inject("getDraft", "outage");
    expect(await reconcilePublication(destination, draftId)).toEqual({ outcome: "uncertain" });
    expect(await reconcilePublication(destination, draftId)).toEqual({ outcome: "unpublished" });
  });

  it("reports an uncertain draft creation instead of pretending it failed", async () => {
    const { client, destination } = setup();
    client.inject("createDraft", "lost-response");
    await expect(destination.createDraft(content)).rejects.toMatchObject({
      category: "uncertain",
      retryable: false,
    });
    // A draft was created; the caller must not blindly create another.
    expect(client.drafts.size).toBe(1);
  });

  it.each([
    ["auth-expired", "auth-expired", false],
    ["rate-limited", "rate-limited", true],
    ["rejected", "rejected", false],
    ["outage", "uncertain", false],
  ] as const)("classifies a publish %s as %s", async (fault, category, retryable) => {
    const { client, destination } = setup();
    const { draftId } = await destination.createDraft(content);
    client.inject("publishDraft", fault);
    const error = await destination.publish(draftId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DestinationError);
    expect(error).toMatchObject({ category, retryable });
  });

  it("treats an unconfirmed publish as uncertain", async () => {
    const { client, destination } = setup();
    const { draftId } = await destination.createDraft(content);
    client.inject("getDraft", "outage");
    await expect(destination.publish(draftId)).rejects.toMatchObject({ category: "uncertain" });
  });

  it("rejects malformed vendor responses", async () => {
    const destination = new SubstackDestinationController({
      createDraft: async () => ({ ok: true }),
      getDraft: async () => ({ id: 1, is_published: true, canonical_url: "not a url" }),
      publishDraft: async () => ({}),
    });
    await expect(destination.createDraft(content)).rejects.toMatchObject({ category: "uncertain" });
    await expect(destination.getStatus("1")).rejects.toMatchObject({ category: "unavailable" });
  });

  it("does not treat a read-back without a publication state as an unpublished draft", async () => {
    const destination = new SubstackDestinationController({
      createDraft: async () => ({ id: 1 }),
      getDraft: async () => ({ id: 1 }),
      publishDraft: async () => ({}),
    });
    await expect(destination.getStatus("1")).rejects.toMatchObject({ category: "unavailable" });
    expect(await reconcilePublication(destination, "1")).toEqual({ outcome: "uncertain" });
  });

  it("reports a draft creation aborted in flight as uncertain, and one aborted before sending as cancelled", async () => {
    const { client, destination } = setup();
    const abort = new AbortController();
    const slow = new SubstackDestinationController({
      createDraft: async (draft) => {
        await client.createDraft(draft);
        abort.abort();
        throw new Error("aborted after send");
      },
      getDraft: (id) => client.getDraft(id),
      publishDraft: (id, o) => client.publishDraft(id, o),
    });
    await expect(slow.createDraft(content, abort.signal)).rejects.toMatchObject({
      category: "uncertain",
    });
    expect(client.drafts.size).toBe(1);
    await expect(destination.createDraft(content, abort.signal)).rejects.toMatchObject({
      category: "cancelled",
    });
    expect(client.drafts.size).toBe(1);
  });

  it("never surfaces vendor error text", async () => {
    const destination = new SubstackDestinationController({
      createDraft: async () => {
        throw new Error("cookie=secret-session at https://private.example");
      },
      getDraft: async () => ({}),
      publishDraft: async () => ({}),
    });
    const error = await destination.createDraft(content).catch((e: unknown) => e);
    expect(String(error)).not.toMatch(/secret|private/);
  });
});
