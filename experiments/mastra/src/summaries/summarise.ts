import type { GitRepository } from "../common/git/index.js";
import type { ChatModel } from "../common/model/openrouter.js";
import type { ArticleRecord } from "../content/substack-article.js";
import { loadWritingPrompt } from "../writing/prompt.js";
import {
  MAX_MODEL_ATTEMPTS,
  normalise,
  operationId,
  runOperation,
  sha256,
  type OperationMeta,
  type Rejection,
  type SourceInfo,
  type SourceRef,
  type Timings,
  type Usage,
} from "../extraction/operation.js";

/**
 * A short, neutral summary of one retained source version (#962), on the shared
 * extraction operation (src/extraction/operation.ts).
 *
 * Text provenance: a usable transcript is summarised as a transcript; a
 * recording without one is summarised from its description (and the summary
 * says so); a written post from its article text. A source with no text at all
 * is recorded as skipped. Assertions are attributed to the source.
 *
 *   summaries/<platform>/<source>/<item>/<operation>/<summaryId>.json   (indexed)
 *   summaries/<platform>/<source>/<item>/<operation>/operation.meta     (not indexed)
 *
 * The operation ID hashes the exact source blob, prompt and model, so repeating
 * intake or recovering from an interruption reuses the completed summary, and a
 * changed source version gets its own summary.
 */

export const SUMMARIES = "summaries";
export const PROMPT_NAME = "source-summary-v1";
export const DEFAULT_SUMMARY_MODEL = "deepseek/deepseek-v4.1-flash";
export const MAX_SUMMARY_WORDS = 150;

export const SUMMARIES_DECLARATION = {
  mappingVersion: 1,
  mapping: {
    dynamic: "strict",
    properties: {
      schema: { type: "keyword" },
      summaryId: { type: "keyword" },
      operation: { type: "keyword" },
      summary: { type: "text" },
      title: { type: "text" },
      url: { type: "keyword" },
      publishedAt: { type: "date" },
      source: {
        type: "object",
        properties: {
          path: { type: "keyword" },
          commit: { type: "keyword" },
          blob: { type: "keyword" },
          sourceId: { type: "keyword" },
          itemId: { type: "keyword" },
          url: { type: "keyword" },
          textType: { type: "keyword" },
        },
      },
      prompt: { type: "keyword" },
      model: { type: "keyword" },
      createdAt: { type: "date" },
    },
  },
} as const;

export interface SourceSummary {
  schema: "source-summary-v1";
  summaryId: string;
  operation: string;
  summary: string;
  title: string;
  /** The item's original URL, as the feed gave it. */
  url: string;
  publishedAt: string | null;
  source: SourceInfo;
  prompt: string;
  model: string;
  createdAt: string;
}

export interface SummariseResult {
  operation: string;
  outcome: OperationMeta["outcome"];
  reused: boolean;
  summary: { summaryId: string; text: string; path: string } | null;
  rejected: Rejection[];
  warnings: string[];
  usage: Usage;
  timings: Timings;
  reason?: string;
  commit?: string;
}

export interface SummariseOptions {
  repo: GitRepository;
  model: ChatModel;
  modelId?: string;
  branch?: string;
  now?: () => Date;
}

/** Which text to summarise, and what kind it is. */
export function selectSummaryText(record: ArticleRecord): { text: string; textType: SourceInfo["textType"] } | { skip: string } {
  if (record.transcript?.status === "usable" && record.transcript.content?.trim()) return { text: record.transcript.content, textType: "transcript" };
  if (record.text?.content?.trim()) return { text: record.text.content, textType: record.text.role === "description" ? "description" : "article" };
  return { skip: record.representation === "recording" ? `no-usable-text: ${record.transcript?.status ?? "missing"}` : "no-article-text" };
}

export async function summariseSource(ref: SourceRef, options: SummariseOptions): Promise<SummariseResult> {
  const result = await runOperation<SourceSummary>(
    {
      collection: SUMMARIES,
      declaration: SUMMARIES_DECLARATION,
      metaSchema: "summary-operation-v1",
      promptName: PROMPT_NAME,
      maxTokens: 600,
      temperature: 0.2,
      select: selectSummaryText,
      buildUser: (prompt, record, input, textType) =>
        prompt.userTemplate
          .replace("{{source.title}}", () => record.title ?? "")
          .replace("{{source.medium}}", () => record.medium ?? "unknown")
          .replace("{{source.textType}}", () => textType)
          .replace("{{source.text}}", () => input.replaceAll("</source>", "&lt;/source>")),
      validate: (parsed, ctx) => {
        const value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { summary?: unknown }).summary : undefined;
        if (typeof value !== "string" || !normalise(value)) return { docs: [], rejected: [{ rank: 1, reason: "no-summary" }] };
        const text = normalise(value);
        const words = text.split(" ").length;
        if (words < 10) return { docs: [], rejected: [{ rank: 1, reason: "summary-too-short" }] };
        const summaryId = sha256(`${ctx.source.blob}\nsummary`).slice(0, 16);
        return {
          rejected: [],
          warnings: words > MAX_SUMMARY_WORDS ? ["summary-over-length"] : [],
          docs: [
            {
              id: summaryId,
              doc: {
                schema: "source-summary-v1",
                summaryId,
                operation: ctx.operation,
                summary: text,
                title: ctx.record.title,
                url: ctx.record.url,
                publishedAt: ctx.record.publishedAt ?? null,
                source: ctx.source,
                prompt: ctx.prompt,
                model: ctx.model,
                createdAt: ctx.createdAt,
              },
            },
          ],
        };
      },
      label: (doc) => doc.summary,
    },
    ref,
    { repo: options.repo, model: options.model, modelId: options.modelId ?? DEFAULT_SUMMARY_MODEL, branch: options.branch, now: options.now },
  );
  const { items, ...rest } = result;
  const item = items[0];
  return { ...rest, summary: item ? { summaryId: item.id, text: item.label, path: item.path } : null };
}

/** At most this many unfinished summaries are retried per workflow run. */
export const MAX_SUMMARY_RETRIES_PER_RUN = 10;

/**
 * Retained source versions whose summary, for the current prompt and requested
 * model, is missing or unfinished (model-failed with attempts left), as
 * references at the branch head. The queue is derived from the retained
 * sources themselves, not from saved metadata, so it also covers a version
 * whose attempt reservation never committed (a technical failure before any
 * operation.meta existed). Each candidate's expected operation ID is computed
 * exactly as summariseSource computes it, so superseded operations (an earlier
 * prompt or model) are never queued, and the provider's resolved model name in
 * the metadata does not matter.
 */
export async function unfinishedSummaries(
  repo: GitRepository,
  branch = "main",
  limit = MAX_SUMMARY_RETRIES_PER_RUN,
  modelId: string = DEFAULT_SUMMARY_MODEL,
): Promise<SourceRef[]> {
  const head = await repo.resolve(`refs/heads/${branch}`);
  if (!head) return [];
  const prompt = loadWritingPrompt(PROMPT_NAME).identity;
  const articles = (await repo.listFiles(head, "raw_content")).filter((e) =>
    /^raw_content\/[a-z0-9-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/article\.json$/.test(e.path),
  );
  const refs: SourceRef[] = [];
  for (const entry of articles) {
    if (refs.length >= limit) break;
    const folder = entry.path.replace(/^raw_content\//, `${SUMMARIES}/`).replace(/\/article\.json$/, "");
    const metaPath = `${folder}/${operationId(entry.blob, prompt, modelId)}/operation.meta`;
    const text = await repo.readText(head, metaPath);
    if (!text) {
      refs.push({ path: entry.path, commit: head });
      continue;
    }
    let meta: OperationMeta;
    try {
      meta = JSON.parse(text.text) as OperationMeta;
    } catch {
      continue;
    }
    if (meta.outcome === "model-failed" && (meta.attempts ?? 0) < MAX_MODEL_ATTEMPTS) refs.push({ path: entry.path, commit: head });
  }
  return refs;
}
