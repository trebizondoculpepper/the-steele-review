import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_PACKAGE_VERIFY_PROMPT } from "../../src/drafting/package-verify.js";
import { DEFAULT_PACKAGE_DRAFT_PROMPT } from "../../src/drafting/package-draft.js";
import { PACKAGE_REVISION_INSTRUCTIONS } from "../../src/drafting/package-draft.js";
import { loadPromptFile } from "../../src/prompt-files.js";

/**
 * Editorial policy contract (#490).
 *
 * The verifier is model-backed, so these fixed synthetic cases are captured as
 * prompt assertions: each acceptance example maps to an explicit rule the
 * verifier is required to apply. No model call is made.
 */
const verifier = DEFAULT_PACKAGE_VERIFY_PROMPT.instructions.toLowerCase();

const CASES: Array<{ case: string; expect: "allow" | "reject"; rule: RegExp }> = [
  {
    case: "a clearly worded opinion that the argument is unconvincing",
    expect: "allow",
    rule: /opinion and evaluation, including a judgement that the supplied argument is unconvincing/,
  },
  {
    case: "a clearly signposted inference the source author never phrased",
    expect: "allow",
    rule: /do not reject it merely because the source author never used those exact words/,
  },
  {
    case: "an invented quotation",
    expect: "reject",
    rule: /misquotations/,
  },
  {
    case: "a citation pointing to an unrelated passage",
    expect: "reject",
    rule: /citations pointing to a passage that does not support the claim/,
  },
  {
    case: "the projection/peak factual confusion",
    expect: "reject",
    rule: /factual errors \(what someone said, what happened, figures, dates/,
  },
  {
    case: "invented events, roles or coordination wrapped in opinion",
    expect: "reject",
    rule: /invented factual premises, including events, roles, coordination/,
  },
  {
    case: "a false fact prefixed with 'in my opinion'",
    expect: "reject",
    rule: /does not turn a false factual claim into acceptable commentary/,
  },
  {
    case: "a minor stylistic disagreement",
    expect: "allow",
    rule: /stylistic preferences are non-blocking/,
  },
];

describe("verifier editorial policy (#490)", () => {
  it.each(CASES)("$expect: $case", ({ rule }) => {
    expect(verifier).toMatch(rule);
  });

  it("judges a passage by meaning rather than requiring a source per sentence", () => {
    expect(verifier).toContain("judge each passage by what it actually means");
    expect(verifier).toContain("not by whether every evaluative sentence has an external source");
  });

  it("keeps gaps, limitations and evidence binding intact", () => {
    expect(verifier).toContain("evidence gaps and stated limitations must be preserved");
    expect(verifier).toContain("a valid citation is not proof of semantic support");
    expect(verifier).toContain("if the supplied material does not support a factual statement");
  });

  it("records a content-hashed prompt identity that changes with wording", () => {
    expect(DEFAULT_PACKAGE_VERIFY_PROMPT.version).toMatch(
      /^verifier-package-verifier-sha256:[0-9a-f]{64}$/,
    );
    expect(loadPromptFile("verifier", "package-verifier").version).toBe(
      DEFAULT_PACKAGE_VERIFY_PROMPT.version,
    );
    const hash = createHash("sha256")
      .update(DEFAULT_PACKAGE_VERIFY_PROMPT.instructions)
      .digest("hex");
    expect(DEFAULT_PACKAGE_VERIFY_PROMPT.version).toContain(hash);
  });

  it("aligns the writer and revision guidance with the same distinction", () => {
    const writer = DEFAULT_PACKAGE_DRAFT_PROMPT.instructions.toLowerCase();
    expect(writer).toContain("that opinion needs no separate source");
    expect(writer).toContain("do not attribute your inference to the source author");
    expect(writer).toContain("invent events, roles, coordination, motives or numbers");
    const revision = PACKAGE_REVISION_INSTRUCTIONS.toLowerCase();
    expect(revision).toContain("evaluative judgement and clearly signposted inference");
    expect(revision).toContain("wrap a false or unsupported factual claim");
  });
});
