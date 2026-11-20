import { z } from "zod";
import type { ExtractionModelProvider } from "../analysis/extraction.js";
import {
  type Finding,
  SUPPORT_PROMPT_VERSION,
  type SupportJudge,
  type SupportJudgement,
} from "./runner.js";

/**
 * Model-based support check (#216, prompt `source-support-v1`). The model
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

const SYSTEM = [
  "You check a research report against one of the sources it cites.",
  "For each finding, consider what the report concludes about it while citing this source.",
  "Return a passage only if it directly supports that specific conclusion as the report states it;",
  "if the report overstates, adds to or misrepresents the source, return nothing for that finding.",
  'Return JSON only: {"passages":[{"findingId":"...","passage":"..."}],"sourceType":"...","rationale":"..."}.',
  "sourceType classifies the source (for example treaty, legislation, government record, court record, peer-reviewed study, news report, blog).",
  "rationale briefly says why it is or is not reliable support for these findings.",
  "Quote each passage exactly as it appears in the source, at most a few sentences.",
  "Include a passage only if its text directly supports or directly refutes the specific finding.",
  "Do not include passages that are merely on the same topic, uncertain, or require inference.",
  'Return {"passages":[]} when nothing qualifies.',
].join(" ");

export const SUPPORT_JUDGE_PROMPT_VERSION = SUPPORT_PROMPT_VERSION;

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
