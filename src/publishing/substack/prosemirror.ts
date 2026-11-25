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

type Mark =
  | { type: "em" }
  | { type: "strong" }
  | { type: "link"; attrs: { href: string } };
export type PmText = { type: "text"; text: string; marks?: Mark[] };
export type PmNode =
  | { type: "doc"; content: PmNode[] }
  | { type: "paragraph"; content?: PmText[] }
  | { type: "heading"; attrs: { level: number }; content: PmText[] }
  | { type: "blockquote"; content: PmNode[] }
  | { type: "ordered_list"; attrs: { order: number }; content: PmNode[] }
  | { type: "bullet_list"; content: PmNode[] }
  | { type: "list_item"; content: PmNode[] }
  | { type: "footnote"; attrs: { number: number }; content: PmNode[] };
/** An inline footnote reference, as the Substack editor saves it (#811). */
export type PmFootnoteAnchor = {
  type: "footnoteAnchor";
  attrs: { number: number };
};

const httpsUrl = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsupportedMarkdownError("invalid link");
  }
  if (url.protocol !== "https:")
    throw new UnsupportedMarkdownError("non-https link");
  return url.toString();
};

/**
 * A bare https URL at the start of `text`. Balanced parentheses stay part of
 * the URL (`report_(2026)`); trailing sentence punctuation and an unbalanced
 * closing parenthesis do not.
 */
function bareUrl(text: string): [string, string] | null {
  const m = /^https:\/\/[^\s<>"]+/.exec(text);
  if (!m) return null;
  let url = m[0];
  for (;;) {
    const last = url.at(-1)!;
    if (".,;:!?]'".includes(last)) url = url.slice(0, -1);
    else if (last === ")" && url.split("(").length < url.split(")").length)
      url = url.slice(0, -1);
    else break;
  }
  return url.length > "https://".length ? [url, url] : null;
}

/**
 * `[text](<url>)` or `[text](url)` at the start of `s`. A bare destination may
 * contain balanced parentheses (`report_(2026)`), as in CommonMark; an
 * unbalanced or whitespace-broken destination is not a link.
 */
function explicitLink(
  s: string,
): { text: string; href: string; length: number } | null {
  const label = /^\[((?:\\.|[^\]\\])+)\]\(/.exec(s);
  if (!label) return null;
  let i = label[0].length;
  if (s[i] === "<") {
    const end = s.indexOf(">", i);
    if (end < 0 || s[end + 1] !== ")" || /\s/.test(s.slice(i + 1, end)))
      return null;
    return { text: label[1]!, href: s.slice(i + 1, end), length: end + 2 };
  }
  let depth = 0;
  const start = i;
  for (; i < s.length; i++) {
    const c = s[i]!;
    if (/\s/.test(c)) return null;
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    }
  }
  if (i >= s.length || i === start) return null;
  return { text: label[1]!, href: s.slice(start, i), length: i + 1 };
}

/** Inline Markdown to text nodes with marks. */
export function inline(source: string): PmText[] {
  if (/<(?!https:\/\/)[a-z!/]/i.test(source))
    throw new UnsupportedMarkdownError("inline html");
  const out: PmText[] = [];
  const push = (text: string, marks: Mark[]) => {
    if (!text) return;
    const last = out.at(-1);
    if (last && JSON.stringify(last.marks ?? []) === JSON.stringify(marks))
      last.text += text;
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
      if (
        rest[0] === "\\" &&
        rest.length > 1 &&
        /[\\`*_[\]()<>#.!-]/.test(rest[1]!)
      ) {
        buf += rest[1];
        i += 2;
        continue;
      }
      // [text](<url>) or [text](url); a plain [n] citation stays text.
      const link = explicitLink(rest);
      if (link) {
        flush();
        walk(link.text, [
          ...marks,
          { type: "link", attrs: { href: httpsUrl(link.href) } },
        ]);
        i += link.length;
        continue;
      }
      const auto = /^<(https:\/\/[^>\s]+)>/.exec(rest) ?? bareUrl(rest);
      if (auto) {
        flush();
        push(auto[1]!, [
          ...marks,
          { type: "link", attrs: { href: httpsUrl(auto[1]!) } },
        ]);
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
  return content.length
    ? { type: "paragraph", content }
    : { type: "paragraph" };
};

/** Convert the writer's Markdown to a ProseMirror document. */
export function markdownToProseMirror(markdown: string): {
  type: "doc";
  content: PmNode[];
} {
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
        while (i < lines.length && /^ {2,}\S/.test(lines[i]!))
          text += ` ${lines[i++]!.trim()}`;
        items.push({ type: "list_item", content: [paragraph(text)] });
      }
      content.push(
        ordered
          ? {
              type: "ordered_list",
              attrs: { order: Number(ordered[1]) },
              content: items,
            }
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
    // A line no block parser accepts (for example an empty "# ") must fail,
    // never loop: model output is untrusted.
    if (para.length === 0)
      throw new UnsupportedMarkdownError("unrecognised block");
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
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
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
    const o = n as {
      marks?: { type?: string; attrs?: { href?: unknown } }[];
      content?: unknown;
    };
    for (const m of o.marks ?? []) {
      if (m.type === "link" && typeof m.attrs?.href === "string")
        links.push(m.attrs.href);
    }
    if (Array.isArray(o.content)) for (const c of o.content) walk(c);
  };
  walk(doc);
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([documentText(doc), links]))
    .digest("hex")}`;
}

/**
 * Native Substack footnotes (#811), shaped like a footnote saved by the
 * Substack editor: an inline `footnoteAnchor {number}` in the prose and a
 * top-level `footnote {number}` block holding paragraphs, after the body.
 *
 * The writer's citations are `[n]` markers in the prose and a numbered list
 * under the final `## Sources` heading. Each marker becomes its own
 * footnote, numbered in reading order. A repeated reference gets its own
 * footnote, with the same source text, because the editor pairs each anchor
 * with exactly one footnote. A marker with no definition fails rather than
 * producing a broken draft. Sources never cited stay listed under Sources,
 * as does the original-post line. A document without a Sources list is
 * unchanged.
 */
export function withNativeFootnotes(doc: { type: "doc"; content: PmNode[] }): {
  type: "doc";
  content: PmNode[];
} {
  const content = doc.content;
  const sourcesAt = content.findLastIndex(
    (n) =>
      n.type === "heading" &&
      n.attrs.level === 2 &&
      n.content.map((t) => t.text).join("") === "Sources",
  );
  if (sourcesAt < 0) return doc;
  const listAt = content.findIndex(
    (n, i) => i > sourcesAt && n.type === "ordered_list",
  );
  if (listAt < 0) return doc;
  const list = content[listAt] as Extract<PmNode, { type: "ordered_list" }>;
  const definitions = new Map<number, PmNode[]>(
    list.content.map((item, i) => [
      list.attrs.order + i,
      (item as Extract<PmNode, { type: "list_item" }>).content,
    ]),
  );
  const used = new Set<number>();
  const footnotes: PmNode[] = [];
  const MARKER = /\s*\[(\d+)\](?!\()/g;
  const convert = (node: PmNode): PmNode => {
    if (node.type === "paragraph" || node.type === "heading") {
      if (!node.content) return node;
      const out: (PmText | PmFootnoteAnchor)[] = [];
      for (const t of node.content) {
        // Link text is never a citation.
        if (t.marks?.some((m) => m.type === "link")) {
          out.push(t);
          continue;
        }
        let last = 0;
        for (const m of t.text.matchAll(MARKER)) {
          const n = Number(m[1]);
          const definition = definitions.get(n);
          if (!definition)
            throw new UnsupportedMarkdownError("footnote without a source");
          used.add(n);
          const before = t.text.slice(last, m.index);
          if (before) out.push({ ...t, text: before });
          const number = footnotes.length + 1;
          out.push({ type: "footnoteAnchor", attrs: { number } });
          footnotes.push({
            type: "footnote",
            attrs: { number },
            content: structuredClone(definition),
          });
          last = m.index! + m[0].length;
        }
        const rest = t.text.slice(last);
        if (rest) out.push(last ? { ...t, text: rest } : t);
      }
      return { ...node, content: out as PmText[] };
    }
    if ("content" in node && Array.isArray(node.content))
      return { ...node, content: node.content.map(convert) } as PmNode;
    return node;
  };
  const body = content.slice(0, sourcesAt).map(convert);
  if (footnotes.length === 0) return doc;
  const unused = list.content.filter((_, i) => !used.has(list.attrs.order + i));
  const sources = content
    .slice(sourcesAt)
    .flatMap((n, i): PmNode[] =>
      i + sourcesAt !== listAt
        ? [n]
        : unused.length
          ? [{ type: "bullet_list", content: unused }]
          : [],
    );
  return { type: "doc", content: [...body, ...sources, ...footnotes] };
}
