import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { ClaimExtractionRecordSchema, type ClaimExtractionRecord } from "./grounded-claims.js";
import { parseThemeProposalResult, type ThemeProposalResult } from "./theme-proposals.js";

/**
 * Private inspection of saved theme and claim results for one post (#187).
 *
 * This is intentionally selected source-content inspection: it shows theme
 * proposals, accepted claims with their linked themes, exact quotations,
 * locations and dates, refinement candidates and rejection reasons. Public
 * operational logs stay counts and codes only. Read-only: no writes, model
 * calls, events or retries. Output uses logical artifact references
 * (short commit and repository path), never filesystem paths or credentials.
 */

export const INSPECTION_SCHEMA_VERSION = 1;
export const DEFAULT_ITEM_LIMIT = 50;
export const MAX_ITEM_LIMIT = 500;

export interface InspectedTheme {
  id: string;
  title: string;
  description?: string;
}

export interface InspectedClaim {
  statement: string;
  kind: string;
  themes: Array<{ id: string; title?: string }>;
  quotation: string;
  location: { start: number; end: number; transcriptSeconds?: [number, number] };
  sourcePublishedAt?: string;
  speaker: { kind: string; name?: string };
}

export interface InspectionReport {
  schemaVersion: typeof INSPECTION_SCHEMA_VERSION;
  post: { publicationId: string; postId: string };
  themeResults: Array<{
    ref: string;
    status: "ok" | "unreadable" | "incompatible";
    sourceVersion?: string;
    versions?: { model: string; prompt: string; schema: number };
    proposals?: InspectedTheme[];
    rejected?: Array<{ reason: string; stage: string; title?: string }>;
    counts?: { proposals: number; rejected: number };
    truncated?: boolean;
  }>;
  claimResults: Array<{
    ref: string;
    status: "ok" | "unreadable";
    schemaVersion?: number;
    sourceVersion?: string;
    themeResult?: string;
    /** Set when the linked theme result describes a different source version. */
    sourceVersionMismatch?: boolean;
    versions?: { model: string; prompt: string };
    accepted?: InspectedClaim[];
    /** Schema-v1 claims: never certified as accepted under the current contract. */
    legacy?: InspectedClaim[];
    candidates?: Array<InspectedClaim & { reasons: string[] }>;
    rejected?: Array<{ reason: string; stage?: string; statement?: string }>;
    counts?: { accepted: number; candidates: number; rejected: number; legacy?: number };
    truncated?: boolean;
  }>;
  /** True when nothing has been saved for this post (distinct from an empty result). */
  notFound: boolean;
  /** True when more saved result files exist than were read. */
  resultsTruncated: boolean;
}

const UNRESOLVED_COMMIT = "unresolved";
/** Placeholder reference for a listed path whose artifact could not be resolved. */
const unresolved = (path: string): ArtifactRef => ({
  repository: "",
  commit: UNRESOLVED_COMMIT,
  path,
  sha256: "",
});
const logical = (ref: ArtifactRef) =>
  ref.commit === UNRESOLVED_COMMIT
    ? `unresolved:${ref.path}`
    : `${ref.commit.slice(0, 12)}:${ref.path}`;

interface OccurrenceView {
  passage?: string;
  span?: { start: number; end: number };
  transcriptTime?: { startSeconds: number; endSeconds: number };
  sourcePublishedAt?: string;
  speaker?: { kind?: string; name?: string };
}

function claimView(
  item: { claim: unknown; occurrence: unknown; kind: string; themeIds: string[] },
  titles: Map<string, string>,
): InspectedClaim {
  const claim = (item.claim ?? {}) as {
    statement?: string;
    passage?: string;
    span?: { start: number; end: number };
  };
  const occ = (item.occurrence ?? {}) as OccurrenceView;
  const span = occ.span ?? claim.span ?? { start: -1, end: -1 };
  return {
    statement: String(claim.statement ?? ""),
    kind: item.kind,
    themes: item.themeIds.map((id) => ({
      id,
      ...(titles.has(id) ? { title: titles.get(id) } : {}),
    })),
    quotation: String(occ.passage ?? claim.passage ?? ""),
    location: {
      start: span.start,
      end: span.end,
      ...(occ.transcriptTime
        ? {
            transcriptSeconds: [occ.transcriptTime.startSeconds, occ.transcriptTime.endSeconds] as [
              number,
              number,
            ],
          }
        : {}),
    },
    ...(occ.sourcePublishedAt ? { sourcePublishedAt: occ.sourcePublishedAt } : {}),
    speaker: {
      kind: String(occ.speaker?.kind ?? "unknown"),
      ...(occ.speaker?.name ? { name: occ.speaker.name } : {}),
    },
  };
}

/** Upper bound on saved result files read per post and kind. */
export const MAX_RESULT_FILES = 2_000;
const PAGE = 200;

/** Read every saved result under a prefix, page by page, up to a stated bound. */
async function readAll(
  store: Pick<GitArtifactStore, "list" | "lookup" | "read">,
  prefix: string,
): Promise<{ items: Array<{ ref: ArtifactRef; text?: string }>; truncated: boolean }> {
  const items: Array<{ ref: ArtifactRef; text?: string }> = [];
  let after: string | undefined;
  for (;;) {
    const page = await store.list(prefix, PAGE, after);
    for (const path of page) {
      if (items.length >= MAX_RESULT_FILES) return { items, truncated: true };
      // A listed artifact whose lookup or read fails (for example a missing
      // blob) is reported as unreadable; the rest of the inspection continues.
      let ref: ArtifactRef | undefined;
      try {
        ref = await store.lookup(path);
      } catch {
        items.push({ ref: unresolved(path) });
        continue;
      }
      if (!ref) continue;
      try {
        items.push({ ref, text: await store.read(ref) });
      } catch {
        items.push({ ref });
      }
    }
    if (page.length < PAGE) return { items, truncated: false };
    after = page[page.length - 1];
  }
}

export async function inspectPost(
  content: Pick<GitArtifactStore, "list" | "lookup" | "read">,
  post: { publicationId: string; postId: string },
  options: { limit?: number } = {},
): Promise<InspectionReport> {
  const limit = Math.max(
    1,
    Math.min(Math.trunc(options.limit ?? DEFAULT_ITEM_LIMIT), MAX_ITEM_LIMIT),
  );
  const report: InspectionReport = {
    schemaVersion: INSPECTION_SCHEMA_VERSION,
    post,
    themeResults: [],
    claimResults: [],
    notFound: false,
    resultsTruncated: false,
  };

  const themeFiles = await readAll(content, `theme-proposals/${post.publicationId}/${post.postId}`);
  const claimFiles = await readAll(
    content,
    `claim-extractions/${post.publicationId}/${post.postId}`,
  );
  report.resultsTruncated = themeFiles.truncated || claimFiles.truncated;
  const titles = new Map<string, string>();
  const themeSourceVersions = new Map<string, string>();
  for (const { ref, text } of themeFiles.items) {
    if (text === undefined) {
      report.themeResults.push({ ref: logical(ref), status: "unreadable" });
      continue;
    }
    let result: ThemeProposalResult;
    try {
      result = parseThemeProposalResult(JSON.parse(text));
    } catch {
      report.themeResults.push({ ref: logical(ref), status: "incompatible" });
      continue;
    }
    for (const p of result.proposals) titles.set(p.id, p.title);
    themeSourceVersions.set(`${ref.commit}:${ref.path}`, result.sourceVersion);
    report.themeResults.push({
      ref: logical(ref),
      status: "ok",
      sourceVersion: result.sourceVersion,
      versions: {
        model: result.extraction.modelVersion,
        prompt: result.extraction.promptVersion,
        schema: result.extraction.schemaVersion,
      },
      proposals: result.proposals.slice(0, limit).map((p) => ({
        id: p.id,
        title: p.title,
        ...(p.description ? { description: p.description } : {}),
      })),
      rejected: result.rejected.slice(0, limit).map((r) => ({
        reason: r.reason,
        stage: r.stage,
        ...(r.candidate.fields.title ? { title: r.candidate.fields.title } : {}),
      })),
      counts: { proposals: result.proposals.length, rejected: result.rejected.length },
      truncated: result.proposals.length > limit || result.rejected.length > limit,
    });
  }

  for (const { ref, text } of claimFiles.items) {
    let record: ClaimExtractionRecord;
    try {
      if (text === undefined) throw new Error("unreadable");
      record = ClaimExtractionRecordSchema.parse(JSON.parse(text));
    } catch {
      report.claimResults.push({ ref: logical(ref), status: "unreadable" });
      continue;
    }
    const linkedVersion = record.themeResult
      ? themeSourceVersions.get(record.themeResult)
      : undefined;
    // Schema v1 accepted every grounded claim (including unclassified ones);
    // show those as legacy, never as accepted under the current contract.
    const isLegacy = record.schemaVersion === 1;
    const viewed = record.claims.map((c) => claimView(c, titles));
    const accepted = isLegacy ? [] : viewed;
    const legacy = isLegacy ? viewed : [];
    const candidates = (record.candidates ?? []).map((c) => ({
      ...claimView(c, titles),
      reasons: c.reasons,
    }));
    const rejected = record.rejected.map((r) => ({
      reason: r.reason,
      ...(r.stage ? { stage: r.stage } : {}),
      ...(r.candidate?.fields.statement ? { statement: r.candidate.fields.statement } : {}),
    }));
    const truncated = [accepted, legacy, candidates, rejected].some((l) => l.length > limit);
    report.claimResults.push({
      ref: logical(ref),
      status: "ok",
      schemaVersion: record.schemaVersion,
      sourceVersion: record.sourceVersion,
      ...(record.themeResult
        ? { themeResult: record.themeResult.replace(/^([0-9a-f]{12})[0-9a-f]*:/, "$1:") }
        : {}),
      ...(linkedVersion !== undefined && linkedVersion !== record.sourceVersion
        ? { sourceVersionMismatch: true }
        : {}),
      versions: { model: record.extraction.modelVersion, prompt: record.extraction.promptVersion },
      accepted: accepted.slice(0, limit),
      ...(isLegacy ? { legacy: legacy.slice(0, limit) } : {}),
      candidates: candidates.slice(0, limit),
      rejected: rejected.slice(0, limit),
      counts: {
        accepted: accepted.length,
        candidates: candidates.length,
        rejected: rejected.length,
        ...(isLegacy ? { legacy: legacy.length } : {}),
      },
      truncated,
    });
  }

  report.notFound = report.themeResults.length === 0 && report.claimResults.length === 0;
  return report;
}

/** Plain-text rendering for a human reviewer. */
export function renderInspection(r: InspectionReport): string {
  const lines: string[] = [`Post ${r.post.publicationId}/${r.post.postId}`];
  if (r.notFound) return `${lines[0]}\nNo saved theme or claim results.`;
  for (const t of r.themeResults) {
    lines.push("", `Theme result ${t.ref} [${t.status}]`);
    if (t.status !== "ok") continue;
    lines.push(`  ${t.versions!.prompt} · ${t.versions!.model}`);
    if (t.proposals!.length === 0) lines.push("  (no themes proposed)");
    for (const p of t.proposals!)
      lines.push(`  - ${p.title}${p.description ? ` — ${p.description}` : ""}  [${p.id}]`);
    for (const x of t.rejected!)
      lines.push(`  ✗ ${x.reason} (${x.stage})${x.title ? `: ${x.title}` : ""}`);
    if (t.truncated) {
      lines.push(
        `  … showing ${t.proposals!.length} of ${t.counts!.proposals} themes and ${t.rejected!.length} of ${t.counts!.rejected} rejections; rerun with a larger --limit`,
      );
    }
  }
  for (const c of r.claimResults) {
    lines.push("", `Claim result ${c.ref} [${c.status}]`);
    if (c.status !== "ok") continue;
    lines.push(
      `  schema v${c.schemaVersion} · ${c.versions!.prompt} · ${c.versions!.model} · accepted ${c.counts!.accepted}, candidates ${c.counts!.candidates}, rejected ${c.counts!.rejected}`,
    );
    if (c.sourceVersionMismatch)
      lines.push("  ! linked theme result describes a different source version");
    const show = (x: InspectedClaim) => {
      const themes = x.themes.map((t) => t.title ?? t.id).join("; ") || "no theme";
      const when = x.sourcePublishedAt ? x.sourcePublishedAt.slice(0, 10) : "date unknown";
      const who = x.speaker.name ? `${x.speaker.kind}: ${x.speaker.name}` : x.speaker.kind;
      return [
        `    ${x.statement}`,
        `      themes: ${themes}`,
        `      "${x.quotation}" [${x.location.start},${x.location.end})${
          x.location.transcriptSeconds
            ? ` · audio ${x.location.transcriptSeconds[0]}s–${x.location.transcriptSeconds[1]}s`
            : ""
        } · ${when} · ${who}`,
      ];
    };
    if (c.accepted!.length) lines.push("  Accepted:");
    for (const x of c.accepted!) lines.push(...show(x));
    if (c.legacy?.length)
      lines.push("  Legacy v1 claims (not certified under the current contract):");
    for (const x of c.legacy ?? []) lines.push(...show(x));
    if (c.candidates!.length) lines.push("  Candidates (need refinement):");
    for (const x of c.candidates!) lines.push(...show(x), `      reasons: ${x.reasons.join(", ")}`);
    if (c.rejected!.length) lines.push("  Rejected:");
    for (const x of c.rejected!)
      lines.push(
        `    ✗ ${x.reason}${x.stage ? ` (${x.stage})` : ""}${x.statement ? `: ${x.statement}` : ""}`,
      );
    if (c.truncated) lines.push(`  … truncated; rerun with a larger --limit`);
  }
  if (r.resultsTruncated) lines.push("", "More saved results exist than were read.");
  return lines.join("\n");
}
