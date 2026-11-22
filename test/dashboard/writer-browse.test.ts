import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { queryCollection } from "../../src/dashboard/collection-query.js";
import { writerBrowseViews } from "../../src/dashboard/writer-browse-views.js";
import { writerCollection } from "../../src/dashboard/writer-collection.js";
import { draftFromPackage } from "../../src/drafting/package-draft.js";
import { saveWriterPackage } from "../../src/drafting/writer-package.js";
import { LexicalShortlister, assessPostCoverage } from "../../src/research/librarian.js";
import { CLAIMS, SHARED, TEXT, librarianFixtures } from "../research/librarian-fixtures.js";

let operations: OperationStore;
let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-writer-browse-"));
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
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
};

const GOOD = JSON.stringify({
  title: "A treaty already bans weather weapons",
  subtitle: "What the post claims",
  excerpt: "The treaty claim holds; the payment claim is unsupported.",
  summary: "The post makes two claims.",
  themes: ["Weather warfare"],
  responses: [
    {
      claimRecordId: "claim-treaty",
      verdict: "supported",
      text: "ENMOD prohibits it.",
      evidence: [0],
    },
    {
      claimRecordId: "claim-payment",
      verdict: "unresolved",
      text: "No record found.",
      evidence: [],
    },
  ],
  limitations: [],
  narrative: { status: "limited", limitation: "None compared." },
  widerContext: { status: "limited", limitation: "None used." },
});

/** A brief plus two retained attempts: one rejected (bad output), one accepted. */
async function writerRecords() {
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
  const pkg = (await saveWriterPackage({ content, coverage: coverage.ref })).ref;
  let calls = 0;
  const responses = ['<script>alert("raw")</script> not json', GOOD];
  await draftFromPackage({
    operations,
    content,
    archive,
    package: pkg,
    sourceUrl: "https://x/p",
    provider: {
      modelVersion: "fake/writer",
      complete: async () => responses[Math.min(calls++, 1)]!,
    },
  });
}

const render = async (path: string) => {
  const url = new URL(`https://d.test${path}`);
  return writerBrowseViews(content)
    .find((v) => v.path === url.pathname)!
    .render(url);
};

describe("writer records search (#623)", { timeout: 60_000 }, () => {
  it("lists briefs and attempts separately, with each attempt at its final outcome", async () => {
    await writerRecords();
    const briefs = await queryCollection(writerCollection(content), { filters: { kind: "brief" } });
    expect(briefs.rows).toHaveLength(1);
    expect(briefs.rows[0]).toMatchObject({ outcome: "ready", publicationId: "pub", postId: "p1" });
    const attempts = await queryCollection(writerCollection(content), {
      filters: { kind: "attempt" },
    });
    expect(attempts.rows.map((r) => r.outcome).sort()).toEqual(["accepted", "rejected"]);
    const rejected = await queryCollection(writerCollection(content), {
      filters: { kind: "attempt", outcome: "rejected" },
    });
    expect(rejected.rows).toHaveLength(1);
    expect(rejected.rows[0]).toMatchObject({ attempt: { hasDiagnostic: true } });
  });

  it("never puts raw output in the list, and escapes it on the private attempt page", async () => {
    await writerRecords();
    const listHtml = await render("/writer/search");
    expect(listHtml).not.toContain("alert(");
    const rejected = await queryCollection(writerCollection(content), {
      filters: { kind: "attempt", outcome: "rejected" },
    });
    const detail = await render(`/writer/attempt?id=${rejected.rows[0]!.id}`);
    expect(detail).toContain("&lt;script&gt;alert(");
    expect(detail).not.toContain("<script>alert");
    expect(detail).toContain("writer-packages/pub/p1/");
    // Unknown IDs never reach the store.
    expect(await render("/writer/attempt?id=../../etc")).toContain("Choose an attempt");
  });

  it("pages through attempts by stored order without repeats and refuses unknown filters", async () => {
    await writerRecords();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await queryCollection(writerCollection(content), {
        filters: { kind: "attempt" },
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.next;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    expect(await render("/writer/search?f.__proto__=x")).toContain("not valid");
  });

  it("distinguishes an empty archive from an unavailable one", async () => {
    expect(await render("/writer/search")).toContain("No matching attempts");
    const broken = {
      list: async () => {
        throw new Error("git");
      },
      lookup: async () => undefined,
      read: async () => "",
    };
    const html = await writerBrowseViews(broken as never)[0]!.render(
      new URL("https://d.test/writer/search"),
    );
    expect(html).toContain("unavailable");
  });
});
