import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { publicationContentHash } from "../../src/drafting/publication-payload.js";
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
import {
  SubstackDraftDestination,
  SubstackPublishDestination,
} from "../../src/publishing/substack/destination.js";
import { ArtifactStoreError } from "../../src/controllers/artifact-store.js";
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
  it("keeps a short quotation inline and a long one as one native quote block (#812)", () => {
    const md = [
      'The author writes that the masts are "deliberately harmful".',
      "",
      "In a longer passage, published by [the campaign](https://example.org/post), the author argues:",
      "",
      "> First sentence of the passage. Second sentence, with *emphasis*.",
      ">",
      "> A second paragraph that ends the quotation.",
      "",
      "That claim is not supported by the cited report.",
    ].join("\n");
    const doc = markdownToProseMirror(md);
    expect(doc.content.map((n) => n.type)).toEqual([
      "paragraph",
      "paragraph",
      "blockquote",
      "paragraph",
    ]);
    // The short quotation stays inline, exactly as written.
    expect(JSON.stringify(doc.content[0])).toContain(
      '"deliberately harmful"'.replace(/"/g, '\\"'),
    );
    // The attribution and source link sit outside the quote block.
    expect(JSON.stringify(doc.content[1])).toContain(
      "https://example.org/post",
    );
    const quote = doc.content[2] as {
      content: { type: string; content: { text: string }[] }[];
    };
    // One quote block holding both paragraphs, text preserved exactly.
    expect(quote.content.map((p) => p.type)).toEqual([
      "paragraph",
      "paragraph",
    ]);
    expect(quote.content[0]!.content.map((t) => t.text).join("")).toBe(
      "First sentence of the passage. Second sentence, with emphasis.",
    );
    expect(quote.content[1]!.content.map((t) => t.text).join("")).toBe(
      "A second paragraph that ends the quotation.",
    );
  });

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
    expect(json).toContain(
      '{"type":"link","attrs":{"href":"https://pub.example.com/p/p1"}}',
    );
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
      markdownToProseMirror(
        "See [the report](https://example.org/report_(2026)) now.",
      ),
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
      expect(() => markdownToProseMirror(bad), bad).toThrow(
        UnsupportedMarkdownError,
      );
    }
  });

  it("fingerprints visible text and links, not attribute order", () => {
    const doc = markdownToProseMirror("Hello [there](<https://a.example/>).");
    // The same document with mark keys in a different order.
    const reordered = JSON.parse(JSON.stringify(doc), (_k, v: unknown) =>
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      (v as { type?: unknown }).type === "link"
        ? { attrs: (v as { attrs: unknown }).attrs, type: "link" }
        : v,
    );
    expect(bodyFingerprint(reordered)).toBe(bodyFingerprint(doc));
    expect(bodyFingerprint(markdownToProseMirror("Hello there."))).not.toBe(
      bodyFingerprint(doc),
    );
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
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const ORIGIN = "https://example-pub.substack.com";
const client = (f: typeof fetch, session = "s3cret-cookie") =>
  new SubstackClient({
    origin: ORIGIN,
    session: async () => session,
    fetch: f,
    timeoutMs: 2_000,
  });
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
        : json(
            { errors: [{ path: "draft_bylines", msg: "Invalid value" }] },
            400,
          );
    });
    await expect(
      client(f).createDraft({
        title: "Connection test",
        body: { type: "doc", content: [] },
      }),
    ).resolves.toEqual({ id: "123" });
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.draft_bylines).toEqual([]);
    expect(sent).not.toHaveProperty("send_email");
  });

  it("sends an explicitly selected byline id when one is configured (#459)", async () => {
    const { f, calls } = fakeFetch(() => json({ id: 456 }));
    await client(f).createDraft({
      title: "t",
      body: { type: "doc", content: [] },
      bylines: ["42"],
    });
    expect(JSON.parse(String(calls[0]!.init.body)).draft_bylines).toEqual([
      { id: "42" },
    ]);
  });

  it("uses the draft filter for access checks and every reconciliation page", async () => {
    const { f, calls } = fakeFetch(({ url }) => {
      const query = new URL(url).searchParams;
      return query.get("filter") === "draft"
        ? json([])
        : json({ error: "filter-required" }, 400);
    });
    const api = client(f);
    await expect(api.listDrafts({ limit: 1 })).resolves.toEqual([]);
    await expect(api.listDrafts({ limit: 25, offset: 25 })).resolves.toEqual(
      [],
    );
    expect(
      calls.map(({ url }) => new URL(url).searchParams.get("offset")),
    ).toEqual(["0", "25"]);
    expect(calls.every(({ init }) => init.method === "GET")).toBe(true);
  });

  it("sends the cookie only to the configured origin, never following redirects", async () => {
    const { f, calls } = fakeFetch(() => json([]));
    await client(f).listDrafts({ limit: 5 });
    expect(calls[0]!.url).toBe(
      `${ORIGIN}/api/v1/drafts?filter=draft&limit=5&offset=0`,
    );
    expect(calls[0]!.init.redirect).toBe("manual");
    expect((calls[0]!.init.headers as Record<string, string>).cookie).toBe(
      "substack.sid=s3cret-cookie",
    );
    expect(
      () =>
        new SubstackClient({
          origin: "http://x.substack.com",
          session: async () => "s",
        }),
    ).toThrow();
    expect(
      () =>
        new SubstackClient({
          origin: `${ORIGIN}/p/x`,
          session: async () => "s",
        }),
    ).toThrow();
  });

  it("maps auth, redirects, rate limits and outages, and keeps secrets out of errors", async () => {
    const status = (s: number) =>
      fakeFetch(() => new Response("body with s3cret-cookie", { status: s })).f;
    expect(await code(client(status(401)).listDrafts({ limit: 1 }))).toBe(
      "auth-expired",
    );
    expect(await code(client(status(302)).listDrafts({ limit: 1 }))).toBe(
      "auth-expired",
    );
    expect(await code(client(status(429)).listDrafts({ limit: 1 }))).toBe(
      "rate-limited",
    );
    expect(await code(client(status(503)).listDrafts({ limit: 1 }))).toBe(
      "unavailable",
    );
    // A create whose outcome is unknown is uncertain, never a plain failure.
    expect(
      await code(client(status(503)).createDraft({ title: "t", body: {} })),
    ).toBe("uncertain");
    const network = fakeFetch(() =>
      Promise.reject(new Error("socket hang up")),
    ).f;
    expect(
      await code(client(network).createDraft({ title: "t", body: {} })),
    ).toBe("uncertain");
    expect(await code(client(network).listDrafts({ limit: 1 }))).toBe(
      "unavailable",
    );
    expect(
      await code(
        client(fakeFetch(() => json({})).f).createDraft({
          title: "t",
          body: {},
        }),
      ),
    ).toBe("uncertain");
    expect(
      await code(
        client(fakeFetch(() => json([])).f, "").listDrafts({ limit: 1 }),
      ),
    ).toBe("auth-expired");
    const error = await client(status(401))
      .listDrafts({ limit: 1 })
      .catch((e: Error) => e);
    expect(String((error as Error).message)).not.toMatch(
      /s3cret|substack\.com/,
    );
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
    publish?: Array<SubstackError | "lost">;
  } = {};
  const api = {
    drafts,
    faults,
    async listDrafts({
      limit,
      offset = 0,
    }: {
      limit: number;
      offset?: number;
    }) {
      const f = faults.list?.shift();
      if (f) throw f;
      return [...drafts].reverse().slice(offset, offset + limit);
    },
    async createDraft(d: { title: string; body: unknown; bylines?: string[] }) {
      const f = faults.create?.shift();
      if (f instanceof SubstackError) throw f;
      const draft = {
        id: String(next++),
        draft_title: d.title,
        draft_body: JSON.stringify(d.body),
        is_published: false,
        draft_created_at: new Date().toISOString(),
        draft_bylines: (d.bylines ?? []).map((id) => ({ id })),
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
    published: [] as Array<{ id: string; send: boolean }>,
    async publishDraft(id: string, options: { send: boolean }) {
      const f = faults.publish?.shift();
      if (f instanceof SubstackError) throw f;
      api.published.push({ id, send: options.send });
      const d = drafts.find((x) => x.id === id)!;
      d.is_published = true;
      if (options.send) d.email_sent_at = new Date().toISOString();
      if (f === "lost") throw new SubstackError("uncertain");
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

  it("maps the approved structured title and subtitle verbatim (#458)", () => {
    const d = new SubstackDraftDestination(fakeSubstack());
    const ref = {
      repository: "content",
      commit: "a".repeat(40),
      path: "publication/x/manifest.json",
      hash: `sha256:${"b".repeat(64)}`,
    };
    const fields = {
      title: "Approved title",
      subtitle: "Approved subtitle",
      excerpt: "Approved excerpt stays in content artifacts.",
    };
    const bodyOnly = { body: { hash: `sha256:${"c".repeat(64)}` } };
    const payload = {
      mode: "structured" as const,
      schemaVersion: 1 as const,
      metadata: ref,
      body: ref,
      fields,
      contentHash: publicationContentHash({
        ...bodyOnly,
        ...{ mode: "structured" as const, fields },
      }),
    };
    const preview = JSON.parse(
      d.render({ markdown: WRITER_MARKDOWN, data, publication: payload }).body,
    );
    expect(preview.title).toBe("Approved title");
    expect(preview.subtitle).toBe("Approved subtitle");
    // The excerpt is not mapped onto an unverified platform field.
    expect(JSON.stringify(preview)).not.toContain(fields.excerpt);
  });

  it("falls back to the draft heading for a legacy body-only approval (#458)", () => {
    const d = new SubstackDraftDestination(fakeSubstack());
    const publication = {
      mode: "legacy-body-only" as const,
      schemaVersion: 1 as const,
      metadata: {
        repository: "content",
        commit: "a".repeat(40),
        path: "publication/x/manifest.json",
        hash: `sha256:${"b".repeat(64)}`,
      },
      body: {
        repository: "content",
        commit: "a".repeat(40),
        path: "drafts/x.md",
        hash: `sha256:${"c".repeat(64)}`,
      },
      contentHash: `sha256:${"c".repeat(64)}`,
    };
    const preview = JSON.parse(
      d.render({ markdown: WRITER_MARKDOWN, data, publication }).body,
    );
    expect(preview.subtitle).toBe("");
    expect(preview.title.length).toBeGreaterThan(0);
  });

  it("selects the configured byline and confirms it on read-back (#459)", async () => {
    const s = fakeSubstack();
    const d = new SubstackDraftDestination(s, { bylineId: "42" });
    const preview = d.render({ markdown: WRITER_MARKDOWN, data });
    expect(JSON.parse(preview.body).bylineId).toBe("42");
    expect(await d.deliver(preview, "k")).toMatchObject({
      simulated: false,
      externalId: "100",
    });
    expect(s.drafts[0]!.draft_bylines).toEqual([{ id: "42" }]);
  });

  it("never claims delivery when the platform drops the requested byline (#459)", async () => {
    const s = fakeSubstack();
    const stripped = {
      ...s,
      async createDraft(d: {
        title: string;
        body: unknown;
        bylines?: string[];
      }) {
        const { id } = await s.createDraft({ ...d, bylines: [] });
        return { id };
      },
    };
    const d = new SubstackDraftDestination(stripped, { bylineId: "42" });
    const preview = d.render({ markdown: WRITER_MARKDOWN, data });
    await expect(d.deliver(preview, "k")).rejects.toBeInstanceOf(
      UncertainDeliveryError,
    );
    // The attribution-less draft is not reclaimed as delivered either.
    expect(
      await d.reconcile("k", { preview, intentAt: new Date().toISOString() }),
    ).toBe("unknown");
  });

  it("pins the byline selected when the intent was rendered (#459)", async () => {
    const s = fakeSubstack();
    const rendered = new SubstackDraftDestination(s, { bylineId: "42" }).render(
      {
        markdown: WRITER_MARKDOWN,
        data,
      },
    );
    // Configuration changed later; the in-flight intent keeps its own choice.
    const changed = new SubstackDraftDestination(s, { bylineId: "99" });
    await changed.deliver(rendered, "k");
    expect(s.drafts[0]!.draft_bylines).toEqual([{ id: "42" }]);

    // An intent rendered with no byline is never upgraded by later config.
    const plain = new SubstackDraftDestination(s).render({
      markdown: WRITER_MARKDOWN,
      data,
    });
    await changed.deliver(plain, "k");
    expect(s.drafts[1]!.draft_bylines).toEqual([]);
  });

  it("stops before creating anything when the session has expired", async () => {
    const s = fakeSubstack();
    s.faults.list = [new SubstackError("auth-expired", 401)];
    const d = new SubstackDraftDestination(s, { authRetryMs: 900_000 });
    const error = await d
      .deliver(d.render({ markdown: WRITER_MARKDOWN, data }), "k")
      .catch((e) => e);
    expect(error).toBeInstanceOf(DestinationUnavailableError);
    expect(error).toMatchObject({
      reason: "auth-expired",
      retryAfterMs: 900_000,
    });
    expect(s.drafts).toHaveLength(0);
  });

  it("reconciles a lost create to the existing draft instead of creating another", async () => {
    const s = fakeSubstack();
    s.faults.create = ["lost"];
    const d = new SubstackDraftDestination(s);
    const preview = d.render({ markdown: WRITER_MARKDOWN, data });
    const intentAt = new Date(Date.now() - 1000).toISOString();
    await expect(d.deliver(preview, "k")).rejects.toBeInstanceOf(
      UncertainDeliveryError,
    );
    expect(await d.reconcile("k", { preview, intentAt })).toMatchObject({
      delivered: { simulated: false, externalId: "100" },
    });
    expect(s.drafts).toHaveLength(1);
  });

  it("does not reconcile a draft whose subtitle differs from the approved payload (#458)", async () => {
    const s = fakeSubstack();
    const d = new SubstackDraftDestination(s);
    const ref = {
      repository: "content",
      commit: "a".repeat(40),
      path: "publication/x/manifest.json",
      hash: `sha256:${"b".repeat(64)}`,
    };
    const fields = { title: "T", subtitle: "Approved subtitle", excerpt: "E" };
    const publication = {
      mode: "structured" as const,
      schemaVersion: 1 as const,
      metadata: ref,
      body: ref,
      fields,
      contentHash: publicationContentHash({
        mode: "structured" as const,
        fields,
        body: { hash: `sha256:${"c".repeat(64)}` },
      }),
    };
    const preview = d.render({ markdown: WRITER_MARKDOWN, data, publication });
    s.faults.create = ["lost"];
    await expect(d.deliver(preview, "k")).rejects.toBeInstanceOf(
      UncertainDeliveryError,
    );
    // Same title and body, different subtitle: a different approval.
    s.drafts[0]!.draft_subtitle = "Some other subtitle";
    const intentAt = new Date(Date.now() - 1000).toISOString();
    // Ambiguous, not "not delivered": a same-headline draft exists, so nothing
    // is re-created and an operator decides.
    expect(await d.reconcile("k", { preview, intentAt })).toBe("unknown");
  });

  it("only reports not-delivered when the listing covers the attempt", async () => {
    const s = fakeSubstack();
    const d = new SubstackDraftDestination(s);
    const preview = d.render({ markdown: WRITER_MARKDOWN, data });
    const now = new Date().toISOString();
    // The complete (short) list, no match: safe to retry.
    expect(await d.reconcile("k", { preview, intentAt: now })).toEqual({
      delivered: false,
    });
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
      await d.reconcile("k", {
        preview,
        intentAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ).toBe("unknown");
    // A listing that reaches older drafts covers the attempt.
    s.drafts.unshift({
      id: "old",
      draft_title: "old",
      draft_body: "{}",
      draft_created_at: "2020-01-01T00:00:00Z",
    });
    s.drafts.splice(1, 100);
    expect(await d.reconcile("k", { preview, intentAt: now })).toEqual({
      delivered: false,
    });
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
    expect(
      await d.reconcile("k", { preview, intentAt: new Date().toISOString() }),
    ).toBe("unknown");
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

describe("Substack live publication with subscriber email (#789)", () => {
  const FROM = "2026-11-23T12:00:00.000Z";
  const fresh = {
    publicationId: "pub",
    postId: "a-post",
    approvedAt: "2026-11-23T12:05:00.000Z",
  } as never;
  const backlog = {
    publicationId: "pub",
    postId: "old",
    approvedAt: "2026-11-22T09:00:00.000Z",
  } as never;
  const rehearsal = {
    publicationId: "pub",
    postId: "facial",
    approvedAt: "2026-11-23T13:00:00.000Z",
    approvalKind: "owner-draft-rehearsal",
  } as never;

  it("publishes an eligible new approval with subscriber email and reads it back", async () => {
    const s = fakeSubstack();
    const d = new SubstackPublishDestination(s, { publishFrom: FROM });
    expect(d.action).toBe("publish");
    const receipt = await (await d.prepare(), d).deliver(
      d.render({ markdown: WRITER_MARKDOWN, data: fresh }),
      "k",
    );
    expect(s.published).toEqual([{ id: "100", send: true }]);
    expect(receipt).toMatchObject({
      simulated: false,
      externalId: "100",
      publicationSafety: { published: true, subscriberEmail: "requested" },
    });
  });

  it("publishes only the configured validation post without subscriber email (#388)", async () => {
    const f = fresh as { publicationId: string; postId: string };
    const s = fakeSubstack();
    const d = new SubstackPublishDestination(s, {
      publishFrom: FROM,
      emailPolicy: async () => ({
        subscriberEmail: "on" as const,
        withoutEmail: new Set([`${f.publicationId}/${f.postId}`]),
      }),
    });
    const receipt = await (await d.prepare(), d).deliver(
      d.render({ markdown: WRITER_MARKDOWN, data: fresh }),
      "k",
    );
    expect(s.published).toEqual([{ id: "100", send: false }]);
    expect(s.drafts[0]!.email_sent_at).toBeUndefined();
    expect(receipt).toMatchObject({
      publicationSafety: { published: true, subscriberEmail: "suppressed" },
    });

    // Any other post still publishes with email.
    const other = { ...(fresh as object), postId: "another-post" } as never;
    await (await d.prepare(), d).deliver(
      d.render({ markdown: WRITER_MARKDOWN, data: other }),
      "k2",
    );
    expect(s.published[1]).toEqual({ id: "101", send: true });
  });

  it("holds without creating anything unless this delivery's policy read succeeded (#388)", async () => {
    const s = fakeSubstack();
    let policy: () => Promise<ReadonlySet<string>> = async () => {
      throw new Error("config unreadable");
    };
    const d = new SubstackPublishDestination(s, {
      publishFrom: FROM,
      emailPolicy: async () => ({
        subscriberEmail: "on" as const,
        withoutEmail: await policy(),
      }),
    });
    const preview = d.render({ markdown: WRITER_MARKDOWN, data: fresh });
    await expect(d.prepare()).rejects.toBeInstanceOf(
      DestinationUnavailableError,
    );
    // Delivery without a successful read for it creates nothing.
    await expect(d.deliver(preview, "k")).rejects.toBeInstanceOf(
      DestinationUnavailableError,
    );
    expect(s.drafts).toHaveLength(0);
    // An owner edit applies to the next prepared delivery.
    const f = fresh as { publicationId: string; postId: string };
    policy = async () => new Set([`${f.publicationId}/${f.postId}`]);
    await d.prepare();
    await d.deliver(preview, "k");
    expect(s.published).toEqual([{ id: "100", send: false }]);
    // A prepared policy is used once: a later delivery needs a fresh read.
    await expect(d.deliver(preview, "k2")).rejects.toBeInstanceOf(
      DestinationUnavailableError,
    );
  });

  it("treats an email timestamp on a suppressed publish as uncertain (#388)", async () => {
    const f = fresh as { publicationId: string; postId: string };
    const s = fakeSubstack();
    const publish = s.publishDraft.bind(s);
    s.publishDraft = async (id: string) => {
      await publish(id, { send: true });
    };
    const d = new SubstackPublishDestination(s, {
      publishFrom: FROM,
      emailPolicy: async () => ({
        subscriberEmail: "on" as const,
        withoutEmail: new Set([`${f.publicationId}/${f.postId}`]),
      }),
    });
    await expect(
      (await d.prepare(), d).deliver(
        d.render({ markdown: WRITER_MARKDOWN, data: fresh }),
        "k",
      ),
    ).rejects.toBeInstanceOf(UncertainDeliveryError);
  });

  it("publishes every post without email when the live switch is off (#895)", async () => {
    const s = fakeSubstack();
    const d = new SubstackPublishDestination(s, {
      publishFrom: FROM,
      emailPolicy: async () => ({
        subscriberEmail: "off",
        withoutEmail: new Set(),
      }),
    });
    const other = { ...(fresh as object), postId: "another-post" } as never;
    for (const [data, key] of [
      [fresh, "k1"],
      [other, "k2"],
    ] as const) {
      await d.prepare();
      const receipt = await d.deliver(
        d.render({ markdown: WRITER_MARKDOWN, data }),
        key,
      );
      expect(receipt).toMatchObject({
        publicationSafety: { published: true, subscriberEmail: "suppressed" },
      });
    }
    expect(s.published.map((p) => p.send)).toEqual([false, false]);
    expect(s.drafts.every((x) => !x.email_sent_at)).toBe(true);
  });

  it("never touches the backlog or owner draft rehearsals", () => {
    const s = fakeSubstack();
    const d = new SubstackPublishDestination(s, { publishFrom: FROM });
    expect(d.eligible(backlog)).toBe(false);
    expect(d.eligible(rehearsal)).toBe(false);
    expect(d.eligible(fresh)).toBe(true);
    // A completed-cycle release (#820) after the cutoff is eligible like an approval.
    expect(
      d.eligible({
        ...(fresh as object),
        approvalKind: "editorial-cycle-complete",
        judgmentDecision: "revise",
      } as never),
    ).toBe(true);
    expect(() =>
      d.render({ markdown: WRITER_MARKDOWN, data: backlog }),
    ).toThrow();
    expect(s.drafts).toHaveLength(0);
    expect(s.published).toHaveLength(0);
    expect(
      () => new SubstackPublishDestination(s, { publishFrom: "not a time" }),
    ).toThrow();
  });

  it("sends any doubt after the draft exists to an operator, never retrying", async () => {
    for (const fault of [
      new SubstackError("uncertain"),
      new SubstackError("rate-limited", 429),
      "lost",
    ] as const) {
      const s = fakeSubstack();
      s.faults.publish = [fault];
      const d = new SubstackPublishDestination(s, { publishFrom: FROM });
      await expect(
        (await d.prepare(), d).deliver(
          d.render({ markdown: WRITER_MARKDOWN, data: fresh }),
          "k",
        ),
      ).rejects.toBeInstanceOf(UncertainDeliveryError);
      expect(s.drafts).toHaveLength(1);
    }
    // A read-back that is not published is uncertain too.
    const s = fakeSubstack();
    const d = new SubstackPublishDestination(
      { ...s, publishDraft: async () => undefined },
      { publishFrom: FROM },
    );
    await expect(
      (await d.prepare(), d).deliver(
        d.render({ markdown: WRITER_MARKDOWN, data: fresh }),
        "k",
      ),
    ).rejects.toBeInstanceOf(UncertainDeliveryError);
    expect(await d.reconcile()).toBe("unknown");
  });
});

describe(
  "Substack through the approved-article handler (#385)",
  { timeout: 60_000 },
  () => {
    async function approvedPayload() {
      await recordApproval({
        content,
        operations,
        report: await approvedReport(content, "approved", true),
      });
      return operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)[0]!
        .payload;
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

    it("ends a backlog approval as not eligible before anything is sent (#789)", async () => {
      const payload = await approvedPayload();
      const s = fakeSubstack();
      // The cutoff is after this approval: it is backlog.
      const d = new SubstackPublishDestination(s, {
        publishFrom: "2999-01-01T00:00:00.000Z",
      });
      expect(
        await handleApprovedArticle({
          payload,
          destination: d,
          schedule: { delayMs: 0 },
          content,
          operations,
          owner: "t",
          retryDelayMs: 1,
        }),
      ).toEqual({ action: "term", reason: "not-eligible" });
      expect(s.drafts).toHaveLength(0);
      expect(s.published).toHaveLength(0);
    });

    it("holds on an unreadable email policy without recording intent, then delivers (#388)", async () => {
      const payload = await approvedPayload();
      const s = fakeSubstack();
      let readable = false;
      const d = new SubstackPublishDestination(s, {
        publishFrom: "2000-01-01T00:00:00.000Z",
        emailPolicy: async () => {
          if (!readable) throw new Error("config unreadable");
          return {
            subscriberEmail: "on" as const,
            withoutEmail: new Set(["pub/a-post"]),
          };
        },
      });
      const run = () =>
        handleApprovedArticle({
          payload,
          destination: d,
          schedule: { delayMs: 0 },
          content,
          operations,
          owner: "t",
          retryDelayMs: 1,
        });
      expect((await run()).action).toBe("nak");
      expect(s.drafts).toHaveLength(0);
      readable = true;
      const out = await run();
      expect(out.action).toBe("ack");
      expect(s.drafts).toHaveLength(1);
      expect(s.published).toHaveLength(1);
    });

    it("waits on an expired session without exhausting the approval, then delivers once", async () => {
      const payload = await approvedPayload();
      const s = fakeSubstack();
      s.faults.list = Array.from(
        { length: 8 },
        () => new SubstackError("auth-expired", 401),
      );
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
      expect(await handle(payload, d)).toMatchObject({
        action: "ack",
        outcome: "delivered",
      });
      expect(s.drafts).toHaveLength(1);
      expect(await handle(payload, d)).toMatchObject({
        action: "ack",
        outcome: "reused",
      });
    });

    it("keeps the pinned byline when configuration changes during retries (#459)", async () => {
      const payload = await approvedPayload();
      const s = fakeSubstack();
      s.faults.list = [new SubstackError("auth-expired", 401)];
      const pinned = new SubstackDraftDestination(s, {
        bylineId: "42",
        authRetryMs: 900_000,
      });
      expect(await handle(payload, pinned)).toMatchObject({
        action: "nak",
        reason: "auth-expired",
      });
      // The owner changes the configured byline while the intent is pending.
      const changed = new SubstackDraftDestination(s, { bylineId: "99" });
      expect(await handle(payload, changed)).toMatchObject({
        action: "ack",
        outcome: "delivered",
      });
      expect(s.drafts).toHaveLength(1);
      // The durable preview's byline wins, not the new configuration.
      expect(s.drafts[0]!.draft_bylines).toEqual([{ id: "42" }]);
    });

    it("retries a transient read failure instead of abandoning the approval (#459)", async () => {
      const payload = await approvedPayload();
      const s = fakeSubstack();
      s.faults.list = [new SubstackError("auth-expired", 401)];
      const d = new SubstackDraftDestination(s, {
        bylineId: "42",
        authRetryMs: 900_000,
      });
      expect(await handle(payload, d)).toMatchObject({
        action: "nak",
        reason: "auth-expired",
      });

      // The stored preview becomes temporarily unreadable (Git/I/O failure).
      const failing = new Proxy(content, {
        get(target, prop, receiver) {
          if (prop === "read") {
            return async (ref: { path: string }) => {
              if (ref.path.endsWith("preview.json"))
                throw new ArtifactStoreError("git-failed");
              return target.read(ref as never);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const out = await handleApprovedArticle({
        payload,
        destination: new SubstackDraftDestination(s, { bylineId: "42" }),
        schedule: { delayMs: 0 },
        content: failing as never,
        operations,
        owner: "t",
        retryDelayMs: 1,
      });
      expect(out).toMatchObject({ action: "nak", reason: "retry" });
      expect(s.drafts).toHaveLength(0);
      // The approval is still deliverable once storage recovers.
      expect(
        await handle(
          payload,
          new SubstackDraftDestination(s, { bylineId: "42" }),
        ),
      ).toMatchObject({
        action: "ack",
        outcome: "delivered",
      });
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
          return typeof v === "function"
            ? (v as (...a: unknown[]) => unknown).bind(target)
            : v;
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
      expect(await handle(payload, d)).toMatchObject({
        action: "ack",
        outcome: "delivered",
      });
      expect(s.drafts).toHaveLength(1);
    });

    it("spends the attempt budget on a permanent rejection instead of waiting forever", async () => {
      const payload = await approvedPayload();
      const s = fakeSubstack();
      s.faults.create = Array.from(
        { length: 10 },
        () => new SubstackError("invalid-response", 422),
      );
      const d = new SubstackDraftDestination(s);
      const decisions = [];
      for (let i = 0; i < 6; i++) decisions.push(await handle(payload, d));
      expect(
        decisions
          .slice(0, 5)
          .every((x) => x.action === "nak" && x.reason === "retry"),
      ).toBe(true);
      expect(decisions[5]).toMatchObject({
        action: "term",
        reason: "exhausted",
      });
      expect(s.drafts).toHaveLength(0);
    });

    it("reconciles a lost create before any retry, so exactly one draft exists", async () => {
      const payload = await approvedPayload();
      const s = fakeSubstack();
      s.faults.create = ["lost"];
      const d = new SubstackDraftDestination(s);
      expect(await handle(payload, d)).toMatchObject({
        action: "nak",
        reason: "uncertain",
      });
      expect(await handle(payload, d)).toMatchObject({
        action: "ack",
        outcome: "delivered",
      });
      expect(s.drafts).toHaveLength(1);
    });
  },
);
