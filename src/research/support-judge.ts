import { promptIdentity } from "../drafting/prompt-identity.js";
import { z } from "zod";
import type { ExtractionModelProvider } from "../analysis/extraction.js";
import { loadPromptFile } from "../prompt-files.js";
import type { BundleJudgement, Finding, SupportJudge, SupportJudgement } from "./runner.js";

/**
 * Model-based support check (#216, prompt file `support-judge-v1`). The model
 * may only quote passages; the runner then keeps a passage only when it
 * appears verbatim in the archived source and names a known finding. A
 * malformed answer is treated as "no support found" for that source.
 */

const Answer = z.object({
  passages: z
    .array(z.object({ findingId: z.string().min(1), passage: z.string().min(1).max(4000) }))
    .max(50),
  sourceType: z.string().min(1).max(100).optional(),
  rationale: z.string().min(1).max(2000).optional(),
});

const BundleAnswer = z.object({
  sources: z
    .array(
      z.object({
        index: z.number().int().min(0),
        relevance: z.number().int().min(1).optional(),
        note: z.string().max(2000).optional(),
        sourceType: z.string().min(1).max(100).optional(),
        passages: z
          .array(z.object({ findingId: z.string().min(1), passage: z.string().min(1).max(4000) }))
          .max(50)
          .default([]),
      }),
    )
    .max(500),
  brief: z.string().max(4000).optional(),
});

const BUNDLE_PROMPT = loadPromptFile("research", "support-bundle-v1");

const SUPPORT_PROMPT = loadPromptFile("research", "support-judge-v1");
const SYSTEM = SUPPORT_PROMPT.instructions;

export const SUPPORT_JUDGE_PROMPT_VERSION = SUPPORT_PROMPT.version;

export class ModelSupportJudge implements SupportJudge {
  // Covers both operations' prompts, so a change to either is never reused (#795).
  readonly identity = promptIdentity(
    BUNDLE_PROMPT.version,
    `${BUNDLE_PROMPT.instructions}\n---\n${SYSTEM}`,
  );
  constructor(
    private readonly provider: ExtractionModelProvider,
    private readonly maxSourceChars = 60_000,
  ) {}

  async judge(
    input: { findings: Finding[]; report: string; url: string; source: string },
    signal: AbortSignal,
  ): Promise<SupportJudgement> {
    const user = [
      "Findings:",
      ...input.findings.map((f) => `- [${f.id}] ${f.statement}`),
      "",
      "Research report:",
      input.report.slice(0, 30_000),
      "",
      `Source (${input.url}):`,
      input.source.slice(0, this.maxSourceChars),
    ].join("\n");
    const raw = await this.provider.complete(
      { system: SYSTEM, user, maxOutputChars: 20_000 },
      signal,
    );
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    try {
      return Answer.parse(JSON.parse(json));
    } catch {
      return { passages: [] };
    }
  }

  /** One relevance assessment for the whole bundle (#795). */
  async judgeBundle(
    input: {
      findings: Finding[];
      report: string;
      sources: { index: number; url: string; excerpt: string }[];
    },
    signal: AbortSignal,
  ): Promise<BundleJudgement> {
    const user = [
      "Findings:",
      ...input.findings.map((f) => `- [${f.id}] ${f.statement}`),
      "",
      "Research report (excerpt):",
      input.report,
      "",
      ...input.sources.flatMap((s) => [`Source ${s.index} (${s.url}):`, s.excerpt, ""]),
    ].join("\n");
    const raw = await this.provider.complete(
      { system: BUNDLE_PROMPT.instructions, user, maxOutputChars: 24_000 },
      signal,
    );
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const parsed = BundleAnswer.safeParse(
      (() => {
        try {
          return JSON.parse(json);
        } catch {
          return undefined;
        }
      })(),
    );
    if (!parsed.success) throw new Error("support bundle: malformed answer");
    return {
      sources: parsed.data.sources.map((s) => ({
        index: s.index,
        passages: s.passages,
        ...(s.relevance !== undefined ? { relevance: s.relevance } : {}),
        ...(s.note ? { note: s.note } : {}),
        ...(s.sourceType ? { sourceType: s.sourceType } : {}),
      })),
      ...(parsed.data.brief ? { brief: parsed.data.brief } : {}),
    };
  }
}
