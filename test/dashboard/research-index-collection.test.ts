import { describe, expect, it } from "vite-plus/test";
import { queryCollection } from "../../src/dashboard/collection-query.js";
import { researchIndexAdapter } from "../../src/dashboard/research-index-collection.js";

const doc = (path: string, title: string, over: Record<string, unknown> = {}) => ({
  id: `doc-${path}`,
  sort: [path],
  source: {
    kind: "research-report",
    path,
    title,
    artifactRepository: "content",
    artifactCommit: "a".repeat(40),
    artifactHash: `sha256:${"b".repeat(64)}`,
    ...over,
  },
});

function searchWith(hits: unknown[], fail = false) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    port: {
      search: async (_index: string, query: unknown, options: Record<string, unknown>) => {
        calls.push({ query, ...options });
        if (fail) throw new Error("index down");
        return hits;
      },
    },
  };
}

describe("indexed research browser (#620)", () => {
  it("carries the exact indexed artifact and searches title and text", async () => {
    const { port, calls } = searchWith([doc("research-reports/a.md", "A report")]);
    const page = await queryCollection(researchIndexAdapter(port as never), { text: "masts" });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      summary: "A report",
      artifact: {
        repository: "content",
        commit: "a".repeat(40),
        path: "research-reports/a.md",
        hash: `sha256:${"b".repeat(64)}`,
      },
    });
    expect(JSON.stringify(calls[0]!.query)).toContain("multi_match");
  });

  it("passes kind and job filters as terms", async () => {
    const { port, calls } = searchWith([]);
    await queryCollection(researchIndexAdapter(port as never), {
      filters: { kind: "dossier", jobId: `research-${"c".repeat(32)}` },
    });
    const serialised = JSON.stringify(calls[0]);
    expect(serialised).toContain("dossier");
    expect(serialised).toContain(`research-${"c".repeat(32)}`);
  });

  it("hides a document whose artifact reference is incomplete", async () => {
    const { port } = searchWith([
      doc("research-reports/a.md", "A report", { artifactHash: undefined }),
      doc("research-reports/b.md", "B report"),
    ]);
    const page = await queryCollection(researchIndexAdapter(port as never), {});
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.summary).toBe("B report");
    expect(page.limitations.join(" ")).toMatch(/lack an artifact reference/);
  });

  it("continues with search_after and reports an index outage honestly", async () => {
    const { port, calls } = searchWith([doc("research-reports/a.md", "A")]);
    const page = await queryCollection(researchIndexAdapter(port as never), { limit: 1 });
    expect(page.next).toBe("research-reports/a.md");
    await queryCollection(researchIndexAdapter(port as never), { limit: 1, cursor: page.next });
    expect(calls[1]!.searchAfter).toEqual(["research-reports/a.md"]);

    const down = searchWith([], true);
    const outage = await queryCollection(researchIndexAdapter(down.port as never), {});
    expect(outage.rows).toEqual([]);
    expect(outage.limitations.join(" ")).toMatch(/unavailable/);
  });

  it("advertises only the stable sort it implements", () => {
    const { port } = searchWith([]);
    expect(researchIndexAdapter(port as never).sorts).toEqual(["path"]);
  });
});
