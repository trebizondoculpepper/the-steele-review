import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { draftFromPackage } from "../../src/drafting/package-draft.js";
import { verifyPackageDraft } from "../../src/drafting/package-verify.js";
import { saveWriterPackage } from "../../src/drafting/writer-package.js";
import {
  ARTICLE_APPROVED_SUBJECT,
  articleApprovedDataJsonSchema,
} from "../../src/events/article-approved-event.js";
import {
  SimulatedDestination,
  handleApprovedArticle,
  recordApproval,
} from "../../src/publishing/approved-article.js";
import { LexicalShortlister, assessPostCoverage } from "../../src/research/librarian.js";
import { CLAIMS, SHARED, TEXT, librarianFixtures } from "../research/librarian-fixtures.js";

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

const archive = {
  read: async () =>
    JSON.stringify({
      item: { publicationId: "pub", postId: "p1", url: "https://pub.example.com/p/p1", title: "T" },
      ingestionReason: "backfill",
      text: TEXT,
      complete: true,
      supplied: {},
      provenance: {
        sourceUrl: "https://pub.example.com/p/p1",
        acquiredAt: "2026-01-01T00:00:00.000Z",
        method: "article-html",
      },
    }),
} as unknown as GitArtifactStore;

const WRITER = JSON.stringify({
  summary: "The post says a treaty bans weather weapons.",
  themes: ["Weather warfare"],
  responses: [
    {
      claimRecordId: "claim-treaty",
      verdict: "supported",
      text: "The ENMOD Convention prohibits this.",
      evidence: [0],
    },
    {
      claimRecordId: "claim-payment",
      verdict: "unresolved",
      text: "No record was found.",
      evidence: [],
    },
  ],
  limitations: [],
  narrative: { status: "limited", limitation: "None compared." },
  widerContext: { status: "limited", limitation: "None used." },
});
const fake = (version: string, response: string) => ({
  modelVersion: version,
  complete: async () => response,
});

/** An approved package draft and its saved verification report. */
async function approved(verdict = "approved") {
  const fx = librarianFixtures(content);
  const a = await fx.analysis("p1", CLAIMS);
  const coverage = await assessPostCoverage({
    artifacts: content,
    ...a,
    commission: fx.researcher(() => ({
      passages: [{ claimRecordId: "claim-treaty", url: SHARED }],
    })).commission,
    shortlister: new LexicalShortlister(),
  });
  const pkg = await saveWriterPackage({ content, coverage: coverage.ref });
  const draft = await draftFromPackage({
    content,
    archive,
    package: pkg.ref,
    provider: fake("fake/writer", WRITER),
    sourceUrl: "https://pub.example.com/p/p1",
  });
  if (draft.status !== "drafted") throw new Error(draft.status);
  const verified = await verifyPackageDraft({
    content,
    archive,
    metadata: draft.metadata,
    verifier: fake(
      "fake/verifier",
      JSON.stringify({
        verdict,
        issues:
          verdict === "approved" ? [] : [{ passage: "x", reason: "y", severity: "substantive" }],
      }),
    ),
  });
  if (verified.status !== "verified") throw new Error(verified.status);
  return verified.ref;
}

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
});
