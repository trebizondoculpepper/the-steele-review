import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_PASSAGE_MAX_CHARS,
  DEFAULT_PASSAGE_OVERLAP_CHARS,
  PASSAGE_SPLITTER_VERSION,
  InvalidPassageInputError,
  passageIdFor,
  splitPassages,
} from "../../src/content/passages.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";

// Synthetic values only.
const longText = Array.from(
  { length: 80 },
  (_, index) => `Paragraph ${index}. A synthetic sentence for passage splitting coverage.`,
).join("\n\n");

const input = (text: string, extra: Record<string, unknown> = {}) => ({
  text,
  sourceVersion: sourceVersionFor(text),
  ...extra,
});

describe("splitPassages", () => {
  it("returns no passages for empty text", () => {
    expect(splitPassages(input("")).passages).toEqual([]);
  });

  it("keeps short text as a single passage with the whole span", () => {
    const text = "A short synthetic post.";
    const { passages } = splitPassages(input(text));
    expect(passages).toHaveLength(1);
    expect(passages[0]).toMatchObject({ index: 0, start: 0, end: text.length, text });
  });

  it("bounds every passage and orders them", () => {
    const { passages } = splitPassages(input(longText));
    expect(passages.length).toBeGreaterThan(1);
    for (const passage of passages) {
      expect(passage.text.length).toBeLessThanOrEqual(DEFAULT_PASSAGE_MAX_CHARS);
      expect(passage.end).toBeGreaterThan(passage.start);
    }
    for (let index = 1; index < passages.length; index += 1) {
      expect(passages[index]!.start).toBeGreaterThan(passages[index - 1]!.start);
      expect(passages[index]!.index).toBe(index);
    }
    expect(passages.at(-1)!.end).toBe(longText.length);
  });

  it("overlaps consecutive passages by the documented amount", () => {
    const { passages } = splitPassages(input(longText));
    for (let index = 1; index < passages.length; index += 1) {
      const overlap = passages[index - 1]!.end - passages[index]!.start;
      expect(overlap).toBeGreaterThanOrEqual(DEFAULT_PASSAGE_OVERLAP_CHARS - 1);
      expect(overlap).toBeLessThanOrEqual(DEFAULT_PASSAGE_OVERLAP_CHARS);
    }
  });

  it("reconstructs the source exactly from the spans", () => {
    const { passages } = splitPassages(input(longText));
    for (const passage of passages) {
      expect(longText.slice(passage.start, passage.end)).toBe(passage.text);
    }
    // The union of spans covers the text with no gap.
    expect(passages[0]!.start).toBe(0);
    for (let index = 1; index < passages.length; index += 1) {
      expect(passages[index]!.start).toBeLessThanOrEqual(passages[index - 1]!.end);
    }
  });

  it("is repeatable", () => {
    expect(splitPassages(input(longText))).toEqual(splitPassages(input(longText)));
  });

  it("prefers a paragraph break over a hard cut", () => {
    const paragraph = "A".repeat(700);
    const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    const { passages } = splitPassages(input(text), {
      maxChars: 800,
      overlapChars: 100,
      minChars: 400,
    });
    expect(passages[0]!.end).toBe(702);
    expect(passages[0]!.text.endsWith("\n\n")).toBe(true);
  });

  it("never splits a surrogate pair", () => {
    const text = "🙂".repeat(1200);
    const { passages } = splitPassages(input(text), {
      maxChars: 1000,
      overlapChars: 100,
      minChars: 200,
    });
    expect(passages.length).toBeGreaterThan(1);
    for (const passage of passages) {
      expect(passage.text.isWellFormed()).toBe(true);
      expect(text.slice(passage.start, passage.end)).toBe(passage.text);
    }
  });

  it("keeps surrogate pairs intact and stays bounded when minChars equals maxChars", () => {
    const emoji = "🙂".repeat(1200);
    const emojiPassages = splitPassages(input(emoji), {
      maxChars: 1000,
      overlapChars: 100,
      minChars: 1000,
    }).passages;
    expect(emojiPassages.length).toBeGreaterThan(1);
    for (const passage of emojiPassages) {
      expect(passage.text.length).toBeLessThanOrEqual(1000);
      expect(passage.text.isWellFormed()).toBe(true);
      expect(emoji.slice(passage.start, passage.end)).toBe(passage.text);
    }

    const unbroken = "a".repeat(3500);
    for (const passage of splitPassages(input(unbroken), {
      maxChars: 1000,
      overlapChars: 100,
      minChars: 1000,
    }).passages) {
      expect(passage.text.length).toBeLessThanOrEqual(1000);
    }
  });

  it("retains the supplied timestamps and omits missing ones", () => {
    const withDates = splitPassages(
      input("A short synthetic post.", {
        publishedAt: "2026-01-02T03:04:05Z",
        updatedAt: "2026-01-03T00:00:00+01:00",
      }),
    ).passages[0]!;
    expect(withDates.publishedAt).toBe("2026-01-02T03:04:05Z");
    expect(withDates.updatedAt).toBe("2026-01-03T00:00:00+01:00");

    const withoutDates = splitPassages(input("A short synthetic post.")).passages[0]!;
    expect(withoutDates).not.toHaveProperty("publishedAt");
    expect(withoutDates).not.toHaveProperty("updatedAt");
  });

  it("carries the source version and splitter version on the set and every passage", () => {
    const text = longText;
    const set = splitPassages(input(text));
    expect(set.sourceVersion).toBe(sourceVersionFor(text));
    expect(set.splitterVersion).toBe(PASSAGE_SPLITTER_VERSION);
    for (const passage of set.passages) {
      expect(passage.sourceVersion).toBe(set.sourceVersion);
      expect(passage.splitterVersion).toBe(PASSAGE_SPLITTER_VERSION);
    }
  });
});

describe("passage identity", () => {
  it("derives stable IDs that change with the splitter version", () => {
    const base = { sourceVersion: sourceVersionFor(longText), index: 0, start: 0, end: 100 };
    const v1 = passageIdFor({ ...base, splitterVersion: 1 });
    const v2 = passageIdFor({ ...base, splitterVersion: 2 });
    expect(v1).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(passageIdFor({ ...base, splitterVersion: 1 })).toBe(v1);
    expect(v2).not.toBe(v1);
  });

  it("derives different IDs for different spans and ordinals", () => {
    const sourceVersion = sourceVersionFor(longText);
    const a = passageIdFor({ sourceVersion, splitterVersion: 1, index: 0, start: 0, end: 100 });
    const b = passageIdFor({ sourceVersion, splitterVersion: 1, index: 1, start: 0, end: 100 });
    const c = passageIdFor({ sourceVersion, splitterVersion: 1, index: 0, start: 0, end: 99 });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("derives different IDs when the text version changes", () => {
    const one = splitPassages(input(longText)).passages[0]!;
    const other = splitPassages(input(`${longText} Changed.`)).passages[0]!;
    expect(other.sourceVersion).not.toBe(one.sourceVersion);
    expect(other.id).not.toBe(one.id);
  });
});

describe("input validation", () => {
  it("rejects a source version that does not match the text", () => {
    expect(() =>
      splitPassages({ text: "synthetic", sourceVersion: sourceVersionFor("different") }),
    ).toThrow(InvalidPassageInputError);
  });

  it("rejects a malformed source version", () => {
    expect(() => splitPassages({ text: "synthetic", sourceVersion: "abc" })).toThrow(
      InvalidPassageInputError,
    );
  });

  it.each([
    ["overlapping everything", { maxChars: 100, overlapChars: 100 }],
    ["negative overlap", { maxChars: 100, overlapChars: -1 }],
    ["zero max", { maxChars: 0 }],
    ["non-integer max", { maxChars: 100.5 }],
    ["min above max", { maxChars: 100, minChars: 101 }],
  ])("rejects %s", (_name, options) => {
    expect(() => splitPassages(input("synthetic text"), options)).toThrow(InvalidPassageInputError);
  });

  it("rejects malformed timestamps", () => {
    expect(() => splitPassages(input("synthetic", { publishedAt: "2026-01-02" }))).toThrow(
      InvalidPassageInputError,
    );
    expect(() => splitPassages(input("synthetic", { updatedAt: 123 }))).toThrow(
      InvalidPassageInputError,
    );
  });

  it("rejects non-string text", () => {
    expect(() => splitPassages({ text: null as never, sourceVersion: "sha256:0" })).toThrow(
      InvalidPassageInputError,
    );
  });
});
