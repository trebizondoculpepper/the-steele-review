import { z } from "zod";
import type { DiscoveryProcessor } from "../research/discovery.js";
import type { DiscoveryCapture, PartialDiscoveryBody } from "../research/discovery-data.js";
import { ResearchModelSchema } from "../config/research-model.js";
import { readCredential } from "../config/credentials.js";
import { loadPromptFile } from "../prompt-files.js";
import type { ResearchRequest } from "../research/job.js";

const Reply = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().max(2_000_000),
          annotations: z
            .array(z.object({ url_citation: z.object({ url: z.string() }).optional() }))
            .optional(),
        }),
      }),
    )
    .min(1),
  citations: z.array(z.string()).optional(),
  search_results: z.array(z.object({ url: z.string() })).optional(),
  usage: z
    .object({
      cost: z.number().nonnegative().optional(),
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export class SonarError extends Error {
  constructor(readonly code: "timeout" | "provider-error" | "invalid-report" | "budget-exceeded") {
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
}

export function sonarFromEnv(config: {
  model: string;
  timeoutMs: number;
  maxTokens: number;
}): SubjectResearchProvider {
  const model = ResearchModelSchema.parse(config.model);
  const key = readCredential("OPENROUTER_API_KEY", { required: true });
  const run: SubjectResearchProvider = async (request, capture) => {
    const signal = AbortSignal.timeout(config.timeoutMs);
    let raw: string;
    let partial: PartialDiscoveryBody | undefined;
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          model,
          max_tokens: config.maxTokens,
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
              }),
            },
          ],
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new SonarError(response.status === 402 ? "budget-exceeded" : "provider-error");
      }
      raw = await readBoundedResponse(response, 4 * 1024 * 1024, (value) => {
        partial = value;
      });
    } catch (error) {
      if (partial) await capture?.(partial);
      if (error instanceof SonarError) throw error;
      throw new SonarError(signal.aborted ? "timeout" : "provider-error");
    }

    await capture?.(raw);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new SonarError("invalid-report");
    }
    const reply = Reply.safeParse(payload);
    const message = reply.success ? reply.data.choices[0]?.message : undefined;
    if (!reply.success || !message || !message.content.trim())
      throw new SonarError("invalid-report");
    const cited = [
      ...(reply.data.citations ?? []),
      ...(message.annotations ?? []).flatMap((entry) =>
        entry.url_citation ? [entry.url_citation.url] : [],
      ),
      ...Array.from(
        message.content.matchAll(/\]\((https?:\/\/[^\s)<>]+)\)/g),
        (match) => match[1]!,
      ),
    ];
    const urls = cited.length ? cited : (reply.data.search_results ?? []).map(({ url }) => url);
    return {
      model,
      report: message.content,
      citations: urls,
      ...(reply.data.usage?.cost === undefined ? {} : { costUsd: reply.data.usage.cost }),
    };
  };
  return Object.assign(run, {
    discoveryProcessor: {
      version: "research-discovery-v1" as const,
      model,
      promptVersion: SUBJECT_PROMPT.version,
      parameters: {
        timeoutMs: config.timeoutMs,
        maxOutputTokens: config.maxTokens,
        maxResponseBytes: 4 * 1024 * 1024,
      },
    },
  });
}

async function readBoundedResponse(
  response: Response,
  max: number,
  onPartial: (value: PartialDiscoveryBody) => void,
): Promise<string> {
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
        body: Buffer.concat(chunks).subarray(0, max).toString("utf8"),
        transport: limited ? "resource-limit" : "incomplete",
      });
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
