import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { savedAssessments } from "../../src/dashboard/assessments.js";
import { assessmentViews } from "../../src/dashboard/assessment-views.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-assessments-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ref = (path: string, hashChar: string) => ({
  repository: "content",
  commit: "a".repeat(40),
  path,
  hash: `sha256:${hashChar.repeat(64)}`,
});

const record = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  state: "no-faults",
  findings: 0,
  deterministicFindings: [],
  body: ref("articles/pub/p1/article.md", "b"),
  publication: ref("publication-payloads/pub/p1/x.json", "c"),
  package: ref("writer-packages/pub/p1/p.json", "d"),
  source: ref("substack/pub/p1/collected.json", "e"),
  contextVersion: "ctx-1",
  assessor: { model: "fake/assessor", promptVersion: "verifier-article-assessor-sha256:" + "f".repeat(64) },
  assessedAt: "2026-01-02T00:00:00Z",
  ...over,
});

const writeAssessment = (pub: string, post: string, name: string, body: unknown) =>
  content.write(`assessments/${pub}/${post}/${name}.json`, JSON.stringify(body));

const render = async (patch: string) => {
  const views = assessmentViews(savedAssessments(content));
  const route = patch.split("?")[0]!;
  const view = views.find((v) => v.path === route)!;
  return view.render(new URL(`http://x${patch}`));
};

describe("assessments browser (#642)", { timeout: 60_000 }, () => {
  it("lists every attempt state with provenance and finding counts", async () => {
    await writeAssessment("pub", "p1", "1".repeat(32), record({ state: "no-faults" }));
    await writeAssessment(
      "pub",
      "p2",
      "2".repeat(32),
      record({
        state: "findings",
        findings: 2,
        deterministicFindings: [{ passage: "proves", reason: "overstated" }],
        assessor: { model: "fake/assessor-2", promptVersion: "p2" },
      }),
    );
    await writeAssessment("pub", "p3", "3".repeat(32), record({ state: "incomplete", findings: undefined }));
    await writeAssessment("pub", "p4", "4".repeat(32), record({ state: "malformed", findings: undefined }));
    // Provider failures use the producer's `<key>.failed/<attempt>.json` layout.
    await content.write(
      `assessments/pub/p5/${"5".repeat(32)}.failed/${"a".repeat(16)}.json`,
      JSON.stringify(record({ state: "provider-failed", findings: undefined })),
    );
    const listing = await savedAssessments(content).list({});
    expect(listing.rows.map((r) => r.state).sort()).toEqual([
      "findings",
      "incomplete",
      "malformed",
      "no-faults",
      "provider-failed",
    ]);
    expect(listing.rows.find((r) => r.postId === "p2")).toMatchObject({
      findings: 2,
      deterministicFindings: 1,
      assessorModel: "fake/assessor-2",
      hasDocument: false,
    });
    // A provider-failure record is listed and openable at its real path.
    const failed = listing.rows.find((r) => r.state === "provider-failed")!;
    expect(failed.path).toContain(".failed/");
    expect(await savedAssessments(content).detail(failed.path)).toMatchObject({
      row: { state: "provider-failed" },
    });
  });

  it("filters by state, post and text", async () => {
    await writeAssessment("pub", "p1", "1".repeat(32), record());
    await writeAssessment("pub", "p2", "2".repeat(32), record({ state: "findings", findings: 1 }));
    const port = savedAssessments(content);
    expect((await port.list({ state: "findings" })).rows.map((r) => r.postId)).toEqual(["p2"]);
    expect((await port.list({ post: "pub/p1" })).rows.map((r) => r.postId)).toEqual(["p1"]);
    expect((await port.list({ query: "assessor" })).rows).toHaveLength(2);
    expect((await port.list({ query: "nothing-matches" })).rows).toEqual([]);
  });

  it("shows the retained findings document and deterministic findings, escaped", async () => {
    const doc = await content.write(
      "assessments/pub/p1/document.md",
      "## Finding\n- Where: <script>x</script>\n\nEND OF ASSESSMENT",
    );
    await writeAssessment(
      "pub",
      "p1",
      "1".repeat(32),
      record({
        state: "findings",
        findings: 1,
        deterministicFindings: [{ passage: "<b>proves</b>", reason: "overstated" }],
        document: {
          repository: doc.repository,
          commit: doc.commit,
          path: doc.path,
          hash: `sha256:${doc.sha256}`,
        },
      }),
    );
    const html = await render("/assessments/view?path=" + encodeURIComponent(`assessments/pub/p1/${"1".repeat(32)}.json`));
    expect(html).toContain("fake/assessor");
    expect(html).toContain("overstated");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;proves&lt;/b&gt;");
    expect(html).toContain("END OF ASSESSMENT");
  });

  it("labels absence of a document and unreadable documents honestly", async () => {
    await writeAssessment("pub", "p1", "1".repeat(32), record());
    const path = `assessments/pub/p1/${"1".repeat(32)}.json`;
    expect(await render("/assessments/view?path=" + encodeURIComponent(path))).toContain(
      "No findings document was retained",
    );
    const saved = JSON.parse(await content.read((await content.lookup(path))!));
    saved.document = ref("assessments/pub/p1/missing.md", "9");
    await content.write(
      `assessments/pub/p2/${"2".repeat(32)}.json`,
      JSON.stringify({ ...saved }),
    );
    expect(
      await render("/assessments/view?path=" + encodeURIComponent(`assessments/pub/p2/${"2".repeat(32)}.json`)),
    ).toContain("could not be read");
  });

  it("reports unreadable records and never treats them as approval", async () => {
    await writeAssessment("pub", "p1", "1".repeat(32), record());
    await content.write("assessments/pub/p9/broken.json", "{not json");
    const listing = await savedAssessments(content).list({});
    expect(listing.unreadable).toBe(1);
    const html = await render("/assessments");
    expect(html).toContain("could not be read");
    expect(html).toContain("never approval");
  });

  it("reaches later records through bounded continuation", async () => {
    for (let i = 0; i < 22; i++) {
      await writeAssessment("pub", `p${i}`, `${String(i).padStart(2, "0")}${"0".repeat(30)}`, record());
    }
    const port = savedAssessments(content);
    const seen = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const page = await port.list(after ? { after } : {});
      for (const row of page.rows) {
        expect(seen.has(row.path)).toBe(false);
        seen.add(row.path);
      }
      if (!page.next) break;
      after = page.next;
    }
    expect(seen.size).toBe(22);
  });

  it("counts every visited artifact against a small scan limit", async () => {
    for (let i = 0; i < 4; i++) await content.write(`assessments/pub/p${i}/legacy.json`, "{}");
    const page = await savedAssessments(content, { scanLimit: 2 }).list({});
    expect(page.partial).toBe(true);
    expect(page.next).toBeDefined();
  });
});

describe("assessment document exact version (#642 follow-up)", { timeout: 60_000 }, () => {
  it("reads the recorded document version, not the current path", async () => {
    const doc = await content.write("assessments/pub/p1/pinned.md", "ORIGINAL FINDINGS");
    await writeAssessment(
      "pub",
      "p1",
      "7".repeat(32),
      record({
        state: "findings",
        findings: 1,
        document: {
          repository: doc.repository,
          commit: doc.commit,
          path: doc.path,
          hash: `sha256:${doc.sha256}`,
        },
      }),
    );
    // Simulate a store whose HEAD lookup cannot see this path: only the pinned
    // read can resolve the document.
    const pinnedOnly = {
      list: content.list.bind(content),
      // HEAD cannot see the document path; only the pinned read can.
      lookup: async (target: string) =>
        target === 'assessments/pub/p1/pinned.md' ? undefined : content.lookup(target),
      lookupAt: content.lookupAt.bind(content),
      read: content.read.bind(content),
    };
    const found = await savedAssessments(pinnedOnly as never).detail(
      `assessments/pub/p1/${"7".repeat(32)}.json`,
    );
    expect(found?.document).toBe("ORIGINAL FINDINGS");
    expect(found?.documentUnreadable).toBe(false);
  });

  it("refuses a document whose bytes no longer match the recorded hash", async () => {
    const doc = await content.write("assessments/pub/p2/pinned.md", "ORIGINAL");
    await writeAssessment(
      "pub",
      "p2",
      "8".repeat(32),
      record({
        document: {
          repository: doc.repository,
          commit: doc.commit,
          path: doc.path,
          hash: `sha256:${"0".repeat(64)}`,
        },
      }),
    );
    const found = await savedAssessments(content).detail(
      `assessments/pub/p2/${"8".repeat(32)}.json`,
    );
    expect(found?.document).toBeUndefined();
    expect(found?.documentUnreadable).toBe(true);
  });
});
