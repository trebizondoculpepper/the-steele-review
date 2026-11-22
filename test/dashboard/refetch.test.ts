import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { collectionArtifactPath, reingestKey } from "../../src/collection/collection-store.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { refetchAction, refetchState, refetchView } from "../../src/dashboard/refetch.js";

const text = "Synthetic captured post.";
const revision = sourceVersionFor(text);
const artifact = {
  repository: "archive",
  commit: "a".repeat(40),
  path: collectionArtifactPath({ publicationId: "pub", postId: "post" }),
  sha256: "b".repeat(64),
};
const item = {
  publicationId: "pub",
  postId: "post",
  title: "Synthetic post",
  url: "https://example.test/post",
};
const record = () => ({
  item,
  ingestionReason: "backfill" as const,
  text,
  complete: true,
  supplied: {},
  provenance: {
    sourceUrl: "https://example.test/post",
    acquiredAt: "2026-01-01T00:00:00Z",
    method: "text",
  },
});

let dir: string;
let operations: OperationStore;
let current: ReturnType<typeof record> | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-refetch-"));
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
  current = record();
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

function setup() {
  const archive = {
    lookup: async () => (current ? artifact : undefined),
    read: async () => JSON.stringify(current),
  };
  const deps = { archive, operations };
  return {
    view: refetchView(deps),
    action: refetchAction(deps),
  };
}

const form = (overrides: Record<string, string> = {}) =>
  new URLSearchParams({
    publication: "pub",
    post: "post",
    request: `console-refetch-${"0".repeat(8)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(12)}`,
    confirm: "yes",
    ...overrides,
  });

const statusUrl = (request: string) =>
  `/articles/refetch?publication=pub&post=post&request=${encodeURIComponent(request)}`;

describe("console re-fetch (#770)", () => {
  it("offers the action and shows the current captured revision without requesting", async () => {
    const { view } = setup();
    const html = await view.render(
      new URL("https://example.test/articles/refetch?publication=pub&post=post"),
    );
    expect(html).toContain(revision);
    expect(html).toContain('method="post" action="/articles/refetch"');
    expect(html).toContain("console-refetch-");
    expect(operations.listOperations("reingest:")).toHaveLength(0);
  });

  it("records the typed reingestion request and redirects to its status", async () => {
    const { action } = setup();
    const token = form().get("request")!;
    expect(await action.submit(form())).toEqual({ status: 303, location: statusUrl(token) });
    const key = reingestKey(item, token);
    expect(operations.operationStatus(key)?.status).toBe("released");
  });

  it("deduplicates resubmission of the same request", async () => {
    const { action } = setup();
    await action.submit(form());
    await action.submit(form());
    expect(operations.listOperations("reingest:substack/pub/post/")).toHaveLength(1);
  });

  it("attaches a different request to the one already in flight", async () => {
    const { action } = setup();
    const first = form().get("request")!;
    await action.submit(form());
    const other = `console-refetch-${"1".repeat(8)}-${"1".repeat(4)}-${"1".repeat(4)}-${"1".repeat(4)}-${"1".repeat(12)}`;
    const result = await action.submit(form({ request: other }));
    expect(result).toEqual({ status: 303, location: statusUrl(first) });
    expect(operations.listOperations("reingest:substack/pub/post/")).toHaveLength(1);
  });

  it("reports completion and whether the captured version came from that request", async () => {
    const { view, action } = setup();
    const token = form().get("request")!;
    await action.submit(form());

    // The collector claims and completes the request, revising the capture.
    const key = reingestKey(item, token);
    const claim = operations.claim(key, "collector", 60_000, 5);
    if (claim.kind !== "claimed") throw new Error("not claimed");
    operations.complete(claim.claim, {}, []);
    current = {
      ...record(),
      text: "Refreshed synthetic text.",
      reingestion: { requestId: token },
    };

    const html = await view.render(
      new URL(`https://example.test${statusUrl(token)}`),
    );
    expect(html).toContain(token);
    expect(html).toContain("Status: <strong>completed</strong>");
    expect(html).toContain("The collector captured this request's version.");
    expect(html).toContain(sourceVersionFor("Refreshed synthetic text."));
    expect(html).toContain("Yes — this is the captured version");
  });

  it("does not claim a completed request produced the current capture", async () => {
    const { view, action } = setup();
    const token = form().get("request")!;
    await action.submit(form());
    const key = reingestKey(item, token);
    const claim = operations.claim(key, "collector", 60_000, 5);
    if (claim.kind !== "claimed") throw new Error("not claimed");
    operations.complete(claim.claim, {}, []);

    const html = await view.render(new URL(`https://example.test${statusUrl(token)}`));
    expect(html).toContain("does not carry this request");
    expect(html).toContain("Not the current captured version");
  });

  it("refuses an invalid or unconfirmed submission and a missing capture", async () => {
    const { action } = setup();
    expect((await action.submit(form({ confirm: "no" }))).status).toBe(400);
    expect((await action.submit(form({ request: "nope" }))).status).toBe(400);
    expect((await action.submit(form({ publication: "../etc" }))).status).toBe(400);
    current = undefined;
    expect((await action.submit(form())).status).toBe(409);
  });
});

describe("re-fetch status mapping", () => {
  it("maps stored operation states to operator-facing states", () => {
    expect(refetchState("released")).toBe("accepted");
    expect(refetchState("claimed")).toBe("running");
    expect(refetchState("completed")).toBe("completed");
    expect(refetchState("failed")).toBe("failed");
  });
});
