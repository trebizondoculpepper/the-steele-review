import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { savedJudgments } from "../../src/dashboard/judgments.js";
import { judgmentViews } from "../../src/dashboard/judgment-views.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-judgments-"));
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
  decision: "approve",
  state: "decided",
  gates: [],
  assessment: ref("assessments/pub/p1/x.json", "1"),
  body: ref("articles/pub/p1/article.md", "2"),
  publication: ref("publication-payloads/pub/p1/x.json", "3"),
  judge: { model: "fake/judge", promptVersion: "verifier-editorial-judge-sha256:" + "f".repeat(64) },
  decidedAt: "2026-01-03T00:00:00Z",
  ...over,
});

const writeJudgment = (pub: string, post: string, name: string, body: unknown) =>
  content.write(`judgments/${pub}/${post}/${name}.json`, JSON.stringify(body));

const judgementDoc = (decision: "APPROVE" | "REVISE", corrections: string) =>
  `## Reasons\nThe evidence was assessed carefully and the article reports it fairly.\n\n## Required corrections\n${corrections}\n\n## Accepted minor observations\nNone.\n\nDECISION: ${decision}`;

const render = async (patch: string) => {
  const views = judgmentViews(savedJudgments(content));
  const route = patch.split("?")[0]!;
  const view = views.find((v) => v.path === route)!;
  return view.render(new URL(`http://x${patch}`));
};

describe("judgments browser (#643)", { timeout: 60_000 }, () => {
  it("lists decisions, states and gate counts with provenance", async () => {
    await writeJudgment("pub", "p1", "1".repeat(32), record());
    await writeJudgment(
      "pub",
      "p2",
      "2".repeat(32),
      record({
        decision: "revise",
        state: "decided",
        judge: { model: "fake/judge-2", promptVersion: "p2" },
      }),
    );
    await writeJudgment(
      "pub",
      "p3",
      "3".repeat(32),
      record({ decision: "none", state: "gated", gates: ["assessment-malformed"] }),
    );
    await content.write(
      `judgments/pub/p4/${"4".repeat(32)}.failed/${"a".repeat(16)}.json`,
      JSON.stringify(record({ decision: "none", state: "provider-failed" })),
    );
    const listing = await savedJudgments(content).list({});
    expect(listing.rows.map((r) => r.state).sort()).toEqual([
      "decided",
      "decided",
      "gated",
      "provider-failed",
    ]);
    expect(listing.rows.find((r) => r.postId === "p2")).toMatchObject({
      decision: "revise",
      judgeModel: "fake/judge-2",
    });
    expect(listing.rows.find((r) => r.state === "gated")).toMatchObject({
      decision: "none",
      gateCount: 1,
    });
    const failed = listing.rows.find((r) => r.state === "provider-failed")!;
    expect(failed.path).toContain(".failed/");
    expect(await savedJudgments(content).detail(failed.path)).toMatchObject({
      row: { state: "provider-failed" },
    });
  });

  it("filters by state, decision, post and text", async () => {
    await writeJudgment("pub", "p1", "1".repeat(32), record());
    await writeJudgment("pub", "p2", "2".repeat(32), record({ decision: "revise" }));
    const port = savedJudgments(content);
    expect((await port.list({ state: "decided" })).rows).toHaveLength(2);
    expect((await port.list({ decision: "revise" })).rows.map((r) => r.postId)).toEqual(["p2"]);
    expect((await port.list({ post: "pub/p1" })).rows.map((r) => r.postId)).toEqual(["p1"]);
    expect((await port.list({ query: "fake/judge" })).rows).toHaveLength(2);
    expect((await port.list({ query: "nothing" })).rows).toEqual([]);
  });

  it("shows the requested corrections and reasons from the retained judgement", async () => {
    const doc = await content.write(
      "judgments/pub/p1/document.md",
      judgementDoc("REVISE", "Remove the unsupported claim about funding."),
    );
    await writeJudgment(
      "pub",
      "p1",
      "1".repeat(32),
      record({
        decision: "revise",
        document: {
          repository: doc.repository,
          commit: doc.commit,
          path: doc.path,
          hash: `sha256:${doc.sha256}`,
        },
      }),
    );
    const path = `judgments/pub/p1/${"1".repeat(32)}.json`;
    const detail = await savedJudgments(content).detail(path);
    expect(detail?.guidance).toMatchObject({
      decision: "revise",
      requiredCorrections: "Remove the unsupported claim about funding.",
      acceptedMinorObservations: "None.",
    });
    const html = await render("/judgments/view?path=" + encodeURIComponent(path));
    expect(html).toContain("Remove the unsupported claim about funding.");
    expect(html).toContain("Required corrections");
    expect(html).toContain("fake/judge");
  });

  it("shows gate reasons, and a malformed document is not treated as guidance", async () => {
    const doc = await content.write(
      "judgments/pub/p1/broken.md",
      "## Reasons\n<script>alert(1)</script>\n\nDECISION: APPROVE",
    );
    await writeJudgment(
      "pub",
      "p2",
      "2".repeat(32),
      record({
        decision: "none",
        state: "gated",
        gates: ["publication-unreadable", "assessment-malformed"],
        document: {
          repository: doc.repository,
          commit: doc.commit,
          path: doc.path,
          hash: `sha256:${doc.sha256}`,
        },
      }),
    );
    const path = `judgments/pub/p2/${"2".repeat(32)}.json`;
    const html = await render("/judgments/view?path=" + encodeURIComponent(path));
    expect(html).toContain("publication-unreadable");
    expect(html).toContain("assessment-malformed");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    // No complete guidance sections: the raw retained document is shown instead.
    expect(html).toContain("Retained judgment document");
    expect(html).not.toContain("Required corrections</h2>");
  });

  it("labels missing documents and unreadable records honestly", async () => {
    await writeJudgment("pub", "p1", "1".repeat(32), record());
    const path = `judgments/pub/p1/${"1".repeat(32)}.json`;
    expect(await render("/judgments/view?path=" + encodeURIComponent(path))).toContain(
      "No judgment document was retained",
    );
    await content.write("judgments/pub/p9/broken.json", "{not json");
    const listing = await savedJudgments(content).list({});
    expect(listing.unreadable).toBe(1);
    expect(await render("/judgments")).toContain("could not be read");
  });

  it("reaches later records through bounded continuation", async () => {
    for (let i = 0; i < 22; i++) {
      await writeJudgment("pub", `p${i}`, `${String(i).padStart(2, "0")}${"0".repeat(30)}`, record());
    }
    const port = savedJudgments(content);
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
    for (let i = 0; i < 4; i++) await content.write(`judgments/pub/p${i}/legacy.json`, "{}");
    const page = await savedJudgments(content, { scanLimit: 2 }).list({});
    expect(page.partial).toBe(true);
    expect(page.next).toBeDefined();
  });
});
