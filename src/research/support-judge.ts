import { z } from "zod";
import type { ExtractionModelProvider } from "../analysis/extraction.js";
import { loadPromptFile } from "../prompt-files.js";
import type { Finding, SupportJudge, SupportJudgement } from "./runner.js";

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

const SUPPORT_PROMPT = loadPromptFile("research", "support-judge-v1");
const SYSTEM = SUPPORT_PROMPT.instructions;

export const SUPPORT_JUDGE_PROMPT_VERSION = SUPPORT_PROMPT.version;

export class ModelSupportJudge implements SupportJudge {
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
}
