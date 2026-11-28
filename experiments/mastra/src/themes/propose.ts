import { createHash } from "node:crypto";

import { GitError, type GitRepository } from "../common/git/index.js";
import { ModelError, type ChatModel } from "../common/model/openrouter.js";
import type { ArticleRecord } from "../content/substack-article.js";
import { loadWritingPrompt } from "../writing/prompt.js";

/**
 * Theme proposals for one retained source version (#960).
 *
 * Input is one exact `article.json` of the raw-content collection (#953), read
 * at a pinned commit. One bounded model call proposes themes; each proposal is
 * validated on its own, and every evidence quote must occur verbatim in the
 * source text. Valid proposals are saved even when others fail validation.
 *
 * Saved output (the `themes` collection):
 *
 *   themes/<platform>/<source>/<item>/<operation>/<themeId>.json   one per valid proposal (indexed)
 *   themes/<platform>/<source>/<item>/<operation>/operation.meta   outcome, timings, usage, warnings
 *
 * The operation ID hashes the exact source blob, the prompt identity and the
 * model, so a retry or replay finds the saved result and makes no model call.
 * A changed source version, prompt or model gets its own operation. Theme IDs
 * hash the source blob and the normalised title, so they are stable across
 * retries.
 */

export const THEMES = "themes";
export const PROMPT_NAME = "theme-proposals-v1";
export const DEFAULT_THEME_MODEL = "deepseek/deepseek-v4.1-flash";
export const MAX_SOURCE_CHARS = 60_000;
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

export interface SourceRef {
  /** `raw_content/<platform>/<source>/<item>/article.json` */
  path: string;
  /** The commit the source is read at. */
  commit: string;
}

export interface ThemeProposal {
  schema: "theme-proposal-v1";
  themeId: string;
  operation: string;
  rank: number;
  title: string;
  description: string;
  evidence: string[];
  source: { path: string; commit: string; blob: string; sourceId: string; itemId: string; url: string; textType: "article" | "transcript" };
  prompt: string;
  model: string;
  createdAt: string;
}

export interface OperationMeta {
  schema: "theme-operation-v1";
  operation: string;
  outcome: "proposed" | "partial" | "none-valid" | "skipped" | "model-failed";
  /** Why the source was skipped, or the model failure category. */
  reason?: string;
  source: ThemeProposal["source"] | { path: string; commit: string };
  prompt: string;
  model: string;
  themes: string[];
  rejected: Array<{ rank: number; reason: string }>;
  warnings: string[];
  usage: { promptTokens: number | null; completionTokens: number | null; costUsd: number | null } | null;
  timings: { startedAt: string; finishedAt: string; modelMs: number | null; totalMs: number };
}

export interface ProposeResult {
  operation: string;
  outcome: OperationMeta["outcome"];
  reused: boolean;
  themes: Array<{ themeId: string; title: string; path: string }>;
  rejected: OperationMeta["rejected"];
  warnings: string[];
  usage: OperationMeta["usage"];
  timings: OperationMeta["timings"];
  reason?: string;
  commit?: string;
}

export interface ProposeOptions {
  repo: GitRepository;
  model: ChatModel;
  modelId?: string;
  branch?: string;
  now?: () => Date;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const normalise = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();

/** A quote counts when it occurs in the source after whitespace and quote-mark normalisation. */
function quoteFound(quote: string, sourceNormalised: string): boolean {
  const q = normalise(quote).replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
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
    const quotes = evidence.filter((e): e is string => typeof e === "string").slice(0, 3);
    const grounded = quotes.filter((q) => quoteFound(q, sourceNormalised));
    if (grounded.length === 0) return rejected.push({ rank, reason: "evidence-not-in-source" });
    const key = normalise(title).toLowerCase();
    if (seen.has(key)) return rejected.push({ rank, reason: "duplicate-title" });
    seen.add(key);
    valid.push({ rank, title: normalise(title), description: normalise(description), evidence: grounded.map(normalise) });
  });
  if (themes.length > MAX_THEMES) rejected.push({ rank: MAX_THEMES + 1, reason: "over-limit" });
  return { valid, rejected };
}

export async function proposeThemes(ref: SourceRef, options: ProposeOptions): Promise<ProposeResult> {
  const now = options.now ?? (() => new Date());
  const started = now();
  const branch = options.branch ?? "main";
  const modelId = options.modelId ?? DEFAULT_THEME_MODEL;
  const prompt = loadWritingPrompt(PROMPT_NAME);

  const m = /^raw_content\/([a-z0-9-]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/article\.json$/.exec(ref.path);
  if (!m) throw new Error("the source must be a raw-content article.json");
  const [, platform, sourceId, itemId] = m as unknown as [string, string, string, string];
  const file = await options.repo.readText(ref.commit, ref.path);
  if (!file) throw new Error("the source is not in the repository at that commit");
  const operation = sha256(`${file.blob}\n${prompt.identity}\n${modelId}`).slice(0, 24);
  const folder = `${THEMES}/${platform}/${sourceId}/${itemId}/${operation}`;

  // Reuse: a completed operation for this exact source, prompt and model.
  const head = await options.repo.resolve(`refs/heads/${branch}`);
  const saved = head ? await options.repo.readText(head, `${folder}/operation.meta`) : null;
  if (saved) {
    const meta = JSON.parse(saved.text) as OperationMeta;
    if (meta.outcome !== "model-failed") {
      const themes = [];
      for (const id of meta.themes) {
        const saved = await options.repo.readText(head!, `${folder}/${id}.json`);
        themes.push({ themeId: id, title: saved ? (JSON.parse(saved.text) as ThemeProposal).title : "", path: `${folder}/${id}.json` });
      }
      return {
        operation,
        outcome: meta.outcome,
        reused: true,
        themes,
        rejected: meta.rejected,
        warnings: meta.warnings,
        usage: meta.usage,
        timings: meta.timings,
        ...(meta.reason ? { reason: meta.reason } : {}),
      };
    }
  }

  const record = JSON.parse(file.text) as ArticleRecord;
  const textType = record.analysis?.use === "transcript" ? "transcript" : "article";
  const text = record.analysis?.use === "transcript" ? (record.transcript?.content ?? "") : (record.text?.content ?? "");
  const source: ThemeProposal["source"] = { path: ref.path, commit: ref.commit, blob: file.blob, sourceId, itemId, url: record.url, textType };
  const warnings: string[] = [];
  const base = { schema: "theme-operation-v1" as const, operation, prompt: prompt.identity, model: modelId, source };

  const finish = async (meta: Omit<OperationMeta, "timings">, modelMs: number | null, writes: Array<{ path: string; content: string }>) => {
    const finished = now();
    const timings = { startedAt: started.toISOString(), finishedAt: finished.toISOString(), modelMs, totalMs: finished.getTime() - started.getTime() };
    const full: OperationMeta = { ...meta, timings };
    const all = [...writes, { path: `${folder}/operation.meta`, content: `${JSON.stringify(full, null, 2)}\n` }];
    if (!head || !(await options.repo.readText(head, `${THEMES}/collection.json`)))
      all.push({ path: `${THEMES}/collection.json`, content: `${JSON.stringify(THEMES_DECLARATION, null, 2)}\n` });
    let commit: string | undefined;
    try {
      commit = await commitWithRetry(options.repo, branch, head, `${folder}/operation.meta`, all, `Themes for ${sourceId}/${itemId}`);
    } catch (error) {
      // Another run completed this operation meanwhile: return its saved result (no further model call).
      if (error instanceof AlreadyCompleted) return proposeThemes(ref, options);
      throw error;
    }
    return {
      operation,
      outcome: full.outcome,
      reused: false,
      themes: full.themes.map((id) => ({ themeId: id, title: writes.length ? JSON.parse(writes.find((w) => w.path.endsWith(`/${id}.json`))!.content).title : "", path: `${folder}/${id}.json` })),
      rejected: full.rejected,
      warnings: full.warnings,
      usage: full.usage,
      timings,
      ...(full.reason ? { reason: full.reason } : {}),
      commit,
    } satisfies ProposeResult;
  };

  if (record.analysis?.use === "skip" || !text.trim())
    return finish({ ...base, outcome: "skipped", reason: record.analysis?.reason ?? "no-text", themes: [], rejected: [], warnings, usage: null }, null, []);
  let input = text;
  if (input.length > MAX_SOURCE_CHARS) {
    input = input.slice(0, MAX_SOURCE_CHARS);
    warnings.push("source-truncated");
  }

  const user = prompt.userTemplate
    .replace("{{source.title}}", () => record.title ?? "")
    .replace("{{source.medium}}", () => record.medium ?? "unknown")
    .replace("{{source.textType}}", () => textType)
    .replace("{{source.text}}", () => input.replaceAll("</source>", "&lt;/source>"));
  const modelStarted = Date.now();
  let result;
  try {
    result = await options.model.complete({ model: modelId, system: prompt.system, user, maxTokens: 1500, temperature: 0.2, json: true, timeoutMs: 120_000 });
  } catch (error) {
    return finish(
      { ...base, outcome: "model-failed", reason: error instanceof ModelError ? error.code : "provider-error", themes: [], rejected: [], warnings, usage: null },
      Date.now() - modelStarted,
      [],
    );
  }
  const modelMs = Date.now() - modelStarted;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    parsed = null;
    warnings.push("model-output-not-json");
  }
  const sourceNormalised = normalise(input).replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const { valid, rejected } = validate(parsed, sourceNormalised);
  const createdAt = now().toISOString();
  const proposals: ThemeProposal[] = valid.map((v) => ({
    schema: "theme-proposal-v1",
    themeId: sha256(`${file.blob}\n${v.title.toLowerCase()}`).slice(0, 16),
    operation,
    rank: v.rank,
    title: v.title,
    description: v.description,
    evidence: v.evidence,
    source,
    prompt: prompt.identity,
    model: result.model,
    createdAt,
  }));
  const outcome: OperationMeta["outcome"] = proposals.length === 0 ? "none-valid" : rejected.length ? "partial" : "proposed";
  return finish(
    { ...base, model: result.model, outcome, themes: proposals.map((p) => p.themeId), rejected, warnings, usage: result.usage },
    modelMs,
    proposals.map((p) => ({ path: `${folder}/${p.themeId}.json`, content: `${JSON.stringify(p, null, 2)}\n` })),
  );
}

/** Another run completed this operation first; its saved result is used instead. */
class AlreadyCompleted extends Error {}

async function commitWithRetry(
  repo: GitRepository,
  branch: string,
  head: string | null,
  metaPath: string,
  writes: Array<{ path: string; content: string }>,
  message: string,
): Promise<string | undefined> {
  let parent = head;
  for (let attempt = 1; ; attempt++) {
    try {
      return (await repo.commit({ branch, parent, writes, message })).commit ?? undefined;
    } catch (error) {
      if (!(error instanceof GitError && error.code === "conflict") || attempt >= 3) throw error;
      parent = await repo.resolve(`refs/heads/${branch}`);
      // A concurrent run may have saved this very operation: never overwrite a completed result.
      const saved = parent ? await repo.readText(parent, metaPath) : null;
      if (saved && (JSON.parse(saved.text) as OperationMeta).outcome !== "model-failed") throw new AlreadyCompleted();
    }
  }
}
