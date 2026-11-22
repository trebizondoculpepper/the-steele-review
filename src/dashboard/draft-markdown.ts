/**
 * Narrow reading renderer for saved draft Markdown (#772).
 *
 * The saved body is model output and therefore untrusted. This renderer emits
 * only elements it constructs itself; every piece of source text passes through
 * `escapeHtml`, and raw HTML in the source can never become markup. It supports
 * the constructs a draft actually uses — headings, paragraphs, emphasis, inline
 * code and fenced code, ordered/unordered lists, blockquotes and links — rather
 * than pulling a full CommonMark implementation and sanitiser into the console.
 *
 * Links are restricted to absolute `http:`, `https:` and `mailto:` targets with
 * no embedded credentials, so a citation can never point at a local path or a
 * script. Images are not emitted at all: the page is a reading view, not a
 * channel for automatically loading remote content.
 *
 * This never rewrites the saved artifact; the exact source view renders the
 * original text.
 */
import { escapeHtml } from "./server.js";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
};

/**
 * Decode character references exactly once, at this trusted parsing boundary.
 *
 * A second pass is deliberately not performed: `&amp;lt;` becomes the literal
 * text `&lt;`, not `<`, so encoded markup cannot be turned back into markup.
 */
export function decodeEntitiesOnce(text: string): string {
  return text.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, ref: string) => {
    if (ref.startsWith("#")) {
      const hex = ref[1] === "x" || ref[1] === "X";
      const code = Number.parseInt(hex ? ref.slice(2) : ref.slice(1), hex ? 16 : 10);
      if (
        !Number.isFinite(code) ||
        code < 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      )
        return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
  });
}

/**
 * An allowlisted absolute link target, normalised, or undefined.
 *
 * Spaces, control characters and embedded `user:password@` are refused rather
 * than repaired, so a malformed or credential-bearing citation is never turned
 * into a working link.
 */
export function safeLinkTarget(target: string): string | undefined {
  const trimmed = target.trim();
  if (trimmed.length === 0 || trimmed.length > 2_000) return undefined;
  // Reject whitespace and control characters anywhere in the target.
  if (/[\u0000-\u0020\u007f]/.test(trimmed)) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:")
    return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  return url.href;
}

const BOLD = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/;
const ITALIC = /^(\*|_)(?=\S)([\s\S]*?\S)\1/;
const CODE = /^(`+)([\s\S]*?)\1/;
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]*)\)/;
const LINK = /^\[([^\]]*)\]\(([^)\s]*)\)/;

/** Render inline Markdown. All text is escaped here; only constructed tags escape. */
export function renderInline(source: string, depth = 0): string {
  const text = decodeEntitiesOnce(source);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    // Images first: `![alt](target)` must not be read as a link.
    const image = IMAGE.exec(rest);
    if (image) {
      const alt = escapeHtml(image[1]!.trim());
      out += `<span class="draft-image">[image omitted${alt ? `: ${alt}` : ""}]</span>`;
      i += image[0].length;
      continue;
    }

    const link = LINK.exec(rest);
    if (link) {
      const label = renderInline(link[1]!, depth + 1);
      const target = safeLinkTarget(link[2]!);
      out += target
        ? `<a href="${escapeHtml(target)}" rel="noopener noreferrer" target="_blank">${label}</a>`
        : `${label} <span class="empty">(link target refused)</span>`;
      i += link[0].length;
      continue;
    }

    const code = CODE.exec(rest);
    if (code) {
      out += `<code>${escapeHtml(code[2]!)}</code>`;
      i += code[0].length;
      continue;
    }

    if (depth < 4) {
      const bold = BOLD.exec(rest);
      if (bold) {
        out += `<strong>${renderInline(bold[2]!, depth + 1)}</strong>`;
        i += bold[0].length;
        continue;
      }
      const italic = ITALIC.exec(rest);
      if (italic) {
        out += `<em>${renderInline(italic[2]!, depth + 1)}</em>`;
        i += italic[0].length;
        continue;
      }
    }

    const char = text[i]!;
    out += escapeHtml(char);
    i += 1;
  }
  return out;
}

const HEADING = /^(#{1,6})[ \t]+(.*)$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const QUOTE = /^[ \t]{0,3}>[ \t]?(.*)$/;
const BULLET = /^[ \t]{0,6}[-*+][ \t]+(.*)$/;
const ORDERED = /^[ \t]{0,6}\d{1,9}[.)][ \t]+(.*)$/;
const RULE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** Render a saved Markdown body to safe reading HTML. */
export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  const paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      flushParagraph();
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1]!;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(marker)) {
        body.push(lines[i]!);
        i += 1;
      }
      // Consume the closing fence when present; an unclosed fence still renders.
      if (i < lines.length) i += 1;
      out.push(`<pre class="draft-code"><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1]!.length;
      out.push(`<h${level}>${renderInline(heading[2]!)}</h${level}>`);
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph();
      out.push("<hr>");
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (i < lines.length) {
        const match = QUOTE.exec(lines[i]!);
        if (!match) break;
        quoted.push(match[1]!);
        i += 1;
      }
      out.push(`<blockquote>${renderMarkdown(quoted.join("\n"))}</blockquote>`);
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      const items: string[] = [];
      while (i < lines.length) {
        const match = (bullet ? BULLET : ORDERED).exec(lines[i]!);
        if (!match) break;
        items.push(`<li>${renderInline(match[1]!)}</li>`);
        i += 1;
      }
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph();
  return out.join("\n");
}
