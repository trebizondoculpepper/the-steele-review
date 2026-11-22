import {
  readPublicationPayload,
  savePublicationPayload,
  artifactReference,
  artifactRef,
} from "../../src/drafting/publication-payload.js";
import { commitArticleRevision } from "../../src/drafting/article-revisions.js";
import {
  verifyPackageDraft,
  PackageVerificationReportSchema,
} from "../../src/drafting/package-verify.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  ARTICLE_APPROVED_SUBJECT,
  articleApprovedDataJsonSchema,
} from "../../src/events/article-approved-event.js";
import {
  SimulatedDestination,
  handleApprovedArticle,
  recordApproval,
  readDummyDeliveryProof,
} from "../../src/publishing/approved-article.js";
import { archive, approvedReport } from "./approval-fixtures.js";
import { assessArticle } from "../../src/drafting/article-assessment.js";

let dir: string;
let content: GitArtifactStore;
let operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-approved-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

const approved = (verdict?: string) => approvedReport(content, verdict);

/** A clock relative to the approval time (the event's `time`). */
let base = 0;
const at = (ms: number) => () => new Date(base + 3_700_000 + ms);

describe("multi-destination publishing contract (#262)", { timeout: 60_000 }, () => {
  it("records one durable approved-article event per approved revision", async () => {
    const report = await approved();
    const one = await recordApproval({ content, operations, report });
    const two = await recordApproval({ content, operations, report });
    expect(two.eventId).toBe(one.eventId);
    const due = operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT);
    expect(due).toHaveLength(1);
    expect(JSON.parse(due[0].payload)).toMatchObject({
      id: one.eventId,
      data: { publicationId: "pub", postId: "p1" },
    });
    expect(articleApprovedDataJsonSchema()).toMatchObject({ type: "object" });
  });

  it("refuses a report that does not approve the draft", async () => {
    const report = await approved("redraft");
    await expect(recordApproval({ content, operations, report })).rejects.toThrow(
      "does not approve",
    );
  });

  it("feeds independent destinations: own schedules, one failing, retry without repeating the other, duplicates reused", async () => {
    const report = await approved();
    await recordApproval({ content, operations, report });
    const payload = operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)[0].payload;
    base = Date.parse(JSON.parse(payload).time);
    const blog = new SimulatedDestination("blog", "draft", { failTimes: 1 });
    const telegram = new SimulatedDestination("telegram", "announce");
    const handle = (destination: SimulatedDestination, delayMs: number, now: () => Date) =>
      handleApprovedArticle({
        payload,
        destination,
        schedule: { delayMs },
        content,
        operations,
        owner: "t",
        now,
        retryDelayMs: 1,
      });

    // Telegram is scheduled an hour later than the blog.
    expect(
      await handle(
        telegram,
        3_600_000,
        () => new Date(Date.parse(JSON.parse(payload).time) + 60_000),
      ),
    ).toMatchObject({ action: "nak", reason: "scheduled" });
    // Blog fails first, Telegram completes independently.
    expect(await handle(blog, 0, at(0))).toMatchObject({ action: "nak", reason: "retry" });
    const tg = await handle(telegram, 3_600_000, at(0));
    expect(tg).toMatchObject({ action: "ack", outcome: "delivered" });
    // Retrying the blog delivers it once and does not touch Telegram.
    expect(await handle(blog, 0, at(1_000))).toMatchObject({ action: "ack", outcome: "delivered" });
    expect(blog.deliveries).toHaveLength(1);
    expect(telegram.deliveries).toHaveLength(1);
    // Duplicate delivery reuses the saved receipt.
    expect(await handle(telegram, 3_600_000, at(2_000))).toMatchObject({
      action: "ack",
      outcome: "reused",
    });
    expect(telegram.deliveries).toHaveLength(1);
    if (tg.action === "ack") {
      expect(JSON.parse(await content.read(tg.receipt))).toMatchObject({
        destination: "telegram",
        action: "announce",
        simulated: true,
      });
      expect(
        await content.lookup(tg.receipt.path.replace("receipt.json", "preview.json")),
      ).toBeDefined();
    }
  });

  it("proves both dummy receipts belong to the same exact draft", async () => {
    const report = await approved();
    const { data } = await recordApproval({ content, operations, report });
    const payload = operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)[0].payload;
    base = Date.parse(data.approvedAt);
    const handle = (name: string) =>
      handleApprovedArticle({
        payload,
        destination: new SimulatedDestination(name, "draft"),
        schedule: { delayMs: 0 },
        content,
        operations,
        owner: "fixture",
        now: at(0),
      });

    const a = await handle("dummy-a");
    expect(await readDummyDeliveryProof(content, data)).toBeUndefined();
    const b = await handle("dummy-b");
    if (a.action !== "ack" || b.action !== "ack") throw new Error("missing dummy receipt");
    expect(await readDummyDeliveryProof(content, data)).toEqual({ a: a.receipt, b: b.receipt });
    const differentDraft = {
      ...data,
      draft: {
        ...data.draft,
        hash: data.draft.hash.slice(0, -1) + (data.draft.hash.endsWith("0") ? "1" : "0"),
      },
    };
    await expect(readDummyDeliveryProof(content, differentDraft)).rejects.toThrow("does not prove");
    expect(await handle("dummy-b")).toMatchObject({ action: "ack", outcome: "reused" });
    expect(await readDummyDeliveryProof(content, data)).toEqual({ a: a.receipt, b: b.receipt });
  });

  it.each(["body", "metadata-only"])(
    "assesses and delivers canonical v1 after a %s v2 edit (#580)",
    async (edit) => {
      const legacyReport = await approved();
      const legacy = PackageVerificationReportSchema.parse(
        JSON.parse(await content.read(legacyReport)),
      );
      if (legacy.schemaVersion !== 2) throw new Error("expected structured approval");
      const original = await readPublicationPayload(content, legacy.publication);
      const snapshot = await commitArticleRevision({
        content,
        article: { publicationId: "pub", postId: "p1" },
        generation: {
          draft: artifactRef(legacy.draft),
          metadata: artifactRef(original.payload.metadata),
        },
        base: "current",
      });
      if (snapshot.status === "conflict") throw new Error("conflict");
      const approvedBody = await content.read(snapshot.body);
      const canonicalMetadata = JSON.parse(await content.read(snapshot.metadata));
      const assessed = await assessArticle({
        content,
        archive,
        metadata: snapshot.metadata,
        assessor: {
          modelVersion: "fake/canonical-assessor",
          complete: async (request) => {
            const user = JSON.parse(request.user);
            expect(user.article).toBe(approvedBody);
            expect(user.publication.title).toBe(canonicalMetadata.fields.title);
            return "No faults found.\nEND OF ASSESSMENT";
          },
        },
      });
      if (assessed.status !== "assessed") throw new Error(assessed.status);
      expect(assessed.record.body).toEqual(artifactReference(snapshot.body));
      expect(assessed.record.source).toEqual(legacy.source);
      const verified = await verifyPackageDraft({
        content,
        archive,
        metadata: snapshot.metadata,
        verifier: {
          modelVersion: "fake/canonical-verifier",
          complete: async (request) => {
            const user = JSON.parse(request.user);
            expect(user.draft).toBe(approvedBody);
            expect(user.publication.title).toBe(canonicalMetadata.fields.title);
            return JSON.stringify({ verdict: "approved", issues: [] });
          },
        },
      });
      if (verified.status !== "verified") throw new Error(verified.status);
      expect(verified.report.draft).toEqual(artifactReference(snapshot.body));
      const manifest = await readPublicationPayload(content, verified.report.publication!);
      expect(manifest.payload.metadata).toEqual(artifactReference(snapshot.metadata));
      const { data } = await recordApproval({ content, operations, report: verified.ref });
      const payload = operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)[0].payload;
      base = Date.parse(data.approvedAt);
      const changed = {
        ...canonicalMetadata,
        fields: { ...canonicalMetadata.fields, title: "A new unapproved title" },
      };
      const [bodyV2, metadataV2] = await content.reviseAll([
        {
          path: snapshot.body.path,
          content: edit === "body" ? approvedBody + "\nNew unapproved prose.\n" : approvedBody,
          expectedSha256: snapshot.body.sha256,
        },
        {
          path: snapshot.metadata.path,
          content: JSON.stringify(changed),
          expectedSha256: snapshot.metadata.sha256,
        },
      ]);
      expect(bodyV2.path).toBe(snapshot.body.path);
      expect(metadataV2.path).toBe(snapshot.metadata.path);
      if (edit === "metadata-only") expect(bodyV2.sha256).toBe(snapshot.body.sha256);
      if (edit === "body")
        await expect(
          savePublicationPayload({
            content,
            metadata: metadataV2,
            body: bodyV2,
            post: { publicationId: "pub", postId: "p1" },
          }),
        ).rejects.toThrow();
      // Old canonical pair remains inspectable and approved even though current paths changed.
      expect(
        (await readPublicationPayload(content, verified.report.publication!)).payload,
      ).toMatchObject({ mode: "structured", fields: canonicalMetadata.fields });
      const sent: Parameters<SimulatedDestination["deliver"]>[0][] = [];
      const site = new (class extends SimulatedDestination {
        override async deliver(
          preview: Parameters<SimulatedDestination["deliver"]>[0],
          key: string,
        ) {
          sent.push(preview);
          return super.deliver(preview, key);
        }
      })("canonical-site", "draft", { uncertainTimes: 1 });
      const handle = (event = payload) =>
        handleApprovedArticle({
          payload: event,
          destination: site,
          schedule: { delayMs: 0 },
          content,
          operations,
          owner: "fixture",
          now: at(0),
          retryDelayMs: 1,
        });
      expect(await handle()).toMatchObject({ action: "nak", reason: "uncertain" });
      expect(await handle()).toMatchObject({ action: "ack", outcome: "delivered" });
      expect(await handle()).toMatchObject({ action: "ack", outcome: "reused" });
      expect(site.deliveries).toHaveLength(1);
      expect(sent).toHaveLength(1);
      expect(sent[0].body).toContain(approvedBody);
      expect(sent[0].publication).toMatchObject({
        fields: canonicalMetadata.fields,
        body: artifactReference(snapshot.body),
        metadata: artifactReference(snapshot.metadata),
      });
      const preview = JSON.stringify(sent[0]);
      expect(preview).not.toContain("A new unapproved title");
      expect(preview).not.toContain("New unapproved prose");
      const newer = JSON.parse(payload);
      newer.data.draft = artifactReference({ ...bodyV2, commit: metadataV2.commit });
      if (edit === "metadata-only") {
        const v2 = await savePublicationPayload({
          content,
          metadata: metadataV2,
          body: { ...bodyV2, commit: metadataV2.commit },
          post: { publicationId: "pub", postId: "p1" },
        });
        expect(v2.payload.contentHash).not.toBe(manifest.payload.contentHash);
        newer.data.publication = artifactReference(v2.ref);
      }
      expect(await handle(JSON.stringify(newer))).toMatchObject({ action: "term" });
      expect(site.deliveries).toHaveLength(1);
    },
  );

  it("reconciles an uncertain delivery before retrying, so it is never sent twice", async () => {
    const report = await approved();
    await recordApproval({ content, operations, report });
    const payload = operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)[0].payload;
    base = Date.parse(JSON.parse(payload).time);
    const site = new SimulatedDestination("site", "draft", { uncertainTimes: 1 });
    const handle = () =>
      handleApprovedArticle({
        payload,
        destination: site,
        schedule: { delayMs: 0 },
        content,
        operations,
        owner: "t",
        now: at(0),
        retryDelayMs: 1,
      });
    expect(await handle()).toMatchObject({ action: "nak", reason: "uncertain" });
    expect(await handle()).toMatchObject({ action: "ack", outcome: "delivered" });
    expect(site.deliveries).toHaveLength(1); // reconciled, not re-sent
  });

  it("rejects an event whose approval does not match the stored draft", async () => {
    const report = await approved();
    await recordApproval({ content, operations, report });
    const payload = JSON.parse(
      operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)[0].payload,
    );
    payload.data.draft.hash = `sha256:${"0".repeat(64)}`;
    const out = await handleApprovedArticle({
      payload: JSON.stringify(payload),
      destination: new SimulatedDestination("x", "draft"),
      schedule: { delayMs: 0 },
      content,
      operations,
      owner: "t",
      now: at(0),
    });
    expect(out).toEqual({ action: "term", reason: "approval-mismatch" });
  });

  it("recovers a receipt committed before a crash, and keeps actions of one destination apart", async () => {
    const report = await approved();
    await recordApproval({ content, operations, report });
    const payload = operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)[0].payload;
    base = Date.parse(JSON.parse(payload).time);
    const draftAction = new SimulatedDestination("site", "draft");
    const first = await handleApprovedArticle({
      payload,
      destination: draftAction,
      schedule: { delayMs: 0 },
      content,
      operations,
      owner: "t",
      now: at(0),
    });
    expect(first).toMatchObject({ action: "ack", outcome: "delivered" });
    // A different action for the same destination has its own record and artifacts.
    const publishAction = new SimulatedDestination("site", "publish");
    const second = await handleApprovedArticle({
      payload,
      destination: publishAction,
      schedule: { delayMs: 0 },
      content,
      operations,
      owner: "t",
      now: at(0),
    });
    expect(second).toMatchObject({ action: "ack", outcome: "delivered" });
    if (first.action === "ack" && second.action === "ack")
      expect(second.receipt.path).not.toBe(first.receipt.path);
    // Crash after the receipt commit but before completion: a fresh state store
    // still finds the receipt and reuses it instead of delivering again.
    operations.close();
    operations = new OperationStore({ path: join(dir, "state-after-crash.sqlite") });
    const again = await handleApprovedArticle({
      payload,
      destination: draftAction,
      schedule: { delayMs: 0 },
      content,
      operations,
      owner: "t",
      now: at(0),
    });
    expect(again).toMatchObject({ action: "ack", outcome: "reused" });
    expect(draftAction.deliveries).toHaveLength(1);
  });
  it("holds an unsupported destination without intent, then resumes the same payload when supported", async () => {
    const approval = await recordApproval({ content, operations, report: await approved() });
    const payload = operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)[0]!.payload;
    const simulated = new SimulatedDestination("future", "draft");
    let seen: unknown;
    const destination = {
      name: simulated.name,
      action: simulated.action,
      supportsPublicationPayload: false,
      render: (article: Parameters<typeof simulated.render>[0]) => {
        seen = article.publication;
        return simulated.render(article);
      },
      deliver: simulated.deliver.bind(simulated),
      reconcile: simulated.reconcile.bind(simulated),
    };
    const handle = () =>
      handleApprovedArticle({
        payload,
        destination,
        schedule: { delayMs: 0 },
        content,
        operations,
        owner: "t",
      });
    expect(await handle()).toMatchObject({ action: "nak", reason: "unsupported-payload" });
    expect(simulated.deliveries).toHaveLength(0);
    expect(operations.listOperations("publish:")).toHaveLength(0);
    expect(await content.list("publications", 100)).toHaveLength(0);
    destination.supportsPublicationPayload = true;
    const delivered = await handle();
    expect(delivered).toMatchObject({ action: "ack", outcome: "delivered" });
    if (!approval.data.publication || delivered.action !== "ack")
      throw new Error("expected payload");
    const expected = await readPublicationPayload(content, approval.data.publication);
    expect(seen).toEqual(expected.payload);
    expect(JSON.parse(await content.read(delivered.receipt))).toMatchObject({
      publicationHash: expected.payload.contentHash,
      draftHash: approval.data.draft.hash,
    });
    expect(await handle()).toMatchObject({ action: "ack", outcome: "reused" });
    expect(simulated.deliveries).toHaveLength(1);
  });

  it("rejects substituted metadata and keeps a new title's receipt separate from identical body bytes", async () => {
    const originalRef = await approved();
    const first = await recordApproval({ content, operations, report: originalRef });
    if (!first.data.publication) throw new Error("expected payload");
    const originalEvent = operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)[0]!.payload;
    const { payload: original } = await readPublicationPayload(content, first.data.publication);
    const metadata = JSON.parse(await content.read(artifactRef(original.metadata)));
    metadata.fields.title = "A changed title";
    const metadataRef = await content.write(
      original.metadata.path.replace(/\.json$/, "-retitled.json"),
      JSON.stringify(metadata),
    );
    const replacement = await savePublicationPayload({
      content,
      metadata: metadataRef,
      body: artifactRef(original.body),
      post: { publicationId: "pub", postId: "p1" },
    });
    const destination = new SimulatedDestination("site", "draft");
    const handle = (payload: string) =>
      handleApprovedArticle({
        payload,
        destination,
        schedule: { delayMs: 0 },
        content,
        operations,
        owner: "t",
      });
    expect(await handle(originalEvent)).toMatchObject({ action: "ack", outcome: "delivered" });
    const tampered = JSON.parse(originalEvent);
    tampered.data.publication = artifactReference(replacement.ref);
    expect(await handle(JSON.stringify(tampered))).toMatchObject({
      action: "term",
      reason: "approval-mismatch",
    });
    delete tampered.data.publication;
    expect(await handle(JSON.stringify(tampered))).toMatchObject({
      action: "term",
      reason: "approval-mismatch",
    });
    const report = PackageVerificationReportSchema.parse(
      JSON.parse(await content.read(originalRef)),
    );
    const secondRef = await content.write(
      "verifications/pub/p1/retitled.json",
      JSON.stringify({ ...report, publication: artifactReference(replacement.ref) }),
    );
    const second = await recordApproval({ content, operations, report: secondRef });
    const secondEvent = operations
      .duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)
      .find((e) => e.eventId === second.eventId);
    if (!secondEvent) throw new Error("missing event");
    expect(await handle(secondEvent.payload)).toMatchObject({
      action: "ack",
      outcome: "delivered",
    });
    // A new provenance lineage with identical reader-visible bytes needs its
    // own verification, but must not cause a second external delivery.
    const identical = JSON.parse(await content.read(artifactRef(original.metadata)));
    identical.draftedAt = "2026-01-02T00:00:00Z";
    const identicalMeta = await content.write(
      original.metadata.path.replace(/\.json$/, "-identical.json"),
      JSON.stringify(identical),
    );
    const identicalPayload = await savePublicationPayload({
      content,
      metadata: identicalMeta,
      body: artifactRef(original.body),
      post: { publicationId: "pub", postId: "p1" },
    });
    expect(identicalPayload.ref.sha256).not.toBe(first.data.publication.hash.slice(7));
    expect(identicalPayload.payload.contentHash).toBe(original.contentHash);
    const identicalReport = await content.write(
      "verifications/pub/p1/identical.json",
      JSON.stringify({ ...report, publication: artifactReference(identicalPayload.ref) }),
    );
    const same = await recordApproval({ content, operations, report: identicalReport });
    const sameEvent = operations
      .duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)
      .find((e) => e.eventId === same.eventId);
    if (!sameEvent) throw new Error("missing identical event");
    expect(await handle(sameEvent.payload)).toMatchObject({ action: "ack", outcome: "reused" });
    expect(destination.deliveries).toHaveLength(2);
    expect(new Set(destination.deliveries).size).toBe(2);
    expect(await handle(secondEvent.payload)).toMatchObject({ action: "ack", outcome: "reused" });
  });
  it.each(["lost-response", "receipt-write"])(
    "retains the original manifest and preview after %s followed by equal content with new provenance",
    async (fault) => {
      const originalReport = await approved();
      const first = await recordApproval({ content, operations, report: originalReport });
      if (!first.data.publication) throw new Error("expected payload");
      const originalEvent = operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)[0]!.payload;
      const { payload: original } = await readPublicationPayload(content, first.data.publication);
      const simulated = new SimulatedDestination("site", "draft", {
        uncertainTimes: fault === "lost-response" ? 1 : 0,
      });
      let reconciledPreview: unknown;
      let configuredByline = "Original configured author";
      let renders = 0;
      const destination = {
        name: simulated.name,
        action: simulated.action,
        supportsPublicationPayload: true,
        render: (input: Parameters<typeof simulated.render>[0]) => {
          renders++;
          return { ...simulated.render(input), bylines: [configuredByline] };
        },
        deliver: simulated.deliver.bind(simulated),
        reconcile: async (key: string, context?: { preview: unknown }) => {
          reconciledPreview = context?.preview;
          return simulated.reconcile(key);
        },
      };
      const failing =
        fault === "receipt-write"
          ? new Proxy(content, {
              get(target, prop) {
                if (prop === "write")
                  return async (path: string, body: string) => {
                    if (path.endsWith("/receipt.json")) throw new Error("simulated disk full");
                    return target.write(path, body);
                  };
                const value = Reflect.get(target, prop);
                return typeof value === "function" ? value.bind(target) : value;
              },
            })
          : content;
      const handle = (payload: string, store = content) =>
        handleApprovedArticle({
          payload,
          destination,
          schedule: { delayMs: 0 },
          content: store,
          operations,
          owner: "t",
        });
      expect(await handle(originalEvent, failing)).toMatchObject({ action: "nak" });
      expect(simulated.deliveries).toHaveLength(1);
      configuredByline = "Changed configured author";
      const changed = JSON.parse(await content.read(artifactRef(original.metadata)));
      changed.draftedAt = "2026-01-02T00:00:00Z";
      const meta = await content.write(
        original.metadata.path.replace(/\.json$/, "-next.json"),
        JSON.stringify(changed),
      );
      const next = await savePublicationPayload({
        content,
        metadata: meta,
        body: artifactRef(original.body),
        post: { publicationId: "pub", postId: "p1" },
      });
      expect(next.payload.contentHash).toBe(original.contentHash);
      const report = PackageVerificationReportSchema.parse(
        JSON.parse(await content.read(originalReport)),
      );
      const nextReport = await content.write(
        "verifications/pub/p1/next.json",
        JSON.stringify({ ...report, publication: artifactReference(next.ref) }),
      );
      const second = await recordApproval({ content, operations, report: nextReport });
      const event = operations
        .duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)
        .find((e) => e.eventId === second.eventId);
      if (!event) throw new Error("missing second event");
      const result = await handle(event.payload);
      expect(result).toMatchObject({ action: "ack", outcome: "delivered" });
      if (result.action !== "ack") throw new Error("expected receipt");
      expect(simulated.deliveries).toHaveLength(1);
      expect(JSON.parse(await content.read(result.receipt))).toMatchObject({
        publication: first.data.publication,
        publicationHash: original.contentHash,
      });
      expect(reconciledPreview).toMatchObject({
        publication: original,
        bylines: ["Original configured author"],
      });
      expect(renders).toBe(1);
      expect(await handle(event.payload)).toMatchObject({ action: "ack", outcome: "reused" });
    },
  );

  it("holds a structured attempt when an old intent has no authoritative manifest", async () => {
    const first = await recordApproval({ content, operations, report: await approved() });
    if (!first.data.publication) throw new Error("expected payload");
    const event = operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)[0]!.payload;
    const { payload } = await readPublicationPayload(content, first.data.publication);
    const revision = payload.contentHash.slice(7, 39);
    const key = `publish:site:draft:${revision}`;
    await content.write(
      `publications/site/draft/pub/p1/${revision}/intent.json`,
      JSON.stringify({ key, at: "2026-01-01T00:00:00Z" }),
    );
    const destination = new SimulatedDestination("site", "draft");
    const out = await handleApprovedArticle({
      payload: event,
      destination,
      schedule: { delayMs: 0 },
      content,
      operations,
      owner: "t",
    });
    expect(out).toMatchObject({ action: "nak", reason: "uncertain" });
    expect(destination.deliveries).toHaveLength(0);
    expect(operations.operationStatus(key)).toMatchObject({
      status: "released",
      attempts: 1,
    });
  });
});
