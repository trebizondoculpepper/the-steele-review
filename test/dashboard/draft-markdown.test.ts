import { describe, expect, it } from "vite-plus/test";
import {
  decodeEntitiesOnce,
  renderInline,
  renderMarkdown,
  safeLinkTarget,
} from "../../src/dashboard/draft-markdown.js";

describe("draft markdown rendering (#772)", () => {
  it("renders headings, paragraphs, emphasis, lists, quotes and code", () => {
    const html = renderMarkdown(
      [
        "# Findings",
        "",
        "A paragraph with **bold**, *italics*, `code` and a [citation](https://example.test/report).",
        "",
        "- first point",
        "- second point",
        "",
        "1. ordered one",
        "2. ordered two",
        "",
        "> quoted line",
        "",
        "```",
        "literal <script>",
        "```",
      ].join("\n"),
    );
    expect(html).toContain("<h1>Findings</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italics</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain(
      '<a href="https://example.test/report" rel="noopener noreferrer" target="_blank">citation</a>',
    );
    expect(html).toContain("<ul><li>first point</li><li>second point</li></ul>");
    expect(html).toContain("<ol><li>ordered one</li><li>ordered two</li></ol>");
    expect(html).toContain("<blockquote><p>quoted line</p></blockquote>");
    // Fenced code is shown literally, never executed.
    expect(html).toContain("literal &lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("never turns source markup or handlers into active elements", () => {
    const attacks = [
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(1)">',
      '<a href="javascript:alert(1)">click</a>',
      '<iframe src="https://evil.test"></iframe>',
      '<svg onload="alert(1)">',
      "plain &lt;b&gt;text&lt;/b&gt;",
    ];
    const html = renderMarkdown(attacks.join("\n\n"));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<svg");
    // Handlers survive only as escaped text, never as attributes of a live tag.
    expect(html).not.toMatch(/<[^>]*\son(error|load)=/i);
    expect(html).toContain("&lt;img src=x onerror=");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("refuses unsafe link targets and embedded credentials", () => {
    const html = renderMarkdown(
      [
        "[one](javascript:alert(1))",
        "[two](data:text/html;base64,PHNjcmlwdD4=)",
        "[three](file:///etc/passwd)",
        "[four](https://user:pass@example.test/x)",
        "[five](//example.test/relative)",
        "[six](/config)",
      ].join("\n\n"),
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("file:///");
    expect(html).not.toContain('href="/config"');
    expect(html).not.toContain("user:pass@");
    // The link label survives; the target is refused.
    expect(html).toContain("one <span");
    expect(html.match(/link target refused/g)?.length).toBe(6);
  });

  it("accepts ordinary http, https and mailto targets", () => {
    expect(safeLinkTarget("https://example.test/a?b=1#c")).toBe("https://example.test/a?b=1#c");
    expect(safeLinkTarget("http://example.test/")).toBe("http://example.test/");
    expect(safeLinkTarget("mailto:editor@example.test")).toBe("mailto:editor@example.test");
    expect(safeLinkTarget("javascript:alert(1)")).toBeUndefined();
    expect(safeLinkTarget("  https://example.test/a b ")).toBeUndefined();
  });

  it("does not load remote images", () => {
    const html = renderMarkdown("![a tracker](https://tracker.example.test/pixel.gif)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("tracker.example.test/pixel.gif");
    expect(html).toContain("[image omitted: a tracker]");
  });

  it("decodes entities exactly once", () => {
    expect(decodeEntitiesOnce("A &amp; B &#65; &#x42; &unknown;")).toBe("A & B A B &unknown;");
    // Encoded markup decodes to text, not markup.
    expect(decodeEntitiesOnce("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
    const html = renderMarkdown("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("renders inline text without visible Markdown delimiters", () => {
    expect(renderInline("**bold** and _italic_")).toBe("<strong>bold</strong> and <em>italic</em>");
  });

  it("keeps an unclosed fence readable rather than dropping it", () => {
    const html = renderMarkdown("```\nunclosed code");
    expect(html).toContain("<pre class=\"draft-code\"><code>unclosed code</code></pre>");
  });
});
