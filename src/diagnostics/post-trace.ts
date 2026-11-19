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
import type { OperationProbe } from "./runtime-status.js";

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
  index: { state: "recorded"; sourceVersion: string; current: boolean } | Unread;
  themes:
    | {
        state: "recorded";
        results: Array<{
          ref: string;
          sourceVersion: string;
          stale: boolean;
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
          stale: boolean;
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
    const op = await state.readOperation(key);
    return op ? { state: "recorded", ...summarise(op) } : { state: "not-recorded" };
  } catch {
    return { state: "unavailable" };
  }
}

type Store = Pick<GitArtifactStore, "list" | "lookup" | "read">;

async function readResults<T>(
  store: Store,
  prefix: string,
  parse: (text: string) => T,
): Promise<{
  items: Array<{ ref: ArtifactRef; value: T }>;
  unreadable: number;
  truncated: boolean;
}> {
  const paths = await store.list(prefix, MAX_RESULTS_PER_STAGE + 1);
  const truncated = paths.length > MAX_RESULTS_PER_STAGE;
  const items: Array<{ ref: ArtifactRef; value: T }> = [];
  let unreadable = 0;
  for (const path of paths.slice(0, MAX_RESULTS_PER_STAGE)) {
    try {
      const ref = await store.lookup(path);
      if (!ref) continue;
      items.push({ ref, value: parse(await store.read(ref)) });
    } catch {
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
      const ref = await input.archive.lookup(collectionArtifactPath(post));
      if (!ref) archive = { state: "not-recorded" };
      else {
        const record = CollectionRecordSchema.parse(JSON.parse(await input.archive.read(ref)));
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
  const stale = (v: string) => currentVersion !== undefined && v !== currentVersion;

  // Full-text index: only the version is projected.
  let index: PostTrace["index"] = { state: "not-configured" };
  if (input.search) {
    try {
      const v = await input.search.fulltextSourceVersion(post.publicationId, post.postId);
      index =
        v === null
          ? { state: "not-recorded" }
          : { state: "recorded", sourceVersion: v, current: !stale(v) };
    } catch {
      index = { state: "unavailable" };
    }
  }

  // Analysis results in the content repository.
  let themes: PostTrace["themes"] = { state: "not-configured" };
  let claims: PostTrace["claims"] = { state: "not-configured" };
  if (input.content) {
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
      const themeRefs = new Map(t.items.map(({ ref }) => [`${ref.commit}:${ref.path}`, ref]));

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
          // The post-analysed announcement (#178) is traced once its event-ID
          // helper is merged; until then it has no traceable key here.
          const announcement: Unread = notTraceable;
          results.push({
            ref: logical(ref),
            schemaVersion: value.schemaVersion,
            sourceVersion: value.sourceVersion,
            stale: stale(value.sourceVersion),
            ...(linked ? { linkedThemeResult: logical(linked) } : {}),
            model: value.extraction.modelVersion,
            prompt: value.extraction.promptVersion,
            accepted: value.schemaVersion === 2 ? value.claims.length : 0,
            candidates: value.candidates?.length ?? 0,
            rejected: value.rejected.length,
            announcement,
          });
        }
        claims = { state: "recorded", results, unreadable: c.unreadable, truncated: c.truncated };
      }
    } catch {
      themes = themes.state === "not-configured" ? { state: "unavailable" } : themes;
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

/** True when any configured source could not be read, or nothing exists for the post. */
export function traceIncomplete(t: PostTrace): boolean {
  const states = [
    t.capture.operation.state,
    t.capture.archive.state,
    t.index.state,
    t.themes.state,
    t.claims.state,
  ];
  if (states.includes("unavailable")) return true;
  return t.capture.operation.state !== "recorded" && t.capture.archive.state !== "recorded";
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
        ? `${t.index.sourceVersion.slice(0, 19)}${t.index.current ? "" : " (STALE)"}`
        : t.index.state
    }`,
  ];
  if (t.themes.state === "recorded") {
    lines.push("Theme results:");
    for (const r of t.themes.results)
      lines.push(
        `  ${r.ref}${r.stale ? " (STALE source version)" : ""} · ${r.prompt} · ${r.proposals} proposals, ${r.rejected} rejected`,
      );
    if (t.themes.unreadable) lines.push(`  ${t.themes.unreadable} unreadable`);
    if (t.themes.truncated) lines.push(`  … more than ${MAX_RESULTS_PER_STAGE}; truncated`);
  } else lines.push(`Theme results: ${t.themes.state}`);
  if (t.claims.state === "recorded") {
    lines.push("Claim results:");
    for (const r of t.claims.results) {
      lines.push(
        `  ${r.ref}${r.stale ? " (STALE source version)" : ""} · v${r.schemaVersion} ${r.prompt} · accepted ${r.accepted}, candidates ${r.candidates}, rejected ${r.rejected}`,
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
