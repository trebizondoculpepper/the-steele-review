import { type ResearchTokensReader } from "../config/research-tokens.js";
import { ResearchMaxTokensSchema } from "../config/settings.js";
import { assertResearchEffort, researchEffortFromEnv } from "../research/sonar.js";
import { replaySonarDiscovery } from "./sonar-discovery-replay.js";
import type { DiscoveryProcessor } from "../research/discovery.js";
import type { DiscoveryCapture, PartialDiscoveryBody } from "../research/discovery-data.js";
import { ResearchModelSchema } from "../config/research-model.js";
import { credentialForRequest, liveCredential } from "../config/credentials.js";
import { loadPromptFile } from "../prompt-files.js";
import type { ResearchRequest } from "../research/job.js";

export class SonarError extends Error {
  constructor(
    readonly code:
      | "timeout"
      | "provider-error"
      | "invalid-report"
      | "budget-exceeded"
      | "rate-limited"
      | "unauthorised"
      | "bad-request",
    readonly status?: number,
  ) {
    super(code);
  }
}

export interface SonarReport {
  model: string;
  report: string;
  citations: string[];
  costUsd?: number;
}

const SUBJECT_PROMPT = loadPromptFile("research", "sonar-subject-v1");
export const SUBJECT_RESEARCH_PROMPT_VERSION = SUBJECT_PROMPT.version;
export interface SubjectResearchProvider {
  (request: ResearchRequest, capture?: DiscoveryCapture): Promise<SonarReport>;
  readonly discoveryProcessor?: DiscoveryProcessor;
  readonly liveTokens?: boolean;
}

export function sonarFromEnv(config: {
  model: string;
  timeoutMs: number;
  maxTokens: number;
  tokens?: ResearchTokensReader;
}): SubjectResearchProvider {
  const model = ResearchModelSchema.parse(config.model);
  const fixedTokens = ResearchMaxTokensSchema.parse(config.maxTokens);
  // Explicit reasoning effort (#662): refused before any paid request when
  // this model's route cannot honour it.
  const effort = researchEffortFromEnv(process.env);
  assertResearchEffort(model, effort);
  // Read live before each request (#738), never retained from start-up.
  const key = liveCredential("OPENROUTER_API_KEY");
  const run: SubjectResearchProvider = async (request, capture) => {
    const appliedTokens = config.tokens ? await config.tokens() : undefined;
    const signal = AbortSignal.timeout(config.timeoutMs);
    let bytes: Buffer;
    let partial: PartialDiscoveryBody | undefined;
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${credentialForRequest(key, () => new SonarError("unauthorised"))}`,
          "content-type": "application/json",
        },
        signal,
        body: JSON.stringify({
          model,
          max_tokens: appliedTokens?.maxOutputTokens ?? fixedTokens,
          ...(effort ? { reasoning: { effort } } : {}),
          messages: [
            {
              role: "system",
              content: SUBJECT_PROMPT.instructions,
            },
            {
              role: "user",
              content: JSON.stringify({
                subject: request.subject,
                brief: request.brief,
                question: request.question,
                claims: request.claims,
                ...(request.canonicalNeeds ? { canonicalNeeds: request.canonicalNeeds } : {}),
              }),
            },
          ],
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new SonarError(
          response.status === 402
            ? "budget-exceeded"
            : response.status === 429
              ? "rate-limited"
              : response.status === 401 || response.status === 403
                ? "unauthorised"
                : response.status === 400
                  ? "bad-request"
                  : "provider-error",
          response.status,
        );
      }
      bytes = await readBoundedResponse(response, 4 * 1024 * 1024, (value) => {
        partial = value;
      });
    } catch (error) {
      if (partial) await capture?.({ ...partial, ...(appliedTokens ? { appliedTokens } : {}) });
      if (error instanceof SonarError) throw error;
      throw new SonarError(signal.aborted ? "timeout" : "provider-error");
    }

    await capture?.({
      representation: "provider-json",
      body: bytes.toString("base64"),
      encoding: "base64",
      transport: "complete",
      ...(appliedTokens ? { appliedTokens } : {}),
    });
    const replay = replaySonarDiscovery(bytes.toString("utf8"), model);
    if (replay.validation !== "valid" || !replay.data) throw new SonarError("invalid-report");
    const data = replay.data;
    const cited = [
      ...data.citations,
      ...data.annotationUrls,
      ...Array.from(data.report.matchAll(/\]\((https?:\/\/[^\s)<>]+)\)/g), (match) => match[1]!),
    ];
    return {
      model: data.model,
      report: data.report,
      citations: cited.length ? cited : data.searchResultUrls,
      ...(data.usage?.costUsd === undefined ? {} : { costUsd: data.usage.costUsd }),
    };
  };
  return Object.assign(run, {
    liveTokens: !!config.tokens,
    discoveryProcessor: {
      version: "research-discovery-v1" as const,
      model,
      promptVersion: SUBJECT_PROMPT.version,
      parameters: {
        timeoutMs: config.timeoutMs,
        ...(config.tokens ? {} : { maxOutputTokens: fixedTokens }),
        maxResponseBytes: 4 * 1024 * 1024,
      },
    },
  });
}

async function readBoundedResponse(
  response: Response,
  max: number,
  onPartial: (value: PartialDiscoveryBody) => void,
): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new SonarError("invalid-report");
  const chunks: Uint8Array[] = [];
  let size = 0,
    limited = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size > max) {
        limited = true;
        await reader.cancel().catch(() => undefined);
        throw new SonarError("invalid-report");
      }
    }
  } catch (error) {
    if (size)
      onPartial({
        representation: "provider-json",
        body: Buffer.concat(chunks).subarray(0, max).toString("base64"),
        encoding: "base64",
        transport: limited ? "resource-limit" : "incomplete",
      });
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
