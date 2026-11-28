import type { ChatModel } from "../common/model/openrouter.js";
import {
  MAX_MODEL_ATTEMPTS,
  MAX_SOURCE_CHARS,
  normalise,
  normaliseForQuotes,
  runOperation,
  sha256,
  type OperationMeta as SharedMeta,
  type Rejection,
  type SourceInfo,
  type SourceRef,
  type Timings,
  type Usage,
} from "../extraction/operation.js";

export { MAX_MODEL_ATTEMPTS, MAX_SOURCE_CHARS, type SourceRef };

/**
 * Theme proposals for one retained source version (#960), on the shared
 * extraction operation (src/extraction/operation.ts), which provides the source
 * reading, reuse, attempt reservation, retries and saving.
 *
 * One bounded model call proposes up to MAX_THEMES themes; each is validated on
 * its own and every evidence quote must occur verbatim in the source (one
 * invented quote rejects the whole proposal). Valid proposals are saved even
 * when others are rejected:
 *
 *   themes/<platform>/<source>/<item>/<operation>/<themeId>.json   (indexed)
 *   themes/<platform>/<source>/<item>/<operation>/operation.meta   (not indexed)
 *
 * Theme IDs hash the source blob and the normalised title, so they are stable.
 */

export const THEMES = "themes";
export const PROMPT_NAME = "theme-proposals-v1";
export const DEFAULT_THEME_MODEL = "deepseek/deepseek-v4.1-flash";
export const MAX_THEMES = 8;

export const THEMES_DECLARATION = {
  mappingVersion: 1,
  mapping: {
    dynamic: "strict",
    properties: {
      schema: { type: "keyword" },
      themeId: { type: "keyword" },
      operation: { type: "keyword" },
      rank: { type: "integer" },
      title: { type: "text" },
      description: { type: "text" },
      evidence: { type: "text" },
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

export interface ThemeProposal {
  schema: "theme-proposal-v1";
  themeId: string;
  operation: string;
  rank: number;
  title: string;
  description: string;
  evidence: string[];
  source: SourceInfo;
  prompt: string;
  model: string;
  createdAt: string;
}

export type OperationMeta = SharedMeta;

export interface ProposeResult {
  operation: string;
  outcome: SharedMeta["outcome"];
  reused: boolean;
  themes: Array<{ themeId: string; title: string; path: string }>;
  rejected: Rejection[];
  warnings: string[];
  usage: Usage;
  timings: Timings;
  reason?: string;
  commit?: string;
}

export interface ProposeOptions {
  repo: import("../common/git/index.js").GitRepository;
  model: ChatModel;
  modelId?: string;
  branch?: string;
  now?: () => Date;
}

/** A quote counts when it occurs in the source after whitespace and quote-mark normalisation. */
function quoteFound(quote: string, sourceNormalised: string): boolean {
  const q = normaliseForQuotes(quote);
  return q.length >= 10 && sourceNormalised.includes(q);
}

function validate(raw: unknown, sourceNormalised: string): { valid: Array<{ rank: number; title: string; description: string; evidence: string[] }>; rejected: OperationMeta["rejected"] } {
  const valid: Array<{ rank: number; title: string; description: string; evidence: string[] }> = [];
  const rejected: OperationMeta["rejected"] = [];
  const themes = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { themes?: unknown }).themes : undefined;
  if (!Array.isArray(themes)) return { valid, rejected: [{ rank: 0, reason: "no-themes-array" }] };
  const seen = new Set<string>();
  themes.slice(0, MAX_THEMES).forEach((t, i) => {
    const rank = i + 1;
    if (!t || typeof t !== "object") return rejected.push({ rank, reason: "not-an-object" });
    const { title, description, evidence } = t as Record<string, unknown>;
    if (typeof title !== "string" || normalise(title).length < 3 || normalise(title).length > 120) return rejected.push({ rank, reason: "invalid-title" });
    if (typeof description !== "string" || !normalise(description) || description.length > 800) return rejected.push({ rank, reason: "invalid-description" });
    if (!Array.isArray(evidence) || evidence.length === 0) return rejected.push({ rank, reason: "no-evidence" });
    if (evidence.length > 3 || evidence.some((e) => typeof e !== "string")) return rejected.push({ rank, reason: "invalid-evidence" });
    const quotes = evidence as string[];
    // Every quote must be grounded: one invented quote rejects the whole proposal.
    if (!quotes.every((q) => quoteFound(q, sourceNormalised))) return rejected.push({ rank, reason: "evidence-not-in-source" });
    const grounded = quotes;
    const key = normalise(title).toLowerCase();
    if (seen.has(key)) return rejected.push({ rank, reason: "duplicate-title" });
    seen.add(key);
    valid.push({ rank, title: normalise(title), description: normalise(description), evidence: grounded.map(normalise) });
  });
  if (themes.length > MAX_THEMES) rejected.push({ rank: MAX_THEMES + 1, reason: "over-limit" });
  return { valid, rejected };
}

export async function proposeThemes(ref: SourceRef, options: ProposeOptions): Promise<ProposeResult> {
  const result = await runOperation<ThemeProposal>(
    {
      collection: THEMES,
      declaration: THEMES_DECLARATION,
      metaSchema: "theme-operation-v1",
      promptName: PROMPT_NAME,
      maxTokens: 3000,
      buildUser: (prompt, record, input, textType) =>
        prompt.userTemplate
          .replace("{{source.title}}", () => record.title ?? "")
          .replace("{{source.medium}}", () => record.medium ?? "unknown")
          .replace("{{source.textType}}", () => textType)
          .replace("{{source.text}}", () => input.replaceAll("</source>", "&lt;/source>")),
      validate: (parsed, ctx) => {
        const { valid, rejected } = validate(parsed, normaliseForQuotes(ctx.input));
        return {
          rejected,
          docs: valid.map((v) => {
            const themeId = sha256(`${ctx.source.blob}\n${v.title.toLowerCase()}`).slice(0, 16);
            const doc: ThemeProposal = {
              schema: "theme-proposal-v1",
              themeId,
              operation: ctx.operation,
              rank: v.rank,
              title: v.title,
              description: v.description,
              evidence: v.evidence,
              source: ctx.source,
              prompt: ctx.prompt,
              model: ctx.model,
              createdAt: ctx.createdAt,
            };
            return { id: themeId, doc };
          }),
        };
      },
      label: (doc) => doc.title,
    },
    ref,
    { repo: options.repo, model: options.model, modelId: options.modelId ?? DEFAULT_THEME_MODEL, branch: options.branch, now: options.now },
  );
  const { items, ...rest } = result;
  return { ...rest, themes: items.map((i) => ({ themeId: i.id, title: i.label, path: i.path })) };
}
