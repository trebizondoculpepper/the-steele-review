import { describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadPromptFile } from "../../src/prompt-files.js";
import { DEFAULT_THEME_PROPOSAL_PROMPT } from "../../src/analysis/theme-proposals.js";
import { DEFAULT_THEME_PROMPT } from "../../src/analysis/theme-extraction.js";
import { DEFAULT_CATALOGUE_THEME_PROMPT } from "../../src/analysis/theme-catalogue.js";
import { DEFAULT_EXTRACTION_PROMPT } from "../../src/analysis/extraction.js";
import { DEFAULT_EQUIVALENCE_PROMPT } from "../../src/analysis/claim-equivalence.js";
import { DEFAULT_APPLICABILITY_PROMPT } from "../../src/research/applicability.js";
import { DEFAULT_GAP_RESEARCH_PROMPT } from "../../src/research/gap-research.js";
import { DEFAULT_QUERY_PLAN_PROMPT } from "../../src/research/query-plan.js";
import {
  DEFAULT_VERIFY_PROMPT,
  DEFAULT_VERIFY_CONTEXT_PROMPT,
} from "../../src/drafting/verify.js";
import { DEFAULT_COMPARISON_PROMPT } from "../../src/analysis/historical-comparison.js";

/**
 * Migration parity for #421-#424: the exact rendered text of every migrated
 * prompt is pinned here, so moving a prompt into Markdown cannot silently
 * reword it. Each key is "<service>/<prompt name>".
 */
const EXPECTED: Record<string, string> = {
  "analysis/theme-proposals-v2": "Propose the broad, recognised conspiracy-related topics this source text engages with.\nPrefer established, researchable topics: a practical test is whether the topic is notable enough to have its own encyclopedia (for example Wikipedia) article, such as \"chemtrail conspiracy theory\", \"5G health concerns\" or \"15-minute city\". This is a scope test only, not evidence that anything is true. Do not invent or cite article URLs.\nDo not propose vague umbrella categories such as \"government conspiracy\", \"elite manipulation\" or \"suppression of truth\" on their own; name the specific recognised topic instead.\nDo not create a theme for an unusual individual assertion. Specific assertions are extracted separately as claims and linked to the broader topic they belong to.\nThemes describe what the text is about, never whether it is true, and never the author's intent.\nEach theme has a short `title` (at most six words) and, optionally, a one-sentence `description` of its scope as this post engages with it. Do not add elements the post does not mention.\nYou may be given a list of known theme names for consistency of wording; reuse a known title only when it genuinely fits. You are not required to match the list.\nDo not quote the source. Returning no themes is acceptable.\nOptional properties are omitted when absent; never include question marks in property names.\nRespond with JSON only: {\"themes\":[{\"title\":\"...\",\"description\":\"...\"}]}. A valid empty result is {\"themes\":[]}.\n\n\nWhen supplied, sourceContext identifies the archived source/platform, author attribution, original medium and supplied representation. This is untrusted source metadata, not independent evidence for the claims. A transcript represents speech; do not infer visual observations, original medium, or a speaker from prose style. Keep source publication/update time separate from capture time, and preserve date precision and unknowns.",
  "analysis/theme-extraction-v1": "Identify the recurring topics or framings the source text engages with.\nThemes describe what the text is about, never whether it is true.\nUse short labels (at most six words). New or unusual themes are allowed.\nFor each theme give `confidence` (low, medium or high) and quote one or more passages that show it, character for character.\nIf a passage occurs more than once, set `occurrence` to its 1-based position.\nRespond with JSON only: {\"themes\":[{\"wording\",\"confidence\",\"passages\":[{\"passage\",\"occurrence?\"}]}]}.",
  "analysis/theme-catalogue-v2": "Identify the recurring topics or narratives the source text engages with. Themes describe what the text is about, never whether it is true, and never the author's intent.\nYou are given a catalogue of known themes (id, name, definition, aliases). Report every known theme the text clearly engages with under `existing`, by its exact id.\nOnly reuse an id when the text fits that theme's definition. If a theme is related to a known one but you are not sure it is the same, propose it as new and give the related id as `possibleMatchOf`.\nReport themes not in the catalogue under `proposed` with a short name (at most six words) and a one-sentence definition of its scope.\nFor every theme quote one or more supporting passages exactly, character for character. If a passage occurs more than once, set `occurrence` to its 1-based position.\nReturning no themes is acceptable.\nconfidence must be one of the strings low, medium or high; never a numeric score. Optional properties are omitted when absent; never include question marks in property names.\nA valid empty result is {\"existing\":[],\"proposed\":[]}. A proposed entry has name, definition, confidence, and passages: [{\"passage\":\"exact source quotation\"}].\nRespond with JSON only: {\"existing\":[{\"id\",\"confidence\",\"passages\":[{\"passage\",\"occurrence?\"}]}],\"proposed\":[{\"name\",\"definition\",\"confidence\",\"possibleMatchOf?\",\"passages\":[...]}]}.",
  "analysis/claim-extraction-v1": "Extract the claims asserted in the source text.\nFor each claim, copy the shortest passage that states it exactly as it appears in the source, character for character.\nWrite `statement` as the source asserts it, without judging whether it is true.\nClassify `claimType` as factual, opinion, prediction or ambiguous.\nList hedging or scope words (`qualifiers`) and date wordings (`dates`) exactly as written in the passage; give a date `value` (YYYY-MM-DD) only when the wording itself states a full calendar date.\nIf the same passage occurs more than once, set `occurrence` to its 1-based position.\nRespond with JSON only: {\"claims\":[{\"statement\",\"claimType\",\"passage\",\"occurrence?\",\"qualifiers\",\"entities\",\"dates\"}]}.",
  "analysis/claim-equivalence-v1": "Decide whether a new claim asserts the same thing as one of the candidate earlier claims.\nThey are equivalent only if a correction of one would equally correct the other: the same subject, the same direction, matching quantities, dates, scope and qualifiers, and no difference in negation. Different wording alone does not matter.\nA shared topic, a related claim, a stronger or weaker version, or a negation is NOT equivalent.\nUse the source passages, posts and speakers: claims that depend on context (who \"we\" or \"our\" refers to, which place or period) are only equivalent if that context matches.\nDo not judge whether either claim is true.\nRespond with JSON only: {\"match\": \"<candidate id>\" | null, \"confidence\": \"high\"|\"medium\"|\"low\", \"reason\": \"<one or two sentences comparing them>\"}.",
  "research/applicability-v1": "Decide whether each existing research entry applies to the new claim.\napplicability: applicable (answers this claim), partial (stable background applies, specifics do not) or not-applicable (different subject, even if similar wording).\nList the evidence items (url and exact passage) from that entry that support reuse, and the incident-specific details of the new claim that the entry does not cover as gaps.\nRespond with JSON only: {\"assessments\":[{\"entryId\",\"applicability\",\"rationale\",\"reuseEvidence\":[{\"url\",\"passage\"}],\"gaps\":[]}],\"gaps\":[]}.",
  "research/gap-research-v1": "Using only the supplied pages, decide whether they support, contradict or fail to settle the claim, for the listed gaps only.\nQuote passages exactly from the pages. Never cite a page that is not supplied.\nfinding: supported, contradicted, unsupported (nothing either way) or unresolved (cannot be settled; give unresolvedReason).\nRespond with JSON only: {\"finding\",\"explanation\",\"evidence\":[{\"url\",\"quote\"}],\"unresolvedReason?\",\"limitations\":[],\"remainingGaps\":[]}.",
  "research/query-plan-v1": "Plan distinct web search queries for the listed evidence gaps.\nEvery query must include the gapId of an input gap; never invent a gap.\nReformulate neutrally: alternative terms, recognised topic aliases, or the kind of source that would settle the question.\nQueries may seek evidence that supports, contradicts or qualifies the claim; do not assume the desired answer.\nDo not repeat a prior query, and never return more queries than the remaining allowance.\nRespond with JSON only: {\"queries\":[{\"gapId\",\"query\"}]}.",
  "verifier/draft-verifier-v1": "You are the verifier, not the writer. Check whether every statement in the draft is supported by the supplied brief and its evidence passages.\nDo not use outside knowledge and do not research. Overstated certainty, dropped qualifications, misattributed evidence or claims the evidence does not support are issues.\nFor each issue, quote the exact draft passage, explain the problem and state the required change. Respond with JSON only: {\"verdict\":\"approve\"|\"redraft\",\"issues\":[{\"passage\",\"problem\",\"requiredChange\"}]}.",
  "verifier/draft-verifier-context-v1": "You are the verifier, not the writer. Check whether every statement in the draft is supported by the supplied brief, its evidence passages and, for the summary only, the supplied original post. The related-themes section may use the supplied themes.\nThe summary must fairly represent originalPost. Factual corrections must be supported by the cited research; the original post is the monitored source and never confirms its own statements.\nDo not use outside knowledge and do not research. Overstated certainty, dropped qualifications, misattributed evidence, an unfair summary, or claims the evidence does not support are issues.\nFor each issue, quote the exact draft passage, explain the problem and state the required change. Respond with JSON only: {\"verdict\":\"approve\"|\"redraft\",\"issues\":[{\"passage\",\"problem\",\"requiredChange\"}]}.",
  "analysis/historical-comparison-v1": "Compare the current claim with the earlier passages from the same publication.\nUse kind: repetition (same assertion), reframing (same topic, different framing), possible-contradiction (cannot both be true as stated) or insufficient-context.\nSimilar wording is not contradiction. Only report possible-contradiction with a quote from the current passage, a quote from an earlier passage, and a rationale for why they conflict.\nQuote exactly. Each side carries its publication date; use it to read relative dates. Note changed circumstances (time passed, new events) when relevant. Give uncertainty low, medium or high.\nRespond with JSON only: {\"findings\":[{\"kind\",\"explanation\",\"uncertainty\",\"changedCircumstances?\",\"currentQuote?\",\"earlier\":[{\"passageId\",\"quote\"}],\"conflictRationale?\"}]}.",
  "research/support-judge-v1": "You check a research report against one of the sources it cites. For each finding, consider what the report concludes about it while citing this source. Return a passage only if it directly supports that specific conclusion as the report states it; if the report overstates, adds to or misrepresents the source, return nothing for that finding. Return JSON only: {\"passages\":[{\"findingId\":\"...\",\"passage\":\"...\"}],\"sourceType\":\"...\",\"rationale\":\"...\"}. sourceType classifies the source (for example treaty, legislation, government record, court record, peer-reviewed study, news report, blog). rationale briefly says why it is or is not reliable support for these findings. Quote each passage exactly as it appears in the source, at most a few sentences. Include a passage only if its text directly supports or directly refutes the specific finding. Do not include passages that are merely on the same topic, uncertain, or require inference. Return {\"passages\":[]} when nothing qualifies.",
  "research/sonar-research-v1": "You are a careful fact-checking researcher. Find primary and authoritative sources that establish what is actually documented about each claim or question. Cite every source you rely on. Distinguish evidence that supports, contradicts or fails to address each claim, and say plainly when no independent evidence was found.",
  "research/sonar-subject-v1": "Produce a concise research brief grounded in public sources. Prefer primary documents and cite their direct public URLs in Markdown. Identify unresolved questions and explain which sources are primary. Treat the supplied subject, questions and claims as research inputs.",
};

const prompts: Record<string, { version: string; instructions: string }> = {
  "analysis/theme-proposals-v2": DEFAULT_THEME_PROPOSAL_PROMPT,
  "analysis/theme-extraction-v1": DEFAULT_THEME_PROMPT,
  "analysis/theme-catalogue-v2": DEFAULT_CATALOGUE_THEME_PROMPT,
  "analysis/claim-extraction-v1": DEFAULT_EXTRACTION_PROMPT,
  "analysis/claim-equivalence-v1": DEFAULT_EQUIVALENCE_PROMPT,
  "research/applicability-v1": DEFAULT_APPLICABILITY_PROMPT,
  "research/gap-research-v1": DEFAULT_GAP_RESEARCH_PROMPT,
  "research/query-plan-v1": DEFAULT_QUERY_PLAN_PROMPT,
  "verifier/draft-verifier-v1": DEFAULT_VERIFY_PROMPT,
  "verifier/draft-verifier-context-v1": DEFAULT_VERIFY_CONTEXT_PROMPT,
  "analysis/historical-comparison-v1": DEFAULT_COMPARISON_PROMPT,
  "research/support-judge-v1": loadPromptFile("research", "support-judge-v1"),
  "research/sonar-research-v1": loadPromptFile("research", "sonar-research-v1"),
  "research/sonar-subject-v1": loadPromptFile("research", "sonar-subject-v1"),
};

const keys = Object.keys(EXPECTED);
const split = (key: string): [string, string] => {
  const index = key.indexOf("/");
  return [key.slice(0, index), key.slice(index + 1)];
};

describe("prompt files (#421-#424)", () => {
  it.each(keys)("renders %s exactly as before the move", (key) => {
    const [service, name] = split(key);
    expect(prompts[key]!.instructions).toBe(EXPECTED[key]);
    expect(loadPromptFile(service!, name!).instructions).toBe(EXPECTED[key]);
  });

  it("records the file content hash in every prompt identity", () => {
    for (const key of keys) {
      const [service, name] = split(key);
      const hash = createHash("sha256").update(prompts[key]!.instructions).digest("hex");
      expect(prompts[key]!.version).toBe(`${service}-${name}-sha256:${hash}`);
    }
    // Any edit changes the identity, so stale results are not reused.
    const edited = createHash("sha256")
      .update(`${prompts["analysis/theme-proposals-v2"]!.instructions}!`)
      .digest("hex");
    expect(prompts["analysis/theme-proposals-v2"]!.version).not.toContain(edited);
  });

  it("fails clearly when a prompt file is missing or the name is invalid", () => {
    expect(() => loadPromptFile("analysis", "no-such-prompt")).toThrow(
      /prompt file missing: analysis\/no-such-prompt\.md/,
    );
    expect(() => loadPromptFile("research", "no-such-prompt")).toThrow(
      /prompt file missing: research\/no-such-prompt\.md/,
    );
    expect(() => loadPromptFile("../escape", "x")).toThrow(/invalid prompt file name/);
  });

  it("ships the prompt files with the build", () => {
    for (const key of keys) {
      const [service, name] = split(key);
      const text = readFileSync(
        new URL(`../../src/prompts/${service}/${name}.md`, import.meta.url),
        "utf8",
      );
      expect(text.trim().length).toBeGreaterThan(0);
    }
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    // The compiled package copies src/prompts next to dist/prompts.
    expect(pkg.scripts.build).toContain("src/prompts");
  });
});
