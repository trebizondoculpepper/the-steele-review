import { z } from "zod";
import {
  credentialForRequest,
  type CredentialProvider,
} from "../config/credentials.js";
import {
  codeForStatus,
  ModelProviderError,
} from "../controllers/openrouter.js";
import type { CorpusRefinementBatch } from "./batch.js";
import type { UnderlyingCatalogue } from "./catalogue.js";
import type { ClassifierDecision, MappingClassifier } from "./mapping-block.js";

/**
 * TypeSafe Jev through OpenRouter's Decisions API (#860), as the mapping
 * block's classifier: one `choice` question per claim over a bounded
 * shortlist of pinned catalogue entries, plus an explicit no-match option.
 *
 * - The shortlist carries each entry's ID, definition and examples. When the
 *   catalogue has more entries than the bound, the entries sharing the most
 *   words with the claim are offered; a claim whose answer is outside the
 *   shortlist (or no match) is unmapped, never forced.
 * - Jev's confidence is turned into the block's low/medium/high bands with
 *   calibrated thresholds, so the block's own `minConfidence` still decides.
 * - Refusals and no-match answers are unmapped with a reason code.
 *   Transport, credit and provider failures throw, so Restate retries them.
 * - Each call reports its latency and, when OpenRouter returns it, its cost.
 */

export const JEV_MODEL = "typesafe/jev-1.14";
export const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
/** The no-match label; catalogue IDs never contain an underscore. */
export const NO_MATCH = "no_match";

export interface JevThresholds {
  /** Confidence at or above which a match is "high". */
  high: number;
  /** Confidence at or above which a match is "medium"; below it, "low". */
  medium: number;
}

/** Uncalibrated defaults; replaced by values chosen on the calibration set. */
export const DEFAULT_JEV_THRESHOLDS: JevThresholds = {
  high: 0.85,
  medium: 0.6,
};

export interface JevCall {
  recordId: string;
  latencyMs: number;
  /** Credits charged, when OpenRouter reports them. */
  cost?: number;
  inputTokens: number;
}

export interface JevClassifierConfig {
  apiKey: string | CredentialProvider;
  fetch?: typeof fetch;
  endpoint?: string;
  model?: string;
  /** At most this many catalogue entries are offered per claim. */
  shortlistMax?: number;
  thresholds?: JevThresholds;
  timeoutMs?: number;
  /** Receives every completed call, for call count, latency and cost. */
  onCall?: (call: JevCall) => void;
  now?: () => number;
}

const ResponseSchema = z.looseObject({
  answers: z.record(
    z.string(),
    z.union([
      z.looseObject({
        type: z.literal("choice"),
        choice: z.string(),
        confidence: z.number().min(0).max(1),
      }),
      z.looseObject({ type: z.literal("refusal") }),
    ]),
  ),
  usage: z.looseObject({
    input_tokens: z.number().int().min(0),
    cost: z.number().min(0).optional(),
  }),
});

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );

/** The bounded shortlist: every entry if it fits, else the most word-overlapping ones. */
export function shortlist(
  record: CorpusRefinementBatch["records"][number],
  catalogue: UnderlyingCatalogue,
  max: number,
): UnderlyingCatalogue["entries"] {
  if (catalogue.entries.length <= max) return catalogue.entries;
  const claim = words(`${record.statement} ${record.utterance ?? ""}`);
  const score = (e: UnderlyingCatalogue["entries"][number]) => {
    const entry = words(
      `${e.definition} ${e.examples.map((x) => x.text).join(" ")}`,
    );
    return [...claim].filter((w) => entry.has(w)).length;
  };
  return catalogue.entries
    .map((e, i) => ({ e, i, s: score(e) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, max)
    .map((x) => x.e);
}

export function jevRequest(
  record: CorpusRefinementBatch["records"][number],
  entries: UnderlyingCatalogue["entries"],
  model: string,
) {
  const criteria: Record<string, unknown> = Object.fromEntries(
    entries.map((e) => [
      e.id,
      { definition: e.definition, examples: e.examples.map((x) => x.text) },
    ]),
  );
  criteria[NO_MATCH] =
    "None of the other options expresses the same underlying idea as this claim. Choose this when unsure.";
  return {
    model,
    state: [
      `Claim: ${record.statement}`,
      ...(record.utterance
        ? [`As said in the source: ${record.utterance}`]
        : []),
    ],
    questions: {
      idea: {
        type: "choice",
        instructions:
          "Which underlying idea does this claim assert? An underlying idea is an allegation that can recur across objects, technologies or events. Match on the idea itself, not on shared topic words. The labels describe allegations, not facts.",
        criteria,
      },
    },
  };
}

export class JevClassifier implements MappingClassifier {
  readonly version: string;
  private readonly thresholds: JevThresholds;

  constructor(private readonly config: JevClassifierConfig) {
    this.thresholds = config.thresholds ?? DEFAULT_JEV_THRESHOLDS;
    const t = this.thresholds;
    this.version = `openrouter/${config.model ?? JEV_MODEL}#choice-v1;high=${t.high};medium=${t.medium};max=${config.shortlistMax ?? 20}`;
  }

  async classify(
    records: CorpusRefinementBatch["records"],
    catalogue: UnderlyingCatalogue,
  ): Promise<ClassifierDecision[]> {
    const out: ClassifierDecision[] = [];
    for (const r of records) out.push(await this.classifyOne(r, catalogue));
    return out;
  }

  /** One outbound request for one claim. */
  async classifyOne(
    record: CorpusRefinementBatch["records"][number],
    catalogue: UnderlyingCatalogue,
  ): Promise<ClassifierDecision> {
    const entries = shortlist(
      record,
      catalogue,
      this.config.shortlistMax ?? 20,
    );
    if (entries.length === 0)
      return {
        recordId: record.id,
        decision: "unmapped",
        reason: "empty-catalogue",
      };
    const now = this.config.now ?? Date.now;
    const started = now();
    const authorization = `Bearer ${credentialForRequest(this.config.apiKey, () => new ModelProviderError("unauthorised"))}`;
    let response: Response;
    try {
      response = await (this.config.fetch ?? fetch)(
        this.config.endpoint ?? JEV_ENDPOINT,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authorization,
          },
          body: JSON.stringify(
            jevRequest(record, entries, this.config.model ?? JEV_MODEL),
          ),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
          redirect: "error",
        },
      );
    } catch (error) {
      throw new ModelProviderError(
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "unavailable",
      );
    }
    if (!response.ok)
      throw new ModelProviderError(codeForStatus(response.status));
    const parsed = ResponseSchema.safeParse(
      await response.json().catch(() => undefined),
    );
    if (!parsed.success) throw new ModelProviderError("bad-response");
    this.config.onCall?.({
      recordId: record.id,
      latencyMs: now() - started,
      inputTokens: parsed.data.usage.input_tokens,
      ...(parsed.data.usage.cost !== undefined
        ? { cost: parsed.data.usage.cost }
        : {}),
    });
    const answer = parsed.data.answers.idea;
    if (!answer) throw new ModelProviderError("bad-response");
    if (answer.type === "refusal")
      return {
        recordId: record.id,
        decision: "unmapped",
        reason: "jev-refusal",
      };
    const choice = answer as { choice: string; confidence: number };
    if (choice.choice === NO_MATCH)
      return {
        recordId: record.id,
        decision: "unmapped",
        reason: "jev-no-match",
      };
    if (!entries.some((e) => e.id === choice.choice))
      return {
        recordId: record.id,
        decision: "unmapped",
        reason: "shortlist-miss",
      };
    const t = this.thresholds;
    return {
      recordId: record.id,
      decision: "mapped",
      catalogueId: choice.choice,
      confidence:
        choice.confidence >= t.high
          ? "high"
          : choice.confidence >= t.medium
            ? "medium"
            : "low",
      rationale: `jev confidence ${choice.confidence.toFixed(3)}`,
    };
  }
}
