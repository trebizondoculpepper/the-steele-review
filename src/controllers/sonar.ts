import { z } from "zod";
import { ResearchModelSchema } from "../config/research-model.js";
import { readCredential } from "../config/credentials.js";
import { loadPromptFile } from "../prompt-files.js";
import type { ResearchRequest } from "../research/job.js";

const Reply = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().trim().min(1).max(100_000),
          annotations: z
            .array(z.object({ url_citation: z.object({ url: z.string() }).optional() }))
            .optional(),
        }),
      }),
    )
    .min(1),
  citations: z.array(z.string()).optional(),
  search_results: z.array(z.object({ url: z.string() })).optional(),
  usage: z.object({ cost: z.number().nonnegative().optional() }).optional(),
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

export function sonarFromEnv(config: {
  model: string;
  timeoutMs: number;
  maxTokens: number;
}): (request: ResearchRequest) => Promise<SonarReport> {
  const model = ResearchModelSchema.parse(config.model);
  const key = readCredential("OPENROUTER_API_KEY", { required: true });
  return async (request) => {
    const signal = AbortSignal.timeout(config.timeoutMs);
    let payload: unknown;
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
      payload = await response.json();
    } catch (error) {
      if (error instanceof SonarError) throw error;
      throw new SonarError(signal.aborted ? "timeout" : "provider-error");
    }

    const reply = Reply.safeParse(payload);
    const message = reply.success ? reply.data.choices[0]?.message : undefined;
    if (!reply.success || !message) throw new SonarError("invalid-report");
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
}
