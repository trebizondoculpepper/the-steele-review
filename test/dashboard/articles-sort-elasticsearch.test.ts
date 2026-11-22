import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { ElasticsearchController } from "../../src/controllers/elasticsearch.js";
import {
  FULLTEXT_INDEX_MAPPING,
  createFulltextDocument,
  fulltextDocumentId,
} from "../../src/content/fulltext-document.js";
import { indexArticles } from "../../src/dashboard/adapters.js";
import { articleViews } from "../../src/dashboard/article-views.js";

/**
 * Articles paging against a real Elasticsearch (#721): a fake search port did
 * not catch that Elasticsearch rejects an ISO-text missing-date sentinel.
 * Synthetic documents only.
 */
const INDEX = "steele-sort-regression";
let container: StartedTestContainer;
let es: ElasticsearchController;

const doc = (postId: string, publishedAt?: string) =>
  createFulltextDocument(
    {
      item: {
        publicationId: "example-pub",
        postId,
        url: `https://example-pub.substack.com/p/${postId}`,
        title: `Synthetic ${postId}`,
        ...(publishedAt ? { publishedAt } : {}),
      },
      text: `Synthetic retained text for ${postId}.`,
      acquisitionOrigin: "transcript",
      artifact: {
        repository: "test-archive",
        commit: "a".repeat(40),
        path: `substack/example-pub/${postId}/collected.json`,
        hash: `sha256:${"b".repeat(64)}`,
      },
      sourceRetrievedAt: "2026-01-03T00:00:00Z",
    },
    () => new Date("2026-01-04T00:00:00Z"),
  );

const DATED = [
  ["d1", "2026-01-01T00:00:00Z"],
  ["d2", "2026-02-01T00:00:00Z"],
  ["d3", "2026-03-01T00:00:00Z"],
] as const;
const UNDATED = ["u1", "u2", "u3"];

beforeAll(async () => {
  container = await new GenericContainer("docker.elastic.co/elasticsearch/elasticsearch:8.19.2")
    .withEnvironment({
      "discovery.type": "single-node",
      "xpack.security.enabled": "false",
      ES_JAVA_OPTS: "-Xms512m -Xmx512m",
    })
    .withExposedPorts(9200)
    .withWaitStrategy(Wait.forHttp("/_cluster/health?wait_for_status=yellow", 9200))
    .withStartupTimeout(180_000)
    .start();
  es = new ElasticsearchController(
    `http://${container.getHost()}:${container.getMappedPort(9200)}`,
  );
  await es.provisionIndex(INDEX, FULLTEXT_INDEX_MAPPING);
  for (const [postId, at] of DATED) {
    const d = doc(postId, at);
    await es.indexDocument(INDEX, fulltextDocumentId(d), d, { refresh: true });
  }
  for (const postId of UNDATED) {
    const d = doc(postId);
    await es.indexDocument(INDEX, fulltextDocumentId(d), d, { refresh: true });
  }
}, 240_000);
afterAll(async () => {
  await es?.close();
  await container?.stop();
});

/** Walk every page of size `limit`, following the JSON cursor. */
async function walk(sort: "newest" | "oldest", limit: number) {
  const port = indexArticles(es, INDEX);
  const seen: string[] = [];
  let after: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await port.page!({ sort, limit, ...(after ? { after } : {}) });
    seen.push(...page.entries.map((e) => e.postId));
    if (!page.next) break;
    after = page.next;
  }
  return seen;
}

describe("Articles date sort on real Elasticsearch (#721)", () => {
  it("orders newest first with undated articles last, across every page size", async () => {
    for (const limit of [1, 2, 4, 25]) {
      expect(await walk("newest", limit)).toEqual(["d3", "d2", "d1", "u1", "u2", "u3"]);
    }
  });

  it("orders oldest first with undated articles last, across every page size", async () => {
    for (const limit of [1, 2, 4, 25]) {
      expect(await walk("oldest", limit)).toEqual(["d1", "d2", "d3", "u1", "u2", "u3"]);
    }
  });

  it("keeps the publication filter and text search working", async () => {
    const port = indexArticles(es, INDEX);
    const filtered = await port.page!({ sort: "newest", limit: 25, publicationId: "other-pub" });
    expect(filtered.entries).toEqual([]);
    const text = await port.page!({ sort: "newest", limit: 25, query: "u2" });
    expect(text.entries.map((e) => e.postId)).toEqual(["u2"]);
  });

  it("renders the Articles view from the real adapter", async () => {
    const views = articleViews({ articles: indexArticles(es, INDEX) } as never);
    const list = views.find((v) => v.path === "/articles")!;
    const html = await list.render(new URL("http://x/articles"));
    expect(html).toContain("Synthetic d3");
    // An oldest-first page with undated articles renders too.
    const oldest = await list.render(new URL("http://x/articles?sort=oldest"));
    expect(oldest).toContain("Synthetic u1");
  });
});
