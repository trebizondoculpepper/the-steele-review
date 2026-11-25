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
});
