import { postAnalysedEventId } from "../analysis/announce.js";
import { ClaimExtractionRecordSchema } from "../analysis/grounded-claims.js";
import { parseThemeProposalResult } from "../analysis/theme-proposals.js";
import {
  CollectionRecordSchema,
  collectionArtifactPath,
  collectionKey,
} from "../collection/collection-store.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationInspection } from "../controllers/operation-store.js";
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  TIMED_OUT,
  withDeadline,
  type OperationProbe,
} from "./runtime-status.js";

/**
 * Per-post diagnostic trace (#174): recorded observations for one source,
 * assembled from existing typed controllers. Read-only and best-effort: no
 * parallel ledger, no retries, repairs, events, model or research calls.
 *
 * Stage states are explicit: `recorded` (durable evidence exists), `not-recorded`
 * (the controller answered and has nothing), `unavailable` (the controller
 * could not be read), `not-configured`, and `not-traceable` (no per-post key
 * convention exists for that stage yet). Analysis results are labelled `stale`
 * when they describe a different source text version from the current
 * capture, so an old completion is never presented as current. Only safe
 * summaries are projected: identities, statuses, counts, versions and logical
 * references; never source text, research content or event payloads.
 */

export const POST_TRACE_SCHEMA_VERSION = 1;
export const MAX_RESULTS_PER_STAGE = 50;

type Unread = { state: "not-recorded" | "unavailable" | "not-configured" | "not-traceable" };

export interface OperationSummary {
  status: OperationInspection["status"];
  attempts: number;
  exhausted: boolean;
  errorCode?: string;
  pendingEvents: { pending: number; sent: number };
}

export interface PostTrace {
  schemaVersion: typeof POST_TRACE_SCHEMA_VERSION;
  observedAt: string;
  post: { publicationId: string; postId: string };
  capture: {
    operation: ({ state: "recorded" } & OperationSummary) | Unread;
    archive:
      | {
          state: "recorded";
          ref: string;
          complete: boolean;
          method: string;
          sourceVersion: string;
        }
      | Unread;
  };
  /** `current` is null when no current capture version is known. */
  index: { state: "recorded"; sourceVersion: string; current: boolean | null } | Unread;
  themes:
    | {
        state: "recorded";
        results: Array<{
          ref: string;
          sourceVersion: string;
          stale: boolean | null;
          model: string;
          prompt: string;
          proposals: number;
          rejected: number;
        }>;
        unreadable: number;
        truncated: boolean;
      }
    | Unread;
  claims:
    | {
        state: "recorded";
        results: Array<{
          ref: string;
          schemaVersion: number;
          sourceVersion: string;
          stale: boolean | null;
          linkedThemeResult?: string;
          model: string;
          prompt: string;
          accepted: number;
          candidates: number;
          rejected: number;
          announcement: ({ state: "recorded" } & OperationSummary) | Unread;
        }>;
        unreadable: number;
        truncated: boolean;
      }
    | Unread;
  research: Unread;
  drafting: Unread;
  verification: Unread;
}

export interface SearchVersionProbe {
  /** Source version of the post's full-text document, or null if not indexed. */
  fulltextSourceVersion(publicationId: string, postId: string): Promise<string | null>;
}

/** A saved logical reference: full commit, then a repository-relative path. Anything else is never echoed. */
const LOGICAL_REF = /^[0-9a-f]{40}(?:[0-9a-f]{24})?:theme-proposals\/[A-Za-z0-9._/-]{1,500}$/;

const logical = (r: ArtifactRef) => `${r.commit.slice(0, 12)}:${r.path}`;

function summarise(op: OperationInspection): OperationSummary {
  return {
    status: op.status,
    attempts: op.attempts,
    exhausted: op.exhausted,
    ...(op.errorCode ? { errorCode: op.errorCode } : {}),
    pendingEvents: op.pendingEvents,
  };
}

async function readOperation(
  state: OperationProbe | undefined,
  key: string,
): Promise<({ state: "recorded" } & OperationSummary) | Unread> {
  if (!state) return { state: "not-configured" };
  try {
    // Bounded and abortable: a stalled store reports unavailable, never hangs.
    const op = await withDeadline(
      (signal) => state.readOperation(key, signal),
      DEFAULT_CHECK_TIMEOUT_MS,
    );
    if (op === TIMED_OUT) return { state: "unavailable" };
    return op ? { state: "recorded", ...summarise(op) } : { state: "not-recorded" };
  } catch {
    return { state: "unavailable" };
  }
}

type Store = Pick<GitArtifactStore, "list" | "lookup" | "read">;

class StageTimeout extends Error {}

/**
 * Bound a repository read. Git reads take no abort signal, so a stalled one
 * is abandoned (the stage reports unavailable) and the CLI exits explicitly
 * afterwards rather than waiting for it.
 */
async function bounded<T>(work: Promise<T>, ms = DEFAULT_CHECK_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StageTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readResults<T>(
  store: Store,
  prefix: string,
  parse: (text: string) => T,
): Promise<{
  items: Array<{ ref: ArtifactRef; value: T }>;
  unreadable: number;
  truncated: boolean;
}> {
  const paths = await bounded(store.list(prefix, MAX_RESULTS_PER_STAGE + 1));
  const truncated = paths.length > MAX_RESULTS_PER_STAGE;
  const items: Array<{ ref: ArtifactRef; value: T }> = [];
  let unreadable = 0;
  for (const path of paths.slice(0, MAX_RESULTS_PER_STAGE)) {
    try {
      const ref = await bounded(store.lookup(path));
      if (!ref) continue;
      items.push({ ref, value: parse(await bounded(store.read(ref))) });
    } catch (error) {
      // A stalled repository makes the whole stage unavailable, not "unreadable items".
      if (error instanceof StageTimeout) throw error;
      unreadable++;
    }
  }
  return { items, unreadable, truncated };
}

export async function tracePost(input: {
  post: { publicationId: string; postId: string };
  state?: OperationProbe;
  archive?: Store;
  content?: Store;
  search?: SearchVersionProbe;
  now?: () => Date;
}): Promise<PostTrace> {
  const { post } = input;
  const notTraceable: Unread = { state: "not-traceable" };

  // Capture: the collector's operation and the archived record.
  const captureOp = await readOperation(input.state, collectionKey(post));
  let archive: PostTrace["capture"]["archive"] = { state: "not-configured" };
  let currentVersion: string | undefined;
  if (input.archive) {
    try {
      // lookup() treats an unreadable repository as "no branch yet"; list()
      // fails instead, so probe it first to tell broken storage from absence.
      const archiveStore = input.archive;
      await bounded(archiveStore.list("substack", 1));
      const ref = await bounded(archiveStore.lookup(collectionArtifactPath(post)));
      if (!ref) archive = { state: "not-recorded" };
      else {
        const record = CollectionRecordSchema.parse(
          JSON.parse(await bounded(archiveStore.read(ref))),
        );
        currentVersion = sourceVersionFor(record.text);
        archive = {
          state: "recorded",
          ref: logical(ref),
          complete: record.complete,
          method: record.provenance.method,
          sourceVersion: currentVersion,
        };
      }
    } catch {
      archive = { state: "unavailable" };
    }
  }
  // Unknown when no current capture version could be read: never "current".
  const stale = (v: string): boolean | null =>
    currentVersion === undefined ? null : v !== currentVersion;

  // Full-text index: only the version is projected.
  let index: PostTrace["index"] = { state: "not-configured" };
  if (input.search) {
    try {
      const v = await bounded(input.search.fulltextSourceVersion(post.publicationId, post.postId));
      index =
        v === null
          ? { state: "not-recorded" }
          : { state: "recorded", sourceVersion: v, current: stale(v) === null ? null : !stale(v) };
    } catch {
      index = { state: "unavailable" };
    }
  }

  // Analysis results in the content repository.
  let themes: PostTrace["themes"] = { state: "not-configured" };
  let claims: PostTrace["claims"] = { state: "not-configured" };
  if (input.content) {
    // Themes and claims are inspected independently: a theme read failure
    // must not hide claim results, and vice versa.
    let themeRefs = new Map<string, ArtifactRef>();
    try {
      const t = await readResults(
        input.content,
        `theme-proposals/${post.publicationId}/${post.postId}`,
        (s) => parseThemeProposalResult(JSON.parse(s)),
      );
      themes =
        t.items.length === 0 && t.unreadable === 0
          ? { state: "not-recorded" }
          : {
              state: "recorded",
              results: t.items.map(({ ref, value }) => ({
                ref: logical(ref),
                sourceVersion: value.sourceVersion,
                stale: stale(value.sourceVersion),
                model: value.extraction.modelVersion,
                prompt: value.extraction.promptVersion,
                proposals: value.proposals.length,
                rejected: value.rejected.length,
              })),
              unreadable: t.unreadable,
              truncated: t.truncated,
            };
      themeRefs = new Map(t.items.map(({ ref }) => [`${ref.commit}:${ref.path}`, ref]));
    } catch {
      themes = { state: "unavailable" };
    }
    try {
      const c = await readResults(
        input.content,
        `claim-extractions/${post.publicationId}/${post.postId}`,
        (s) => ClaimExtractionRecordSchema.parse(JSON.parse(s)),
      );
      if (c.items.length === 0 && c.unreadable === 0) claims = { state: "not-recorded" };
      else {
        const results = [];
        for (const { ref, value } of c.items) {
          const linked = value.themeResult ? themeRefs.get(value.themeResult) : undefined;
          // The post-analysed announcement (#178) is keyed by the exact
          // (theme result, claim result) pair, so it is traceable only when the
          // linked theme result was read in this inspection.
          const announcement = linked
            ? await readOperation(
                input.state,
                `analysed:${post.publicationId}/${post.postId}:${postAnalysedEventId(linked, ref)}`,
              )
            : notTraceable;
          results.push({
            ref: logical(ref),
            schemaVersion: value.schemaVersion,
            sourceVersion: value.sourceVersion,
            stale: stale(value.sourceVersion),
            // Keep the saved link even when that theme result is beyond the
            // inspection bound or unreadable: show the recorded reference.
            ...(linked
              ? { linkedThemeResult: logical(linked) }
              : value.themeResult && LOGICAL_REF.test(value.themeResult)
                ? {
                    linkedThemeResult: value.themeResult.replace(
                      /^([0-9a-f]{12})[0-9a-f]*:/,
                      "$1:",
                    ),
                  }
                : value.themeResult
                  ? { linkedThemeResult: "invalid-reference" }
                  : {}),
            model: value.extraction.modelVersion,
            prompt: value.extraction.promptVersion,
            accepted: value.schemaVersion >= 2 ? value.claims.length : 0,
            candidates: value.candidates?.length ?? 0,
            rejected: value.rejected.length,
            announcement,
          });
        }
        claims = { state: "recorded", results, unreadable: c.unreadable, truncated: c.truncated };
      }
    } catch {
      claims = { state: "unavailable" };
    }
  }

  return {
    schemaVersion: POST_TRACE_SCHEMA_VERSION,
    observedAt: (input.now ?? (() => new Date()))().toISOString(),
    post,
    capture: { operation: captureOp, archive },
    index,
    themes,
    claims,
    // No per-post key convention exists for these stages yet.
    research: notTraceable,
    drafting: notTraceable,
    verification: notTraceable,
  };
}

/**
 * True when the inspection was partial (a configured source unavailable or
 * some results unreadable) or found no record of the post in any source.
 */
export function traceIncomplete(t: PostTrace): boolean {
  const stages = [t.capture.operation, t.capture.archive, t.index, t.themes, t.claims];
  if (stages.some((x) => x.state === "unavailable")) return true;
  if (t.themes.state === "recorded" && t.themes.unreadable > 0) return true;
  if (t.claims.state === "recorded" && t.claims.unreadable > 0) return true;
  if (
    t.claims.state === "recorded" &&
    t.claims.results.some((r) => r.announcement.state === "unavailable")
  ) {
    return true;
  }
  return !stages.some((x) => x.state === "recorded");
}

export function renderPostTrace(t: PostTrace): string {
  const op = (o: ({ state: "recorded" } & OperationSummary) | Unread) =>
    o.state === "recorded"
      ? `${o.status}${o.exhausted ? " (exhausted)" : ""}, attempts ${o.attempts}${o.errorCode ? `, error ${o.errorCode}` : ""}, events pending ${o.pendingEvents.pending} / sent ${o.pendingEvents.sent}`
      : o.state;
  const lines = [
    `Post ${t.post.publicationId}/${t.post.postId}  (observed ${t.observedAt})`,
    `Capture operation: ${op(t.capture.operation)}`,
    `Archive: ${
      t.capture.archive.state === "recorded"
        ? `${t.capture.archive.complete ? "complete" : "INCOMPLETE"} via ${t.capture.archive.method} · ${t.capture.archive.sourceVersion.slice(0, 19)} · ${t.capture.archive.ref}`
        : t.capture.archive.state
    }`,
    `Full-text index: ${
      t.index.state === "recorded"
        ? `${t.index.sourceVersion.slice(0, 19)}${t.index.current === null ? " (freshness unknown)" : t.index.current ? "" : " (STALE)"}`
        : t.index.state
    }`,
  ];
  if (t.themes.state === "recorded") {
    lines.push("Theme results:");
    for (const r of t.themes.results)
      lines.push(
        `  ${r.ref}${r.stale === null ? " (freshness unknown)" : r.stale ? " (STALE source version)" : ""} · ${r.prompt} · ${r.proposals} proposals, ${r.rejected} rejected`,
      );
    if (t.themes.unreadable) lines.push(`  ${t.themes.unreadable} unreadable`);
    if (t.themes.truncated) lines.push(`  … more than ${MAX_RESULTS_PER_STAGE}; truncated`);
  } else lines.push(`Theme results: ${t.themes.state}`);
  if (t.claims.state === "recorded") {
    lines.push("Claim results:");
    for (const r of t.claims.results) {
      lines.push(
        `  ${r.ref}${r.stale === null ? " (freshness unknown)" : r.stale ? " (STALE source version)" : ""} · v${r.schemaVersion} ${r.prompt} · accepted ${r.accepted}, candidates ${r.candidates}, rejected ${r.rejected}`,
        `    themes: ${r.linkedThemeResult ?? "not linked"} · announcement: ${op(r.announcement)}`,
      );
    }
    if (t.claims.unreadable) lines.push(`  ${t.claims.unreadable} unreadable`);
    if (t.claims.truncated) lines.push(`  … more than ${MAX_RESULTS_PER_STAGE}; truncated`);
  } else lines.push(`Claim results: ${t.claims.state}`);
  lines.push(
    `Research: ${t.research.state} · Drafting: ${t.drafting.state} · Verification: ${t.verification.state}`,
  );
  return lines.join("\n");
}
