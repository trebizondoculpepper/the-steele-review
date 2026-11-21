import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { ARTICLE_APPROVED_SUBJECT } from "../../src/events/article-approved-event.js";
import {
  DestinationUnavailableError,
  UncertainDeliveryError,
  handleApprovedArticle,
  recordApproval,
} from "../../src/publishing/approved-article.js";
import {
  SubstackClient,
  SubstackError,
  type SubstackDraft,
} from "../../src/publishing/substack/client.js";
import { SubstackDraftDestination } from "../../src/publishing/substack/destination.js";
import {
  UnsupportedMarkdownError,
  bodyFingerprint,
  markdownToProseMirror,
} from "../../src/publishing/substack/prosemirror.js";
import { approvedReport } from "./approval-fixtures.js";

const WRITER_MARKDOWN = `The post claims a treaty bans weather weapons.

<!-- claim-verdict 636c61696d supported -->

The ENMOD Convention does prohibit hostile environmental modification. [1]

> "The treaty bans weather weapons." (2023-05-01, https://pub.example.com/p/earlier)

_Comparison (repetition, low uncertainty; analysis, not evidence): The same claim._

## Sources

Original post: [The \\[weather\\] post](<https://pub.example.com/p/p1>)

1. https://treaties.un.org/enmod (archived abc123:x.json): "Article I text"
`;

describe("Markdown to Substack ProseMirror (#385)", () => {
  it("converts the writer's format, dropping machine markers", () => {
    const doc = markdownToProseMirror(WRITER_MARKDOWN);
    expect(doc.content.map((n) => n.type)).toEqual([
      "paragraph",
      "paragraph",
      "blockquote",
      "paragraph",
      "heading",
      "paragraph",
      "ordered_list",
    ]);
    const json = JSON.stringify(doc);
    expect(json).not.toContain("claim-verdict");
    expect(json).toContain("modification. [1]");
    expect(json).toContain('{"type":"link","attrs":{"href":"https://pub.example.com/p/p1"}}');
    expect(json).toContain('"text":"The [weather] post"');
    expect(json).toContain('{"type":"em"}');
    expect(json).toContain('"href":"https://treaties.un.org/enmod"');
  });

  it("keeps balanced parentheses in bare evidence URLs", () => {
    const json = JSON.stringify(
      markdownToProseMirror(
        '1. https://example.org/report_(2026): "Passage" (see https://a.example/x).',
      ),
    );
    expect(json).toContain('"href":"https://example.org/report_(2026)"');
    expect(json).toContain('"href":"https://a.example/x"');
    const explicit = JSON.stringify(
      markdownToProseMirror("See [the report](https://example.org/report_(2026)) now."),
    );
    expect(explicit).toContain('"href":"https://example.org/report_(2026)"');
    expect(explicit).toContain('"text":" now."');
  });

  it("fails on HTML and non-https links rather than creating a malformed draft", () => {
    for (const bad of [
      "<div>x</div>",
      "Hello <script>alert(1)</script>",
      "[x](http://plain.example/)",
      "[x](javascript:alert(1))",
      "```\ncode\n```",
      "# \n\nText",
      "#### Too deep",
    ]) {
      expect(() => markdownToProseMirror(bad), bad).toThrow(UnsupportedMarkdownError);
    }
  });

  it("fingerprints visible text and links, not attribute order", () => {
    const doc = markdownToProseMirror("Hello [there](<https://a.example/>).");
    // The same document with mark keys in a different order.
    const reordered = JSON.parse(JSON.stringify(doc), (_k, v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v) && (v as { type?: unknown }).type === "link"
        ? { attrs: (v as { attrs: unknown }).attrs, type: "link" }
        : v,
    );
    expect(bodyFingerprint(reordered)).toBe(bodyFingerprint(doc));
    expect(bodyFingerprint(markdownToProseMirror("Hello there."))).not.toBe(bodyFingerprint(doc));
  });
});

// ---------------------------------------------------------------------------

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: URL | string, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ORIGIN = "https://example-pub.substack.com";
const client = (f: typeof fetch, session = "s3cret-cookie") =>
  new SubstackClient({ origin: ORIGIN, session: async () => session, fetch: f, timeoutMs: 2_000 });
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof SubstackError ? e.code : String(e)),
  );

describe("Substack client (#385)", () => {
  it("includes the required byline array without inventing an author", async () => {
    const { f, calls } = fakeFetch(({ init }) => {
      const draft = JSON.parse(String(init.body));
      return Array.isArray(draft.draft_bylines)
        ? json({ id: 123 })
        : json({ errors: [{ path: "draft_bylines", msg: "Invalid value" }] }, 400);
    });
    await expect(
      client(f).createDraft({ title: "Connection test", body: { type: "doc", content: [] } }),
    ).resolves.toEqual({ id: "123" });
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.draft_bylines).toEqual([]);
    expect(sent).not.toHaveProperty("send_email");
  });

  it("uses the draft filter for access checks and every reconciliation page", async () => {
    const { f, calls } = fakeFetch(({ url }) => {
      const query = new URL(url).searchParams;
      return query.get("filter") === "draft" ? json([]) : json({ error: "filter-required" }, 400);
    });
    const api = client(f);
    await expect(api.listDrafts({ limit: 1 })).resolves.toEqual([]);
    await expect(api.listDrafts({ limit: 25, offset: 25 })).resolves.toEqual([]);
    expect(calls.map(({ url }) => new URL(url).searchParams.get("offset"))).toEqual(["0", "25"]);
    expect(calls.every(({ init }) => init.method === "GET")).toBe(true);
  });

  it("sends the cookie only to the configured origin, never following redirects", async () => {
    const { f, calls } = fakeFetch(() => json([]));
    await client(f).listDrafts({ limit: 5 });
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/v1/drafts?filter=draft&limit=5&offset=0`);
    expect(calls[0]!.init.redirect).toBe("manual");
    expect((calls[0]!.init.headers as Record<string, string>).cookie).toBe(
      "substack.sid=s3cret-cookie",
    );
    expect(
      () => new SubstackClient({ origin: "http://x.substack.com", session: async () => "s" }),
    ).toThrow();
    expect(
      () => new SubstackClient({ origin: `${ORIGIN}/p/x`, session: async () => "s" }),
    ).toThrow();
  });

  it("maps auth, redirects, rate limits and outages, and keeps secrets out of errors", async () => {
    const status = (s: number) =>
      fakeFetch(() => new Response("body with s3cret-cookie", { status: s })).f;
    expect(await code(client(status(401)).listDrafts({ limit: 1 }))).toBe("auth-expired");
    expect(await code(client(status(302)).listDrafts({ limit: 1 }))).toBe("auth-expired");
    expect(await code(client(status(429)).listDrafts({ limit: 1 }))).toBe("rate-limited");
    expect(await code(client(status(503)).listDrafts({ limit: 1 }))).toBe("unavailable");
    // A create whose outcome is unknown is uncertain, never a plain failure.
    expect(await code(client(status(503)).createDraft({ title: "t", body: {} }))).toBe("uncertain");
    const network = fakeFetch(() => Promise.reject(new Error("socket hang up"))).f;
    expect(await code(client(network).createDraft({ title: "t", body: {} }))).toBe("uncertain");
    expect(await code(client(network).listDrafts({ limit: 1 }))).toBe("unavailable");
    expect(
      await code(client(fakeFetch(() => json({})).f).createDraft({ title: "t", body: {} })),
    ).toBe("uncertain");
    expect(await code(client(fakeFetch(() => json([])).f, "").listDrafts({ limit: 1 }))).toBe(
      "auth-expired",
    );
    const error = await client(status(401))
      .listDrafts({ limit: 1 })
      .catch((e: Error) => e);
    expect(String((error as Error).message)).not.toMatch(/s3cret|substack\.com/);
  });
});

// ---------------------------------------------------------------------------

/** An in-memory Substack: drafts with creation times, and scripted faults. */
function fakeSubstack() {
  const drafts: SubstackDraft[] = [];
  let next = 100;
  const faults: {
    list?: SubstackError[];
    create?: Array<SubstackError | "lost">;
    get?: SubstackError[];
  } = {};
  const api = {
    drafts,
    faults,
    async listDrafts({ limit, offset = 0 }: { limit: number; offset?: number }) {
      const f = faults.list?.shift();
      if (f) throw f;
      return [...drafts].reverse().slice(offset, offset + limit);
    },
    async createDraft(d: { title: string; body: unknown }) {
      const f = faults.create?.shift();
      if (f instanceof SubstackError) throw f;
      const draft = {
        id: String(next++),
        draft_title: d.title,
        draft_body: JSON.stringify(d.body),
        is_published: false,
        draft_created_at: new Date().toISOString(),
      };
      drafts.push(draft);
      if (f === "lost") throw new SubstackError("uncertain"); // created, response lost
      return { id: draft.id };
    },
    async getDraft(id: string) {
      const f = faults.get?.shift();
      if (f) throw f;
      return drafts.find((d) => d.id === id)!;
    },
  };
  return api;
}
const data = { publicationId: "pub", postId: "a-post" } as never;

describe("Substack draft destination (#385)", () => {
  it("creates one draft, reads it back and returns a non-simulated receipt", async () => {
    const s = fakeSubstack();
    const d = new SubstackDraftDestination(s);
    const preview = d.render({ markdown: WRITER_MARKDOWN, data });
    const receipt = await d.deliver(preview, "k");
    expect(receipt).toMatchObject({ simulated: false, externalId: "100" });
    expect(s.drafts).toHaveLength(1);
    expect(s.drafts[0]!.is_published).toBe(false);
  });

  it("stops before creating anything when the session has expired", async () => {
    const s = fakeSubstack();
    s.faults.list = [new SubstackError("auth-expired", 401)];
    const d = new SubstackDraftDestination(s, { authRetryMs: 900_000 });
    const error = await d
      .deliver(d.render({ markdown: WRITER_MARKDOWN, data }), "k")
      .catch((e) => e);
    expect(error).toBeInstanceOf(DestinationUnavailableError);
    expect(error).toMatchObject({ reason: "auth-expired", retryAfterMs: 900_000 });
    expect(s.drafts).toHaveLength(0);
  });

  it("reconciles a lost create to the existing draft instead of creating another", async () => {
    const s = fakeSubstack();
    s.faults.create = ["lost"];
    const d = new SubstackDraftDestination(s);
    const preview = d.render({ markdown: WRITER_MARKDOWN, data });
    const intentAt = new Date(Date.now() - 1000).toISOString();
    await expect(d.deliver(preview, "k")).rejects.toBeInstanceOf(UncertainDeliveryError);
    expect(await d.reconcile("k", { preview, intentAt })).toMatchObject({
      delivered: { simulated: false, externalId: "100" },
    });
    expect(s.drafts).toHaveLength(1);
  });

  it("only reports not-delivered when the listing covers the attempt", async () => {
    const s = fakeSubstack();
    const d = new SubstackDraftDestination(s);
    const preview = d.render({ markdown: WRITER_MARKDOWN, data });
    const now = new Date().toISOString();
    // The complete (short) list, no match: safe to retry.
    expect(await d.reconcile("k", { preview, intentAt: now })).toEqual({ delivered: false });
    // Many newer drafts and none older than the intent: a full page proves nothing.
    for (let i = 0; i < 120; i++) {
      s.drafts.push({
        id: String(i),
        draft_title: `other ${i}`,
        draft_body: "{}",
        draft_created_at: now,
      });
    }
    expect(
      await d.reconcile("k", { preview, intentAt: new Date(Date.now() - 60_000).toISOString() }),
    ).toBe("unknown");
    // A listing that reaches older drafts covers the attempt.
    s.drafts.unshift({
      id: "old",
      draft_title: "old",
      draft_body: "{}",
      draft_created_at: "2020-01-01T00:00:00Z",
    });
    s.drafts.splice(1, 100);
    expect(await d.reconcile("k", { preview, intentAt: now })).toEqual({ delivered: false });
    // Without context nothing can be concluded.
    expect(await d.reconcile("k")).toBe("unknown");
  });

  it("treats a same-title draft with a different body as ambiguous", async () => {
    const s = fakeSubstack();
    const d = new SubstackDraftDestination(s);
    const preview = d.render({ markdown: WRITER_MARKDOWN, data });
    const { title } = JSON.parse(preview.body);
    s.drafts.push({
      id: "9",
      draft_title: title,
      draft_body: JSON.stringify({ type: "doc", content: [] }),
    });
    expect(await d.reconcile("k", { preview, intentAt: new Date().toISOString() })).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------

let dir: string;
let content: GitArtifactStore;
let operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-substack-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

describe("Substack through the approved-article handler (#385)", { timeout: 60_000 }, () => {
  async function approvedPayload() {
    await recordApproval({ content, operations, report: await approvedReport(content) });
    return operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)[0]!.payload;
  }
  const handle = (payload: string, destination: SubstackDraftDestination) =>
    handleApprovedArticle({
      payload,
      destination,
      schedule: { delayMs: 0 },
      content,
      operations,
      owner: "t",
      retryDelayMs: 1,
    });

  it("waits on an expired session without exhausting the approval, then delivers once", async () => {
    const payload = await approvedPayload();
    const s = fakeSubstack();
    s.faults.list = Array.from({ length: 8 }, () => new SubstackError("auth-expired", 401));
    const d = new SubstackDraftDestination(s, { authRetryMs: 900_000 });
    for (let i = 0; i < 8; i++) {
      expect(await handle(payload, d)).toMatchObject({
        action: "nak",
        reason: "auth-expired",
        delayMs: 900_000,
      });
    }
    expect(s.drafts).toHaveLength(0);
    // The owner replaces the session: delivery resumes, well past the 5-attempt budget.
    expect(await handle(payload, d)).toMatchObject({ action: "ack", outcome: "delivered" });
    expect(s.drafts).toHaveLength(1);
    expect(await handle(payload, d)).toMatchObject({ action: "ack", outcome: "reused" });
  });

  it("reconciles an attempt that stopped before its receipt instead of creating again", async () => {
    const payload = await approvedPayload();
    const s = fakeSubstack();
    const d = new SubstackDraftDestination(s);
    // The draft is created, then the receipt write fails (as a crash would).
    const failingContent = new Proxy(content, {
      get(target, prop) {
        if (prop === "write") {
          return async (path: string, body: string) => {
            if (path.endsWith("/receipt.json")) throw new Error("disk full");
            return target.write(path, body);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const first = await handleApprovedArticle({
      payload,
      destination: d,
      schedule: { delayMs: 0 },
      content: failingContent,
      operations,
      owner: "t",
      retryDelayMs: 1,
    });
    expect(first).toMatchObject({ action: "nak" });
    expect(s.drafts).toHaveLength(1);
    expect(await handle(payload, d)).toMatchObject({ action: "ack", outcome: "delivered" });
    expect(s.drafts).toHaveLength(1);
  });

  it("spends the attempt budget on a permanent rejection instead of waiting forever", async () => {
    const payload = await approvedPayload();
    const s = fakeSubstack();
    s.faults.create = Array.from({ length: 10 }, () => new SubstackError("invalid-response", 422));
    const d = new SubstackDraftDestination(s);
    const decisions = [];
    for (let i = 0; i < 6; i++) decisions.push(await handle(payload, d));
    expect(decisions.slice(0, 5).every((x) => x.action === "nak" && x.reason === "retry")).toBe(
      true,
    );
    expect(decisions[5]).toMatchObject({ action: "term", reason: "exhausted" });
    expect(s.drafts).toHaveLength(0);
  });

  it("reconciles a lost create before any retry, so exactly one draft exists", async () => {
    const payload = await approvedPayload();
    const s = fakeSubstack();
    s.faults.create = ["lost"];
    const d = new SubstackDraftDestination(s);
    expect(await handle(payload, d)).toMatchObject({ action: "nak", reason: "uncertain" });
    expect(await handle(payload, d)).toMatchObject({ action: "ack", outcome: "delivered" });
    expect(s.drafts).toHaveLength(1);
  });
});
