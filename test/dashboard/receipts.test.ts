import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { VERIFICATION_REPORT_SCHEMA_VERSION } from "../../src/drafting/package-verify.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import {
  contentArticleView,
  contentReceipts,
} from "../../src/dashboard/adapters.js";
import type { Ref } from "../../src/workflow/article-run.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-receipts-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ref = (a: Awaited<ReturnType<GitArtifactStore["write"]>>): Ref => ({
  repository: a.repository,
  commit: a.commit,
  path: a.path,
  sha256: a.sha256,
});

const persisted = (r: Ref) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

const report = (draft: Ref) => ({
  schemaVersion: VERIFICATION_REPORT_SCHEMA_VERSION,
  outcome: "approved",
  draft: persisted(draft),
  package: persisted(draft),
  source: persisted(draft),
  themes: persisted(draft),
  issues: [],
  checks: ["quotation"],
  verifierModel: "m",
  promptVersion: "p",
  verifiedAt: "2026-01-01T00:00:00Z",
});

const receipt = (over: Record<string, unknown>) => ({
  destination: "dummy-a",
  action: "draft",
  simulated: true,
  deliveredAt: "2026-01-01T00:00:00Z",
  ...over,
});

describe("contentArticleView", () => {
  it("reads the draft and its verification report at the pinned revision", async () => {
    const draftText = "# Draft\n\nA claim.";
    const draftRef = ref(await content.write("articles/pub/p1/draft.md", draftText));
    const reportRef = ref(
      await content.write("verify/pub/p1/report.json", `${JSON.stringify(report(draftRef))}\n`),
    );
    const view = contentArticleView(content);
    expect(await view.draft(draftRef)).toBe(draftText);
    expect(await view.verification(reportRef)).toEqual({
      outcome: "approved",
      draftHash: `sha256:${draftRef.sha256}`,
    });
  });

  it("returns undefined for a mismatched hash or an unreadable report", async () => {
    const draftRef = ref(await content.write("articles/pub/p1/draft.md", "body"));
    const view = contentArticleView(content);
    expect(await view.draft({ ...draftRef, sha256: "0".repeat(64) })).toBeUndefined();

    const broken = ref(await content.write("verify/pub/p1/bad.json", "{not json"));
    expect(await view.verification(broken)).toBeUndefined();
  });
});

describe("contentReceipts", () => {
  it("lists receipts for the exact revision and labels simulated deliveries", async () => {
    const draftHash = "c".repeat(64);
    const rev = "c".repeat(32);
    await content.write(
      `publications/dummy-a/draft/pub/p1/${rev}/receipt.json`,
      `${JSON.stringify(receipt({ destination: "dummy-a", simulated: true, url: "https://hidden.test/a" }))}\n`,
    );
    await content.write(
      `publications/dummy-b/draft/pub/p1/${rev}/receipt.json`,
      `${JSON.stringify(
        receipt({ destination: "dummy-b", simulated: false, url: "https://example.test/b" }),
      )}\n`,
    );
    // Another revision and another post are excluded.
    await content.write(
      `publications/dummy-a/draft/pub/p1/${"d".repeat(32)}/receipt.json`,
      `${JSON.stringify(receipt({}))}\n`,
    );
    await content.write(
      `publications/dummy-a/draft/pub/p2/${rev}/receipt.json`,
      `${JSON.stringify(receipt({}))}\n`,
    );

    const { receipts, truncated } = await contentReceipts(content).receiptsFor(
      { publicationId: "pub", postId: "p1" },
      `sha256:${draftHash}`,
    );
    expect(truncated).toBe(false);
    expect(receipts).toEqual([
      {
        destination: "dummy-a",
        action: "draft",
        simulated: true,
        deliveredAt: "2026-01-01T00:00:00Z",
      },
      {
        destination: "dummy-b",
        action: "draft",
        simulated: false,
        deliveredAt: "2026-01-01T00:00:00Z",
        url: "https://example.test/b",
      },
    ]);
    expect(receipts[0]).not.toHaveProperty("url");
  });

  it("scopes the scan to configured destinations", async () => {
    const rev = "c".repeat(32);
    const write = (destination: string, postId: string) =>
      content.write(
        `publications/${destination}/draft/pub/${postId}/${rev}/receipt.json`,
        `${JSON.stringify(receipt({ destination }))}\n`,
      );
    // Sorted listing puts every dummy-a path before dummy-b, so a bounded
    // unscoped scan of a large tree could miss dummy-b entirely.
    for (let n = 0; n < 30; n++) await write("dummy-a", "filler");
    await write("dummy-b", "p1");
    const scoped = await contentReceipts(content, { destinations: ["dummy-b"] }).receiptsFor(
      { publicationId: "pub", postId: "p1" },
      `sha256:${"c".repeat(64)}`,
    );
    expect(scoped.receipts.map((r) => r.destination)).toEqual(["dummy-b"]);
  });

  it("omits unreadable receipts instead of guessing", async () => {
    await content.write("publications/x/draft/pub/p1/" + "e".repeat(32) + "/receipt.json", "{bad");
    expect(
      await contentReceipts(content).receiptsFor({ publicationId: "pub", postId: "p1" }),
    ).toEqual({ receipts: [], truncated: false });
  });
});
