import { describe, expect, it } from "vite-plus/test";
import {
  UnsupportedMarkdownError,
  bodyFingerprint,
  markdownToProseMirror,
  withNativeFootnotes,
} from "../../src/publishing/substack/prosemirror.js";

/**
 * The node shapes of the reference draft the owner made in the Substack editor
 * (#811), read back unchanged: an inline anchor, and top-level footnote blocks
 * holding paragraphs after the body.
 */
const REFERENCE = {
  anchor: { type: "footnoteAnchor", attrs: { number: 1 } },
  footnote: {
    type: "footnote",
    attrs: { number: 1 },
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "This is a fact." }],
      },
    ],
  },
};

const convert = (md: string) => withNativeFootnotes(markdownToProseMirror(md));
const ARTICLE = `The treaty bans weather weapons. [1]

It was adopted in 1976 [2] and is still in force [1].

## Sources

Original post: [The post](<https://pub.example.com/p/p1>)

1. https://a.example/enmod: "The Convention prohibits hostile use."
2. https://b.example/un: "Adopted on 10 December 1976."
3. https://c.example/unused: "Background only."
`;

describe("native Substack footnotes (#811)", () => {
  it("emits the reference draft's anchor and footnote shapes, in reading order", () => {
    const doc = convert(ARTICLE);
    const first = doc.content[0] as { content: unknown[] };
    expect(first.content).toEqual([
      { type: "text", text: "The treaty bans weather weapons." },
      REFERENCE.anchor,
    ]);
    const footnotes = doc.content.filter((n) => n.type === "footnote");
    expect(
      footnotes.map((f) => (f as { attrs: { number: number } }).attrs.number),
    ).toEqual([1, 2, 3]);
    expect(Object.keys(footnotes[0]!).sort()).toEqual(
      Object.keys(REFERENCE.footnote).sort(),
    );
    expect(
      (footnotes[0] as { content: { type: string }[] }).content[0]!.type,
    ).toBe("paragraph");
    // Footnotes come after the body and the Sources section.
    expect(doc.content.slice(-3)).toEqual(footnotes);
  });

  it("gives a repeated reference its own footnote with the same source text and link", () => {
    const doc = convert(ARTICLE);
    const footnotes = doc.content.filter((n) => n.type === "footnote") as {
      content: unknown;
    }[];
    expect(footnotes[2]!.content).toEqual(footnotes[0]!.content);
    expect(JSON.stringify(footnotes[0])).toContain("https://a.example/enmod");
    expect(JSON.stringify(footnotes[1])).toContain(
      "Adopted on 10 December 1976.",
    );
  });

  it("keeps the original post and any uncited source under Sources", () => {
    const doc = convert(ARTICLE);
    const text = JSON.stringify(doc);
    expect(text).toContain("https://pub.example.com/p/p1");
    expect(doc.content.some((n) => n.type === "ordered_list")).toBe(false);
    const left = doc.content.find((n) => n.type === "bullet_list");
    expect(JSON.stringify(left)).toContain("https://c.example/unused");
    expect(JSON.stringify(left)).not.toContain("a.example");
  });

  it("refuses a marker with no source rather than creating a broken draft", () => {
    expect(() => convert(ARTICLE.replace("[2]", "[7]"))).toThrow(
      UnsupportedMarkdownError,
    );
  });

  it("leaves link text and documents without a Sources list unchanged", () => {
    const linked = "See [1](https://x.example/one).\n";
    expect(convert(linked)).toEqual(markdownToProseMirror(linked));
    const plain = "A claim [1] with no sources section.\n";
    expect(convert(plain)).toEqual(markdownToProseMirror(plain));
  });

  it("fingerprints the footnote text, so read-back checks the converted body", () => {
    const doc = convert(ARTICLE);
    const changed = convert(ARTICLE.replace("Background only.", "Changed."));
    expect(bodyFingerprint(doc)).not.toBe(bodyFingerprint(changed));
    const edited = structuredClone(doc);
    (
      edited.content.at(-1) as { content: { content: { text: string }[] }[] }
    ).content[0]!.content[0]!.text += " edited";
    expect(bodyFingerprint(edited)).not.toBe(bodyFingerprint(doc));
  });

  it("fingerprints anchor positions and numbering, not only the text", () => {
    const doc = convert(ARTICLE);
    const dropped = structuredClone(doc);
    const first = dropped.content[0] as { content: { type: string }[] };
    first.content = first.content.filter((n) => n.type !== "footnoteAnchor");
    expect(bodyFingerprint(dropped)).not.toBe(bodyFingerprint(doc));
    const swapped = structuredClone(doc);
    const anchors = (
      swapped.content[1] as {
        content: { type: string; attrs?: { number: number } }[];
      }
    ).content.filter((n) => n.type === "footnoteAnchor");
    [anchors[0]!.attrs!.number, anchors[1]!.attrs!.number] = [
      anchors[1]!.attrs!.number,
      anchors[0]!.attrs!.number,
    ];
    expect(bodyFingerprint(swapped)).not.toBe(bodyFingerprint(doc));
    // Unrelated attribute normalisation by Substack still matches.
    const normalised = structuredClone(doc);
    (normalised.content[0] as { attrs?: unknown }).attrs = { textAlign: null };
    expect(bodyFingerprint(normalised)).toBe(bodyFingerprint(doc));
  });

  it("leaves a source's own [n] inside a quotation alone", () => {
    const quoted = ARTICLE.replace(
      "## Sources",
      '> "The earlier report [7] said so." (2023-05-01, https://pub.example.com/p/earlier)\n\n## Sources',
    );
    const doc = convert(quoted);
    const quote = doc.content.find((n) => n.type === "blockquote");
    expect(JSON.stringify(quote)).toContain("[7]");
    expect(JSON.stringify(quote)).not.toContain("footnoteAnchor");
  });

  it("keeps a multi-paragraph passage whole and finds later definitions (#897 review)", () => {
    const md = `First [1] and second [2].

## Sources

Original post: [The post](<https://pub.example.com/p/p1>)

1. https://a.example/one: "Opening paragraph.

Closing paragraph."
2. https://b.example/two: "Second source."
`;
    const doc = convert(md);
    const footnotes = doc.content.filter((n) => n.type === "footnote");
    expect(footnotes).toHaveLength(2);
    expect(JSON.stringify(footnotes[0])).toContain("Closing paragraph.");
    expect(JSON.stringify(footnotes[1])).toContain("Second source.");
    expect(doc.content.some((n) => n.type === "ordered_list")).toBe(false);
    expect(
      JSON.stringify(doc.content.filter((n) => n.type !== "footnote")),
    ).not.toContain("Closing paragraph.");
  });

  it("never mistakes a passage's own numbered list for a source (#897 review)", () => {
    const md = `First [1] and second [2].

## Sources

Original post: [The post](<https://pub.example.com/p/p1>)

1. https://a.example/one: "Opening.

1. First enumerated point.
2. Second enumerated point.

Closing."
2. https://b.example/two: "Second source."
`;
    const footnotes = convert(md).content.filter((n) => n.type === "footnote");
    expect(footnotes).toHaveLength(2);
    const one = JSON.stringify(footnotes[0]);
    expect(one).toContain("https://a.example/one");
    expect(one).toContain("First enumerated point.");
    expect(one).toContain("Closing.");
    expect(JSON.stringify(footnotes[1])).toContain("https://b.example/two");
  });

  it("fingerprints an anchor moved across a paragraph boundary", () => {
    const md =
      'Alpha [1]\n\nBeta.\n\n## Sources\n\n1. https://a.example/one: "x"\n';
    const doc = convert(md);
    const moved = structuredClone(doc);
    const [p1, p2] = moved.content as { content: { type: string }[] }[];
    const anchor = p1!.content.pop()!;
    p2!.content.unshift(anchor);
    expect(bodyFingerprint(moved)).not.toBe(bodyFingerprint(doc));
  });
});
