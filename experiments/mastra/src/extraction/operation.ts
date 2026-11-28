import { createHash } from "node:crypto";

import { GitError, type GitRepository } from "../common/git/index.js";
import { ModelError, type ChatModel } from "../common/model/openrouter.js";
import type { ArticleRecord } from "../content/substack-article.js";
import { loadWritingPrompt, type WritingPrompt } from "../writing/prompt.js";

/**
 * One bounded model operation over one retained source version (#960, #961).
 *
 * Shared by the extraction steps (themes, claims). Each step supplies its
 * collection, prompt and validation; this module provides the rest:
 *
 * - The source is an exact `raw_content/.../article.json` at a pinned commit;
 *   the text is the transcript when analysis uses it, otherwise the article
 *   text. A source marked `skip` produces no model call.
 * - The operation ID hashes the source blob, the prompt identity and the model:
 *   a completed operation is reused (no call, no commit); a changed source,
 *   prompt or model gets its own operation.
 * - Each paid attempt is reserved first (a compare-and-swap commit of
 *   `operation.meta`), so concurrent runs never exceed MAX_MODEL_ATTEMPTS; a
 *   failed or truncated call is retried by later runs up to that bound.
 * - Items are validated one by one; valid items are saved even when others
 *   are rejected. A run that loses a race never overwrites a completed result.
 *
 * Saved per operation:
 *   <collection>/<platform>/<source>/<item>/<operation>/<itemId>.json   (indexed)
 *   <collection>/<platform>/<source>/<item>/<operation>/operation.meta  (not indexed)
 */

export const MAX_MODEL_ATTEMPTS = 3;
export const MAX_SOURCE_CHARS = 60_000;

export interface SourceRef {
  /** `raw_content/<platform>/<source>/<item>/article.json` */
  path: string;
  /** The commit the source is read at. */
  commit: string;
}

export interface SourceInfo {
  path: string;
  commit: string;
  blob: string;
  sourceId: string;
  itemId: string;
  url: string;
  textType: "article" | "transcript";
}

export type Outcome = "proposed" | "partial" | "none-valid" | "skipped" | "model-failed";
export type Usage = { promptTokens: number | null; completionTokens: number | null; costUsd: number | null } | null;
export type Timings = { startedAt: string; finishedAt: string; modelMs: number | null; totalMs: number };
export type Rejection = { rank: number; reason: string };

export interface OperationMeta {
  schema: string;
  operation: string;
  outcome: Outcome;
  /** Why the source was skipped, or the model failure category. */
  reason?: string;
  attempts: number;
  source: SourceInfo;
  prompt: string;
  model: string;
  /** IDs of the saved items, in order. */
  items: string[];
  rejected: Rejection[];
  warnings: string[];
  usage: Usage;
  timings: Timings;
}

export interface SavedItem {
  id: string;
  /** A short label for the step's output (a title or a quote). */
  label: string;
  path: string;
}

export interface OperationResult {
  operation: string;
  outcome: Outcome;
  reused: boolean;
  items: SavedItem[];
  rejected: Rejection[];
  warnings: string[];
  usage: Usage;
  timings: Timings;
  reason?: string;
  commit?: string;
}

/** Context passed to a step's validation. */
export interface ValidationContext {
  /** The exact text sent to the model (possibly truncated). */
  input: string;
  record: ArticleRecord;
  source: SourceInfo;
  operation: string;
  prompt: string;
  model: string;
  createdAt: string;
}

export interface OperationSpec<Doc> {
  /** Top-level collection directory, e.g. `themes`. */
  collection: string;
  declaration: unknown;
  metaSchema: string;
  promptName: string;
  maxTokens: number;
  temperature?: number;
  /** Fill the prompt's user template for this source. */
  buildUser(prompt: WritingPrompt, record: ArticleRecord, input: string, textType: SourceInfo["textType"]): string;
  /** Validate the parsed model output item by item. */
  validate(parsed: unknown, context: ValidationContext): { docs: Array<{ id: string; doc: Doc }>; rejected: Rejection[]; warnings?: string[] };
  label(doc: Doc): string;
}

export interface OperationOptions {
  repo: GitRepository;
  model: ChatModel;
  modelId: string;
  branch?: string;
  now?: () => Date;
  /** Internal: how many times a lost reservation race has restarted this run. */
  reservationRetries?: number;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const normalise = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();
/** Normalisation used to compare quotes with the source. */
export const normaliseForQuotes = (s: string) => normalise(s).replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

/** Another run completed this operation first; its saved result is used instead. */
class AlreadyCompleted extends Error {}

export async function runOperation<Doc>(spec: OperationSpec<Doc>, ref: SourceRef, options: OperationOptions): Promise<OperationResult> {
  const now = options.now ?? (() => new Date());
  const started = now();
  const branch = options.branch ?? "main";
  const prompt = loadWritingPrompt(spec.promptName);
  const modelId = options.modelId;

  const m = /^raw_content\/([a-z0-9-]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/article\.json$/.exec(ref.path);
  if (!m) throw new Error("the source must be a raw-content article.json");
  const [, platform, sourceId, itemId] = m as unknown as [string, string, string, string];
  const file = await options.repo.readText(ref.commit, ref.path);
  if (!file) throw new Error("the source is not in the repository at that commit");
  const operation = sha256(`${file.blob}\n${prompt.identity}\n${modelId}`).slice(0, 24);
  const folder = `${spec.collection}/${platform}/${sourceId}/${itemId}/${operation}`;
  const metaPath = `${folder}/operation.meta`;

  const head = await options.repo.resolve(`refs/heads/${branch}`);
  const saved = head ? await options.repo.readText(head, metaPath) : null;
  const previousAttempts = saved ? ((JSON.parse(saved.text) as OperationMeta).attempts ?? 1) : 0;
  if (saved) {
    const meta = JSON.parse(saved.text) as OperationMeta;
    // Completed operations are reused; a failed one is retried until the attempt bound.
    if (meta.outcome !== "model-failed" || previousAttempts >= MAX_MODEL_ATTEMPTS) {
      const items: SavedItem[] = [];
      for (const id of meta.items) {
        const doc = await options.repo.readText(head!, `${folder}/${id}.json`);
        items.push({ id, label: doc ? spec.label(JSON.parse(doc.text) as Doc) : "", path: `${folder}/${id}.json` });
      }
      return {
        operation,
        outcome: meta.outcome,
        reused: true,
        items,
        rejected: meta.rejected,
        warnings: meta.warnings,
        usage: meta.usage,
        timings: meta.timings,
        ...(meta.reason ? { reason: meta.reason } : {}),
      };
    }
  }

  const record = JSON.parse(file.text) as ArticleRecord;
  const textType: SourceInfo["textType"] = record.analysis?.use === "transcript" ? "transcript" : "article";
  const text = textType === "transcript" ? (record.transcript?.content ?? "") : (record.text?.content ?? "");
  const source: SourceInfo = { path: ref.path, commit: ref.commit, blob: file.blob, sourceId, itemId, url: record.url, textType };
  const warnings: string[] = [];
  const base = { schema: spec.metaSchema, operation, prompt: prompt.identity, model: modelId, source, attempts: previousAttempts };

  // After a reservation, results are committed on top of it.
  let reservedHead: string | null = null;
  const finish = async (meta: Omit<OperationMeta, "timings">, modelMs: number | null, docs: Array<{ id: string; doc: Doc }>): Promise<OperationResult> => {
    const finished = now();
    const timings = { startedAt: started.toISOString(), finishedAt: finished.toISOString(), modelMs, totalMs: finished.getTime() - started.getTime() };
    // Concurrent runs may have counted further attempts meanwhile: never record fewer.
    const current = await options.repo.resolve(`refs/heads/${branch}`);
    const latest = current ? await options.repo.readText(current, metaPath) : null;
    const latestAttempts = latest ? ((JSON.parse(latest.text) as OperationMeta).attempts ?? 0) : 0;
    const full: OperationMeta = { ...meta, attempts: Math.max(meta.attempts, latestAttempts), timings };
    const writes = [
      ...docs.map((d) => ({ path: `${folder}/${d.id}.json`, content: `${JSON.stringify(d.doc, null, 2)}\n` })),
      { path: metaPath, content: `${JSON.stringify(full, null, 2)}\n` },
    ];
    if (!head || !(await options.repo.readText(head, `${spec.collection}/collection.json`)))
      writes.push({ path: `${spec.collection}/collection.json`, content: `${JSON.stringify(spec.declaration, null, 2)}\n` });
    let commit: string | undefined;
    try {
      commit = await commitWithRetry(options.repo, branch, reservedHead ?? head, metaPath, writes, `${spec.collection} for ${sourceId}/${itemId}`);
    } catch (error) {
      // Another run completed this operation meanwhile: return its saved result (no further model call).
      if (error instanceof AlreadyCompleted) return runOperation(spec, ref, options);
      throw error;
    }
    return {
      operation,
      outcome: full.outcome,
      reused: false,
      items: docs.map((d) => ({ id: d.id, label: spec.label(d.doc), path: `${folder}/${d.id}.json` })),
      rejected: full.rejected,
      warnings: full.warnings,
      usage: full.usage,
      timings,
      ...(full.reason ? { reason: full.reason } : {}),
      commit,
    };
  };

  if (record.analysis?.use === "skip" || !text.trim())
    return finish({ ...base, outcome: "skipped", reason: record.analysis?.reason ?? "no-text", items: [], rejected: [], warnings, usage: null }, null, []);
  let input = text;
  if (input.length > MAX_SOURCE_CHARS) {
    input = input.slice(0, MAX_SOURCE_CHARS);
    warnings.push("source-truncated");
  }
  const user = spec.buildUser(prompt, record, input, textType);

  // Reserve this attempt atomically before the paid call: a compare-and-swap
  // commit of operation.meta with the attempt counted. A run that loses the race
  // starts over from the state it lost to, so concurrent runs never exceed the
  // attempt bound. An interrupted run leaves its reservation (reason "in-progress").
  const reservation: OperationMeta = {
    ...base,
    attempts: previousAttempts + 1,
    outcome: "model-failed",
    reason: "in-progress",
    items: [],
    rejected: [],
    warnings,
    usage: null,
    timings: { startedAt: started.toISOString(), finishedAt: started.toISOString(), modelMs: null, totalMs: 0 },
  };
  try {
    await options.repo.commit({
      branch,
      parent: head,
      writes: [{ path: metaPath, content: `${JSON.stringify(reservation, null, 2)}\n` }],
      message: `Reserve ${spec.collection} attempt ${reservation.attempts} for ${sourceId}/${itemId}`,
    });
  } catch (error) {
    if (error instanceof GitError && error.code === "conflict" && (options.reservationRetries ?? 0) < 5)
      return runOperation(spec, ref, { ...options, reservationRetries: (options.reservationRetries ?? 0) + 1 });
    throw error;
  }
  reservedHead = await options.repo.resolve(`refs/heads/${branch}`);

  const modelStarted = Date.now();
  let result;
  try {
    result = await options.model.complete({
      model: modelId,
      system: prompt.system,
      user,
      maxTokens: spec.maxTokens,
      temperature: spec.temperature ?? 0.2,
      json: true,
      timeoutMs: 120_000,
    });
  } catch (error) {
    return finish(
      { ...base, attempts: previousAttempts + 1, outcome: "model-failed", reason: error instanceof ModelError ? error.code : "provider-error", items: [], rejected: [], warnings, usage: null },
      Date.now() - modelStarted,
      [],
    );
  }
  const modelMs = Date.now() - modelStarted;
  // Output cut off at the token limit is a technical failure (retried), not a lack of valid items.
  if (result.finishReason === "length")
    return finish(
      { ...base, attempts: previousAttempts + 1, model: result.model, outcome: "model-failed", reason: "output-limit", items: [], rejected: [], warnings, usage: result.usage },
      modelMs,
      [],
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    parsed = null;
    warnings.push("model-output-not-json");
  }
  const validated = spec.validate(parsed, {
    input,
    record,
    source,
    operation,
    prompt: prompt.identity,
    model: result.model,
    createdAt: now().toISOString(),
  });
  warnings.push(...(validated.warnings ?? []));
  const outcome: Outcome = validated.docs.length === 0 ? "none-valid" : validated.rejected.length ? "partial" : "proposed";
  return finish(
    {
      ...base,
      attempts: previousAttempts + 1,
      model: result.model,
      outcome,
      items: validated.docs.map((d) => d.id),
      rejected: validated.rejected,
      warnings,
      usage: result.usage,
    },
    modelMs,
    validated.docs,
  );
}

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
