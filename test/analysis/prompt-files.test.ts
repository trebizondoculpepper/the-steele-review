import { describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadAnalysisPrompt } from "../../src/analysis/analysis-prompt.js";
import { DEFAULT_THEME_PROPOSAL_PROMPT } from "../../src/analysis/theme-proposals.js";
import { DEFAULT_THEME_PROMPT } from "../../src/analysis/theme-extraction.js";
import { DEFAULT_CATALOGUE_THEME_PROMPT } from "../../src/analysis/theme-catalogue.js";

/**
 * Migration parity for #421: the exact rendered text of each theme prompt is
 * pinned here, so moving a prompt into Markdown cannot silently reword it.
 */
const EXPECTED = {
  "theme-proposals-v2": "Propose the broad, recognised conspiracy-related topics this source text engages with.\nPrefer established, researchable topics: a practical test is whether the topic is notable enough to have its own encyclopedia (for example Wikipedia) article, such as \"chemtrail conspiracy theory\", \"5G health concerns\" or \"15-minute city\". This is a scope test only, not evidence that anything is true. Do not invent or cite article URLs.\nDo not propose vague umbrella categories such as \"government conspiracy\", \"elite manipulation\" or \"suppression of truth\" on their own; name the specific recognised topic instead.\nDo not create a theme for an unusual individual assertion. Specific assertions are extracted separately as claims and linked to the broader topic they belong to.\nThemes describe what the text is about, never whether it is true, and never the author's intent.\nEach theme has a short `title` (at most six words) and, optionally, a one-sentence `description` of its scope as this post engages with it. Do not add elements the post does not mention.\nYou may be given a list of known theme names for consistency of wording; reuse a known title only when it genuinely fits. You are not required to match the list.\nDo not quote the source. Returning no themes is acceptable.\nOptional properties are omitted when absent; never include question marks in property names.\nRespond with JSON only: {\"themes\":[{\"title\":\"...\",\"description\":\"...\"}]}. A valid empty result is {\"themes\":[]}.",
  "theme-extraction-v1": "Identify the recurring topics or framings the source text engages with.\nThemes describe what the text is about, never whether it is true.\nUse short labels (at most six words). New or unusual themes are allowed.\nFor each theme give `confidence` (low, medium or high) and quote one or more passages that show it, character for character.\nIf a passage occurs more than once, set `occurrence` to its 1-based position.\nRespond with JSON only: {\"themes\":[{\"wording\",\"confidence\",\"passages\":[{\"passage\",\"occurrence?\"}]}]}.",
  "theme-catalogue-v2": "Identify the recurring topics or narratives the source text engages with. Themes describe what the text is about, never whether it is true, and never the author's intent.\nYou are given a catalogue of known themes (id, name, definition, aliases). Report every known theme the text clearly engages with under `existing`, by its exact id.\nOnly reuse an id when the text fits that theme's definition. If a theme is related to a known one but you are not sure it is the same, propose it as new and give the related id as `possibleMatchOf`.\nReport themes not in the catalogue under `proposed` with a short name (at most six words) and a one-sentence definition of its scope.\nFor every theme quote one or more supporting passages exactly, character for character. If a passage occurs more than once, set `occurrence` to its 1-based position.\nReturning no themes is acceptable.\nconfidence must be one of the strings low, medium or high; never a numeric score. Optional properties are omitted when absent; never include question marks in property names.\nA valid empty result is {\"existing\":[],\"proposed\":[]}. A proposed entry has name, definition, confidence, and passages: [{\"passage\":\"exact source quotation\"}].\nRespond with JSON only: {\"existing\":[{\"id\",\"confidence\",\"passages\":[{\"passage\",\"occurrence?\"}]}],\"proposed\":[{\"name\",\"definition\",\"confidence\",\"possibleMatchOf?\",\"passages\":[...]}]}.",
} as const;

const prompts = {
  "theme-proposals-v2": DEFAULT_THEME_PROPOSAL_PROMPT,
  "theme-extraction-v1": DEFAULT_THEME_PROMPT,
  "theme-catalogue-v2": DEFAULT_CATALOGUE_THEME_PROMPT,
} as const;

describe("analysis prompt files (#421)", () => {
  it.each(Object.keys(EXPECTED) as Array<keyof typeof EXPECTED>)(
    "renders %s exactly as before the move",
    (name) => {
      expect(prompts[name].instructions).toBe(EXPECTED[name]);
      expect(prompts[name].instructions).toBe(loadAnalysisPrompt(name).instructions);
    },
  );

  it("records the file content hash in the prompt identity", () => {
    for (const [name, prompt] of Object.entries(prompts)) {
      const hash = createHash("sha256").update(prompt.instructions).digest("hex");
      expect(prompt.version).toBe(`analysis-${name}-sha256:${hash}`);
    }
    // Any edit changes the identity, so stale results are not reused.
    const edited = createHash("sha256").update(`${prompts["theme-proposals-v2"].instructions}!`).digest("hex");
    expect(prompts["theme-proposals-v2"].version).not.toContain(edited);
  });

  it("fails clearly when a prompt file is missing or the name is invalid", () => {
    expect(() => loadAnalysisPrompt("no-such-prompt")).toThrow(/analysis prompt file missing: no-such-prompt\.md/);
    expect(() => loadAnalysisPrompt("../escape")).toThrow(/invalid analysis prompt name/);
  });

  it("ships the prompt files with the build", () => {
    for (const name of Object.keys(EXPECTED)) {
      const text = readFileSync(new URL(`../../src/prompts/analysis/${name}.md`, import.meta.url), "utf8");
      expect(text.trim().length).toBeGreaterThan(0);
    }
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    // The compiled package copies src/prompts next to dist/prompts.
    expect(pkg.scripts.build).toContain("src/prompts");
  });
});
