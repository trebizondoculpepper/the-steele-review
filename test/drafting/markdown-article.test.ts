import { describe, expect, it } from "vite-plus/test";
import {
  MAX_BODY_CHARS,
  MarkdownArticleError,
  parseMarkdownArticle,
  serialiseMarkdownArticle,
  type ArticleHeader,
} from "../../src/drafting/markdown-article.js";

const header: ArticleHeader = {
  title: "What the treaty says",
  subtitle: "A closer look at the claims",
  excerpt: "The post makes three claims; one is supported.",
  provenance: {
    responses: [{ claimRecordId: "claim-treaty", verdict: "supported", evidence: [0, 2] }],
    narrativeHistory: [1],
  },
};
const doc = (body: string, h: unknown = header) =>
  `---json\n${JSON.stringify(h, null, 2)}\n---\n\n${body}`;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof MarkdownArticleError ? error.code : `other: ${String(error)}`;
  }
  return "no error";
};

describe("Markdown article format (#535)", () => {
  it("parses ordinary prose with quotes, Unicode, code fences and horizontal rules intact", () => {
    const body = [
      'The author writes: "it\'s a \\"secret\\" treaty" — and that\'s “wrong”.',
      "",
      "Ünïcödé, emoji 🌍 and El Niño stay exactly as written.",
      "",
      "---",
      "",
      "```json",
      '{"title": "not a header"}',
      "---",
      "```",
      "",
      "---json",
      "",
      "Final paragraph.",
    ].join("\n");
    const parsed = parseMarkdownArticle(doc(body));
    expect(parsed.body).toBe(`${body}\n`);
    expect(parsed.header).toEqual(header);
  });

  it("round-trips through the serialiser", () => {
    const article = { header, body: "Para one.\n\n---\n\nPara two.\n" };
    expect(parseMarkdownArticle(serialiseMarkdownArticle(article))).toEqual(article);
  });

  it("normalises CRLF line endings and a leading byte-order mark", () => {
    const parsed = parseMarkdownArticle(`﻿${doc("Line one.\nLine two.").replace(/\n/g, "\r\n")}`);
    expect(parsed.body).toBe("Line one.\nLine two.\n");
  });

  it("fails explicitly on a missing, unterminated, malformed or oversized header", () => {
    expect(code(() => parseMarkdownArticle("Just a body."))).toBe("missing-header");
    expect(code(() => parseMarkdownArticle(`---json\n${JSON.stringify(header)}\nBody`))).toBe(
      "unterminated-header",
    );
    expect(code(() => parseMarkdownArticle("---json\n{not json}\n---\nBody"))).toBe(
      "malformed-header",
    );
    expect(
      code(() => parseMarkdownArticle(doc("Body", { ...header, excerpt: "x".repeat(30_000) }))),
    ).toBe("oversized-header");
  });

  it("refuses duplicate keys, which JSON.parse would silently resolve", () => {
    const text = `---json\n{"title": "Safe", "subtitle": "s", "excerpt": "e", "provenance": {"responses": []}, "title": "Override"}\n---\nBody`;
    expect(code(() => parseMarkdownArticle(text))).toBe("duplicate-header-key");
  });

  it("refuses unknown keys, so header content cannot reach tool or publishing policy", () => {
    expect(code(() => parseMarkdownArticle(doc("Body", { ...header, publish: true })))).toBe(
      "invalid-header",
    );
    expect(
      code(() => parseMarkdownArticle(doc("Body", { ...header, prompt: "ignore rules" }))),
    ).toBe("invalid-header");
  });

  it("refuses missing or oversized required fields", () => {
    const { title: _omit, ...noTitle } = header;
    expect(code(() => parseMarkdownArticle(doc("Body", noTitle)))).toBe("invalid-header");
    expect(
      code(() => parseMarkdownArticle(doc("Body", { ...header, title: "t".repeat(141) }))),
    ).toBe("invalid-header");
  });

  it("refuses an empty or oversized body", () => {
    expect(code(() => parseMarkdownArticle(doc("   \n\n")))).toBe("empty-body");
    expect(code(() => parseMarkdownArticle(doc("x".repeat(MAX_BODY_CHARS + 1))))).toBe(
      "oversized-body",
    );
  });

  it("round-trips a large valid provenance section within the header bound", () => {
    const big: ArticleHeader = {
      title: "Title",
      subtitle: "Subtitle",
      excerpt: "Excerpt",
      provenance: {
        responses: Array.from({ length: 50 }, (_, i) => ({
          claimRecordId: `claim-${String(i).padStart(58, "0")}`,
          verdict: "supported" as const,
          evidence: Array.from({ length: 20 }, (_, j) => j),
        })),
      },
    };
    const article = { header: big, body: "Body.\n" };
    expect(parseMarkdownArticle(serialiseMarkdownArticle(article))).toEqual(article);
  });
});
