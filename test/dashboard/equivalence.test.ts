import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { savedEquivalence } from "../../src/dashboard/equivalence.js";
import { equivalenceViews } from "../../src/dashboard/equivalence-views.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-equivalence-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const decision = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  record: `claim-${"a".repeat(32)}`,
  statement: "A treaty bans weather weapons.",
  candidates: [{ id: `claim-${"b".repeat(32)}`, statement: "Weather weapons are banned by treaty." }],
  match: null,
  confidence: null,
  reason: "Different scope: one names a treaty, the other states a general ban.",
  modelVersion: "fake/equivalence",
  promptVersion: "claim-equivalence-v1",
  decidedAt: "2026-01-02T00:00:00Z",
  ...over,
});

const writeDecision = (name: string, body: unknown) =>
  content.write(`claim-equivalence/${name}.json`, JSON.stringify(body));

const render = async (path: string) => {
  const views = equivalenceViews(savedEquivalence(content));
  const route = path.split("?")[0]!;
  const view = views.find((v) => v.path === route)!;
  return view.render(new URL(`http://x${path}`));
};

describe("claim-equivalence browser (#616)", { timeout: 60_000 }, () => {
  it("lists saved equivalent and separate decisions with their reasons", async () => {
    await writeDecision(`claim-${"a".repeat(32)}-${"1".repeat(16)}`, decision());
    await writeDecision(`claim-${"c".repeat(32)}-${"2".repeat(16)}`, {
      ...decision({
        record: `claim-${"c".repeat(32)}`,
        statement: "Masts cause illness.",
        match: `claim-${"d".repeat(32)}`,
        confidence: "high",
        reason: "Same assertion with different wording.",
      }),
    });
    const listing = await savedEquivalence(content).list({});
    expect(listing.state).toBe("ok");
    expect(listing.rows.map((r) => r.outcome).sort()).toEqual(["equivalent", "separate"]);
    const separate = listing.rows.find((r) => r.outcome === "separate")!;
    expect(separate).toMatchObject({
      statement: "A treaty bans weather weapons.",
      match: null,
      confidence: null,
      modelVersion: "fake/equivalence",
      promptVersion: "claim-equivalence-v1",
    });
    expect(separate.candidates[0]!.statement).toContain("banned by treaty");
  });

  it("filters by outcome and text, and reports partial scans", async () => {
    await writeDecision(`claim-${"a".repeat(32)}-${"1".repeat(16)}`, decision());
    await writeDecision(`claim-${"c".repeat(32)}-${"2".repeat(16)}`, {
      ...decision({
        record: `claim-${"c".repeat(32)}`,
        statement: "Masts cause illness.",
        match: `claim-${"d".repeat(32)}`,
        confidence: "high",
        reason: "Same assertion with different wording.",
      }),
    });
    await content.write("claim-equivalence/broken.json", "{not json");
    const port = savedEquivalence(content);
    expect((await port.list({ outcome: "equivalent" })).rows).toHaveLength(1);
    expect((await port.list({ query: "different scope" })).rows).toHaveLength(1);
    const all = await port.list({});
    expect(all.unreadable).toBe(1);
  });

  it("shows the exact saved decision, reason and provenance", async () => {
    const hex = "a".repeat(32);
    await writeDecision(`claim-${hex}-${"1".repeat(16)}`, decision());
    const path = `claim-equivalence/claim-${hex}-${"1".repeat(16)}.json`;
    const detail = await savedEquivalence(content).detail(path);
    expect(detail?.row.reason).toContain("Different scope");
    expect(detail?.occurrences).toEqual([]);

    const html = await render(`/equivalence/view?path=${encodeURIComponent(path)}`);
    expect(html).toContain("A treaty bans weather weapons.");
    expect(html).toContain("Different scope");
    expect(html).toContain("fake/equivalence");
    expect(html).toContain("kept separate (no match recorded)");
    expect(html).toContain("no new comparison is run");
  });

  it("escapes untrusted statements and reasons", async () => {
    await writeDecision(`claim-${"a".repeat(32)}-${"1".repeat(16)}`, {
      ...decision({
        statement: "<script>alert(1)</script>",
        reason: "<b>because</b>",
      }),
    });
    const listing = await render("/equivalence");
    expect(listing).toContain("&lt;script&gt;");
    expect(listing).not.toContain("<script>");
    const path = `claim-equivalence/claim-${"a".repeat(32)}-${"1".repeat(16)}.json`;
    const html = await render(`/equivalence/view?path=${encodeURIComponent(path)}`);
    expect(html).toContain("&lt;b&gt;because&lt;/b&gt;");
    expect(html).not.toContain("<b>because</b>");
  });

  it("rejects unknown or foreign paths", async () => {
    expect(await savedEquivalence(content).detail("claims/claim-x.json")).toBeUndefined();
    expect(await render("/equivalence/view?path=../etc/passwd")).toContain(
      "Choose a saved decision",
    );
  });

  it("reaches later records with bounded continuation", async () => {
    for (let i = 0; i < 22; i++) {
      await writeDecision(
        `claim-${String(i).padStart(2, "0").repeat(16)}-${"1".repeat(16)}`,
        decision({ record: `claim-${String(i).padStart(2, "0").repeat(16)}` }),
      );
    }
    const port = savedEquivalence(content);
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
});

describe("equivalence scan budget (#616)", () => {
  it("counts every visited artifact and exposes continuation", async () => {
    // Unexpectedly named files still consume the scan budget.
    for (let i = 0; i < 4; i++) {
      await content.write(`claim-equivalence/legacy-${i}.json`, "{}");
    }
    await content.write("claim-equivalence/notes.txt", "not a decision");
    await writeDecision(
      `claim-${"a".repeat(32)}-${"1".repeat(16)}`,
      decision(),
    );
    const port = savedEquivalence(content, { scanLimit: 3 });
    const page = await port.list({});
    expect(page.partial).toBe(true);
    expect(page.next).toBeDefined();
    // The decision sorts first and is returned; the budget stops further work.
    expect(page.rows).toHaveLength(1);
    expect(page.unreadable).toBeLessThanOrEqual(2);
  });
});

describe("legacy occurrence visibility (#673)", { timeout: 60_000 }, () => {
  it("keeps occurrences without a saved passage alongside readable ones", async () => {
    const id = `claim-${"a".repeat(32)}`;
    await content.revise(
      `claims/${id}.json`,
      JSON.stringify({
        id,
        statement: "A treaty bans weather weapons.",
        occurrences: [
          { publicationId: "pub", postId: "p1", occurrenceId: "sha256:" + "1".repeat(64) },
          {
            publicationId: "pub",
            postId: "p2",
            passage: "The treaty bans weather weapons.",
            occurrenceId: "sha256:" + "2".repeat(64),
          },
        ],
      }),
      null,
    );
    const path = `claim-equivalence/${id}-${"1".repeat(16)}.json`;
    await writeDecision(
      `${id}-${"1".repeat(16)}`,
      decision({ record: id }),
    );
    const detail = await savedEquivalence(content).detail(path);
    expect(detail?.occurrences).toHaveLength(2);
    expect(detail?.occurrencesPartial).toBe(false);
    expect(detail?.occurrences[0]).toMatchObject({ postId: "p1" });
    expect(detail?.occurrences[0]!.passage).toBeUndefined();
    expect(detail?.occurrences[1]).toMatchObject({
      postId: "p2",
      passage: "The treaty bans weather weapons.",
    });
    const html = await render("/equivalence/view?path=" + encodeURIComponent(path));
    expect(html).toContain("passage not recorded");
    expect(html).toContain("The treaty bans weather weapons.");
    expect(html).not.toContain("Some occurrences could not be read");
  });
});
