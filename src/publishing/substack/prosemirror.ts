import { createHash } from "node:crypto";

/**
 * Verified article Markdown to a Substack ProseMirror document (#385).
 *
 * Deliberately strict: it accepts exactly the Markdown the package writer
 * renders (src/drafting/package-draft.ts) and fails on anything else, so a
 * malformed draft is never created (doc/architecture/06, "Formatting").
 *
 * Blocks: paragraphs, `#`/`##`/`###` headings, `> ` block quotes, `1. `
 * ordered lists and `- ` bullet lists. Inline: `[text](url)` and
 * `[text](<url>)` links, bare https URLs, `*`/`_` emphasis, `**` strong,
 * backslash escapes. Whole-line HTML comments (the writer's claim-verdict
 * markers) are dropped. Any other HTML, and non-https links, fail.
 */

export class UnsupportedMarkdownError extends Error {
  constructor(readonly reason: string) {
    super(`unsupported markdown: ${reason}`);
    this.name = "UnsupportedMarkdownError";
  }
}

type Mark = { type: "em" } | { type: "strong" } | { type: "link"; attrs: { href: string } };
export type PmText = { type: "text"; text: string; marks?: Mark[] };
export type PmNode =
  | { type: "doc"; content: PmNode[] }
  | { type: "paragraph"; content?: PmText[] }
  | { type: "heading"; attrs: { level: number }; content: PmText[] }
  | { type: "blockquote"; content: PmNode[] }
  | { type: "ordered_list"; attrs: { order: number }; content: PmNode[] }
  | { type: "bullet_list"; content: PmNode[] }
  | { type: "list_item"; content: PmNode[] };

const httpsUrl = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsupportedMarkdownError("invalid link");
  }
  if (url.protocol !== "https:") throw new UnsupportedMarkdownError("non-https link");
  return url.toString();
};

/** Inline Markdown to text nodes with marks. */
export function inline(source: string): PmText[] {
  if (/<(?!https:\/\/)[a-z!/]/i.test(source)) throw new UnsupportedMarkdownError("inline html");
  const out: PmText[] = [];
  const push = (text: string, marks: Mark[]) => {
    if (!text) return;
    const last = out.at(-1);
    if (last && JSON.stringify(last.marks ?? []) === JSON.stringify(marks)) last.text += text;
    else out.push({ type: "text", text, ...(marks.length ? { marks } : {}) });
  };
  const walk = (s: string, marks: Mark[]) => {
    let i = 0;
    let buf = "";
    const flush = () => {
      push(buf, marks);
      buf = "";
    };
    while (i < s.length) {
      const rest = s.slice(i);
      if (rest[0] === "\\" && rest.length > 1 && /[\\`*_[\]()<>#.!-]/.test(rest[1]!)) {
        buf += rest[1];
        i += 2;
        continue;
      }
      // [text](<url>) or [text](url); a plain [n] citation stays text.
      const link = /^\[((?:\\.|[^\]\\])+)\]\((?:<([^>\s]+)>|([^)\s]+))\)/.exec(rest);
      if (link) {
        flush();
        walk(link[1]!, [
          ...marks,
          { type: "link", attrs: { href: httpsUrl(link[2] ?? link[3]!) } },
        ]);
        i += link[0].length;
        continue;
      }
      const auto =
        /^<(https:\/\/[^>\s]+)>/.exec(rest) ?? /^(https:\/\/[^\s<>"]*[^\s<>".,;:!?)\]])/.exec(rest);
      if (auto) {
        flush();
        push(auto[1]!, [...marks, { type: "link", attrs: { href: httpsUrl(auto[1]!) } }]);
        i += auto[0].length;
        continue;
      }
      const strong = /^\*\*(?=\S)([\s\S]*?\S)\*\*/.exec(rest);
      if (strong) {
        flush();
        walk(strong[1]!, [...marks, { type: "strong" }]);
        i += strong[0].length;
        continue;
      }
      const em = /^([*_])(?=\S)([\s\S]*?\S)\1(?![\w*])/.exec(rest);
      if (em && (i === 0 || !/\w/.test(s[i - 1]!))) {
        flush();
        walk(em[2]!, [...marks, { type: "em" }]);
        i += em[0].length;
        continue;
      }
      buf += rest[0];
      i += 1;
    }
    flush();
  };
  walk(source, []);
  return out;
}

const paragraph = (text: string): PmNode => {
  const content = inline(text);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
};

/** Convert the writer's Markdown to a ProseMirror document. */
export function markdownToProseMirror(markdown: string): { type: "doc"; content: PmNode[] } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const content: PmNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*<!--[\s\S]*-->\s*$/.test(line)) {
      i++; // writer's machine-readable markers are not article content
      continue;
    }
    if (/^\s*</.test(line) && !/^\s*<https:\/\//.test(line)) {
      throw new UnsupportedMarkdownError("block html");
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      content.push({
        type: "heading",
        attrs: { level: heading[1]!.length },
        content: inline(heading[2]!.trim()),
      });
      i++;
      continue;
    }
    if (/^#{4,} /.test(line) || line.startsWith("```") || /^\s*\|/.test(line)) {
      throw new UnsupportedMarkdownError("unsupported block");
    }
    if (line.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) {
        quoted.push(lines[i]!.replace(/^> ?/, ""));
        i++;
      }
      content.push({
        type: "blockquote",
        content: markdownToProseMirror(quoted.join("\n")).content,
      });
      continue;
    }
    const ordered = /^(\d+)\. /.exec(line);
    const bullet = /^[-*] /.test(line);
    if (ordered || bullet) {
      const items: PmNode[] = [];
      const pattern = ordered ? /^\d+\. (.*)$/ : /^[-*] (.*)$/;
      while (i < lines.length && pattern.test(lines[i]!)) {
        let text = pattern.exec(lines[i]!)![1]!;
        i++;
        // Continuation lines indented under the item.
        while (i < lines.length && /^ {2,}\S/.test(lines[i]!)) text += ` ${lines[i++]!.trim()}`;
        items.push({ type: "list_item", content: [paragraph(text)] });
      }
      content.push(
        ordered
          ? { type: "ordered_list", attrs: { order: Number(ordered[1]) }, content: items }
          : { type: "bullet_list", content: items },
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,6} |>|\d+\. |[-*] |<!--)/.test(lines[i]!)
    ) {
      para.push(lines[i]!.trim());
      i++;
    }
    content.push(paragraph(para.join(" ")));
  }
  return { type: "doc", content };
}

/** Canonical JSON (sorted keys) so equal documents hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The text content of a document, whitespace-collapsed: what a reader sees. */
export function documentText(node: unknown): string {
  const parts: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const o = n as { type?: string; text?: unknown; content?: unknown };
    if (o.type === "text" && typeof o.text === "string") parts.push(o.text);
    if (Array.isArray(o.content)) {
      for (const c of o.content) walk(c);
      parts.push(" ");
    }
  };
  walk(node);
  return parts.join("").replace(/\s+/g, " ").trim();
}

/**
 * Body fingerprint used to match a draft read back from Substack. Substack
 * may normalise node attributes, so the fingerprint is over the visible text
 * and link targets, not the raw JSON.
 */
export function bodyFingerprint(doc: unknown): string {
  const links: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const o = n as { marks?: { type?: string; attrs?: { href?: unknown } }[]; content?: unknown };
    for (const m of o.marks ?? []) {
      if (m.type === "link" && typeof m.attrs?.href === "string") links.push(m.attrs.href);
    }
    if (Array.isArray(o.content)) for (const c of o.content) walk(c);
  };
  walk(doc);
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([documentText(doc), links]))
    .digest("hex")}`;
}
