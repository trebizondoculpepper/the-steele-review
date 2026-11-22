import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { parseDossier } from "../research/dossier.js";
import {
  ResearchManifestSchema,
  ResearchRequestSchema,
  ResearchResultSchema,
  type ResearchWarning,
  researchJobId,
} from "../research/job.js";

/**
 * Saved research for the dashboard (#507). Read-only, through the artifact
 * controller, resumable by cursor with a bound per request.
 *
 * Three kinds stay distinct: librarian-curated dossiers, imported (manual)
 * reports and generated research-job reports. A report existing never means
 * it answers a claim, and a cited source is never shown as verified evidence
 * unless its saved record says an archived passage supports it.
 *
 * Every document is addressed by path plus the exact commit it was read at,
 * so later edits never change what an earlier link shows.
 */

export const RESEARCH_DOC_SCAN = 200;
export const RESEARCH_PAGE = 25;
const LIST_PAGE = 100;
/** Listed paths per request, so job directories full of sources stay bounded. */
const LIST_BOUND = 2000;
const PREFIXES = ["dossier", "research-jobs", "research-reports"] as const;

export type ResearchKind = "dossier" | "imported-report" | "generated-report";

const DOSSIER = /^dossier\/[^/]+\.md$/;
const IMPORTED = /^research-reports\/.+\.md$/;
const JOB_REPORT = /^research-jobs\/(research-[0-9a-f]{32})\/report\.(json|md)$/;

export function researchKind(path: string): ResearchKind | undefined {
  if (DOSSIER.test(path)) return "dossier";
  if (IMPORTED.test(path)) return "imported-report";
  if (JOB_REPORT.test(path)) return "generated-report";
  return undefined;
}

export interface ResearchCitation {
  url: string;
  title?: string;
  /** Saved retrieval state (generated reports). */
  retrieval?: string;
  /** `supported` only when the saved record says an archived passage supports it. */
  support?: string;
  /** Supporting passages, each with the requested claim it was checked against. */
  passages: { passage: string; claimRecordId?: string }[];
  /** Exact archived source snapshot behind the support assessment. */
  archived?: { repository: string; commit: string; path: string; hash: string };
  /** Dossier citation id, referenced by claim coverage. */
  id?: string;
  /** Recorded source classification, e.g. `monitored-source` (the claimant's own material). */
  sourceType?: string;
  confidenceRationale?: string;
}

export interface ResearchDocument {
  path: string;
  commit: string;
  hash: string;
  kind: ResearchKind;
  title: string;
  subject?: string;
  date?: string;
  text: string;
  /** Generated jobs only. */
  jobId?: string;
  outcome?: string;
  failure?: string;
  origin?: string;
  question?: string;
  post?: { publicationId: string; postId: string };
  claims?: { claimRecordId: string; statement: string }[];
  model?: string;
  /** Structured citations, or undefined when none were recorded (imports). */
  citations?: ResearchCitation[];
  omittedCitations?: number;
  gaps?: string[];
  warnings?: ResearchWarning[];
  /** Dossier per-claim coverage: covering citation ids, or the recorded gap reason. */
  coverage?: (
    | { claimId: string; status: "covered"; citations: string[] }
    | { claimId: string; status: "gap"; reason: string }
  )[];
  /** Saved job records that failed their binding to this report (shown, never trusted). */
  provenanceProblems?: string[];
  /** Dossier theme id, when recorded. */
  themeId?: string;
}

export type ResearchRow = Omit<ResearchDocument, "text"> & { citationCount?: number };

export interface ResearchFilter {
  query?: string;
  kind?: ResearchKind;
}

export interface ResearchListing {
  state: "ok" | "unavailable";
  rows: ResearchRow[];
  next?: string;
  partial: boolean;
  unreadable: number;
}

/** One saved research document associated with a canonical theme (#516). */
export interface ThemeResearchDoc {
  path: string;
  commit: string;
  hash: string;
  kind: ResearchKind;
  title: string;
  summary?: string;
  date?: string;
  jobId?: string;
}

export interface ThemeResearchListing {
  state: "ok" | "none" | "partial" | "unavailable";
  docs: ThemeResearchDoc[];
  next?: string;
  truncated: boolean;
}

export interface ResearchPort {
  list(filter: ResearchFilter & { after?: string }): Promise<ResearchListing>;
  /** A document at an exact commit; undefined when missing or unreadable. */
  detail(path: string, commit: string): Promise<ResearchDocument | undefined>;
  /**
   * Documents explicitly associated with a canonical theme: its dossier and
   * research jobs whose saved request names the theme. Never matched by title.
   */
  forTheme(themeId: string, after?: string): Promise<ThemeResearchListing>;
}

type Store = Pick<GitArtifactStore, "list" | "lookup" | "read" | "lookupAt">;

const JOB_LIST_PAGE = 50;
const THEME_JOB_SCAN = 200;
const THEME_DOC_PAGE = 20;

const heading = (text: string) => /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
const json = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

export function savedResearch(content: Store): ResearchPort {
  /** Read one document at a commit (or HEAD when `commit` is undefined). */
  const read = async (path: string, commit?: string): Promise<ResearchDocument | undefined> => {
    const kind = researchKind(path);
    if (!kind) return undefined;
    const at = async (p: string) => {
      if (commit) return content.lookupAt(commit, p);
      const ref = await content.lookup(p);
      return ref ? { ref, content: await content.read(ref) } : undefined;
    };
    try {
      const found = await at(path);
      if (!found) return undefined;
      const base = { path, commit: found.ref.commit, hash: found.ref.sha256, kind };
      if (kind === "dossier") {
        const d = parseDossier(found.content);
        return {
          ...base,
          title: d.metadata.title,
          subject: d.metadata.scope,
          date: d.metadata.updatedAt,
          themeId: d.metadata.themeId,
          text: d.body,
          coverage: d.metadata.claims.map((c) =>
            c.status === "covered"
              ? { claimId: c.claimId, status: "covered" as const, citations: c.citations }
              : { claimId: c.claimId, status: "gap" as const, reason: c.reason },
          ),
          citations: d.metadata.citations.map((c) => ({
            id: c.id,
            url: c.url,
            title: c.title,
            passages: [{ passage: c.passage }],
          })),
          gaps: d.metadata.gaps,
        };
      }
      if (kind === "imported-report") {
        const parts = path.split("/");
        return {
          ...base,
          title: heading(found.content) ?? parts.at(-1)!.replace(/\.md$/, ""),
          // research-reports/<origin>/<subject>/<id>.md: the subject is the folder.
          ...(parts.length >= 4 ? { subject: parts.at(-2)! } : {}),
          text: found.content,
        };
      }
      // Generated job: the report snapshot plus its request, manifest and result.
      const jobId = JOB_REPORT.exec(path)![1]!;
      // research-subject (Sonar) saves report.md; the job runner saves a report.json snapshot.
      const report = (path.endsWith(".md") ? { report: found.content } : json(found.content)) as
        | { report?: unknown; model?: unknown; omittedCitations?: unknown; citations?: unknown }
        | undefined;
      if (!report || typeof report.report !== "string") return undefined;
      const dir = `research-jobs/${jobId}`;
      const sibling = async (name: string) => {
        try {
          // Job records are write-once, so the current copy is the only copy;
          // they are written after the report, so never read them at its commit.
          const ref = await content.lookup(`${dir}/${name}`);
          return ref ? json(await content.read(ref)) : undefined;
        } catch {
          return undefined;
        }
      };
      // Schema validity is not provenance: each sibling must be bound to this
      // job and this exact report, or it is treated as unreadable.
      const problems: string[] = [];
      const request = ResearchRequestSchema.safeParse(await sibling("request.json"));
      let requestBound = false;
      if (request.success) {
        try {
          requestBound = researchJobId(request.data) === jobId;
        } catch {
          requestBound = false;
        }
        if (!requestBound) problems.push("request does not belong to this job");
      }
      const parsedManifest = ResearchManifestSchema.safeParse(await sibling("manifest.json"));
      const manifestBound =
        parsedManifest.success &&
        parsedManifest.data.jobId === jobId &&
        parsedManifest.data.report.path === path &&
        parsedManifest.data.report.hash === `sha256:${found.ref.sha256}`;
      if (parsedManifest.success && !manifestBound) {
        problems.push("citation manifest does not belong to this report");
      }
      const manifest = manifestBound
        ? parsedManifest
        : ({ success: false } as { success: false; data?: undefined });
      const parsedResult = ResearchResultSchema.safeParse(await sibling("result.json"));
      const resultBound =
        parsedResult.success &&
        parsedResult.data.jobId === jobId &&
        (!parsedResult.data.manifest ||
          parsedResult.data.manifest.path === `research-jobs/${jobId}/manifest.json`);
      if (parsedResult.success && !resultBound) problems.push("result does not belong to this job");
      const result = resultBound
        ? parsedResult
        : ({ success: false } as { success: false; data?: undefined });
      const req = request.success && requestBound ? request.data : undefined;
      const citations: ResearchCitation[] | undefined = manifest.success
        ? manifest.data.citations.map((c) => ({
            url: c.url,
            retrieval: c.retrieval,
            ...(c.support ? { support: c.support } : {}),
            ...(c.archivedArtifact ? { archived: c.archivedArtifact } : {}),
            ...(c.sourceType ? { sourceType: c.sourceType } : {}),
            ...(c.confidenceRationale ? { confidenceRationale: c.confidenceRationale } : {}),
            passages: c.passages.map((p) => ({
              passage: p.passage,
              claimRecordId: p.claimRecordId,
            })),
          }))
        : Array.isArray(report.citations)
          ? report.citations
              .filter((u): u is string => typeof u === "string")
              .map((url) => ({ url, passages: [] }))
          : undefined;
      return {
        ...base,
        jobId,
        title: heading(report.report) ?? req?.subject ?? req?.question?.slice(0, 200) ?? jobId,
        ...(req?.subject ? { subject: req.subject } : {}),
        ...(req ? { origin: req.origin } : {}),
        ...(req?.question ? { question: req.question } : {}),
        ...(req?.post
          ? { post: { publicationId: req.post.publicationId, postId: req.post.postId } }
          : {}),
        ...(req
          ? {
              // A request without claims is checked as one finding, id `request` (runner.ts).
              claims:
                req.claims.length > 0
                  ? req.claims.map((c) => ({
                      claimRecordId: c.claimRecordId,
                      statement: c.statement,
                    }))
                  : [{ claimRecordId: "request", statement: req.question ?? req.subject ?? "" }],
            }
          : {}),
        ...(typeof report.model === "string"
          ? { model: report.model }
          : manifest.success
            ? { model: manifest.data.provider.model }
            : {}),
        ...(result.success
          ? {
              outcome: result.data.outcome,
              date: result.data.finishedAt,
              ...(result.data.failure ? { failure: result.data.failure } : {}),
            }
          : {}),
        ...(citations ? { citations } : {}),
        ...(typeof report.omittedCitations === "number"
          ? { omittedCitations: report.omittedCitations }
          : {}),
        ...(manifest.success
          ? {
              gaps: manifest.data.gaps,
              ...(manifest.data.warnings?.length ? { warnings: manifest.data.warnings } : {}),
            }
          : {}),
        ...(problems.length ? { provenanceProblems: problems } : {}),
        text: report.report,
      };
    } catch {
      return undefined;
    }
  };

  const matches = (f: ResearchFilter) => (d: ResearchDocument) => {
    if (f.kind && d.kind !== f.kind) return false;
    const q = f.query?.trim().toLowerCase();
    return (
      !q ||
      d.title.toLowerCase().includes(q) ||
      (d.subject ?? "").toLowerCase().includes(q) ||
      d.text.toLowerCase().includes(q)
    );
  };

  const readAtHead = async (path: string) => {
    const ref = await content.lookup(path);
    return ref ? { ref, content: await content.read(ref) } : undefined;
  };

  return {
    async forTheme(themeId, after) {
      const docs: ThemeResearchDoc[] = [];
      let unreadable = 0;
      // A continuation cursor starts after this page's last job; the dossier is
      // listed once, on the first page.
      const dossier =
        after === undefined ? await readAtHead("dossier/" + themeId + ".md") : undefined;
      if (dossier) {
        const d = parseDossier(dossier.content);
        docs.push({
          path: "dossier/" + themeId + ".md",
          commit: dossier.ref.commit,
          hash: dossier.ref.sha256,
          kind: "dossier",
          title: d.metadata.title,
          summary: d.metadata.scope,
          date: d.metadata.updatedAt,
        });
      }
      const jobs: string[] = [];
      let cursor = after;
      try {
        for (let page = 0; page < 4; page++) {
          const batch = await content.list("research-jobs", JOB_LIST_PAGE, cursor);
          jobs.push(...batch);
          if (batch.length < JOB_LIST_PAGE) break;
          cursor = batch.at(-1);
        }
      } catch {
        return { state: "unavailable", docs: [], truncated: false };
      }
      // Four full listing pages is the scan bound: more paths may exist. The
      // last examined path is returned as a continuation when matches are
      // sparse or a page fills, so no request becomes unreachable.
      const truncated = jobs.length >= THEME_JOB_SCAN;
      let lastExamined: string | undefined;
      let unreadableRequests = 0;
      let next: string | undefined;
      for (const path of jobs) {
        if (next !== undefined) break;
        if (!/^research-jobs\/research-[0-9a-f]{32}\/request\.json$/.test(path)) {
          lastExamined = path;
          continue;
        }
        if (docs.length >= THEME_DOC_PAGE) {
          // Resume after the last fully processed path (the cursor is exclusive).
          next = lastExamined;
          break;
        }
        lastExamined = path;
        const jobId = /research-jobs\/(research-[0-9a-f]{32})\//.exec(path)?.[1];
        if (!jobId) continue;
        let request: ReturnType<typeof ResearchRequestSchema.parse>;
        try {
          const ref = await content.lookup(path);
          if (!ref) continue;
          // Validate and bind the saved request before trusting its metadata.
          request = ResearchRequestSchema.parse(JSON.parse(await content.read(ref)));
          if (researchJobId(request) !== jobId) throw new Error("request belongs to another job");
        } catch {
          unreadableRequests++;
          continue;
        }
        const associated = request.claims.some((c) => c.themeIds.includes(themeId));
        if (!associated) continue;
        const reportPath = `research-jobs/${jobId}/report.json`;
        const markdownPath = `research-jobs/${jobId}/report.md`;
        let report;
        let text = "";
        try {
          report = (await content.lookup(reportPath)) ?? (await content.lookup(markdownPath));
          if (report) text = await content.read(report);
        } catch {
          unreadableRequests++;
          continue;
        }
        if (!report) continue; // requested but no saved report: not a document
        const selectedPath = report.path;
        let title: string;
        let summaryText: string;
        if (selectedPath.endsWith(".json")) {
          try {
            const snapshot = JSON.parse(text) as { report?: unknown; model?: unknown };
            summaryText = typeof snapshot.report === "string" ? snapshot.report : text;
            title = /^#\s+(.+)$/m.exec(summaryText)?.[1]?.trim() ?? jobId;
          } catch {
            unreadableRequests++;
            continue;
          }
        } else {
          summaryText = text;
          title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? jobId;
        }
        const summary = (request.question ?? request.subject ?? summaryText).trim().slice(0, 500);
        // A completed job's saved result records when it finished; only a
        // validated, job-bound result supplies the date.
        let date: string | undefined;
        try {
          const resultRef = await content.lookup(`research-jobs/${jobId}/result.json`);
          if (resultRef) {
            const result = ResearchResultSchema.parse(JSON.parse(await content.read(resultRef)));
            if (result.jobId === jobId) date = result.finishedAt;
          }
        } catch {
          // No usable completion record: the missing-date state stays honest.
        }
        docs.push({
          path: selectedPath,
          commit: report.commit,
          hash: report.sha256,
          kind: "generated-report",
          title,
          ...(summary ? { summary } : {}),
          ...(date ? { date } : {}),
          jobId,
        });
      }
      if (next === undefined && truncated) next = lastExamined;
      const state =
        docs.length > 0
          ? truncated || unreadable > 0 || unreadableRequests > 0
            ? "partial"
            : "ok"
          : truncated || unreadable > 0 || unreadableRequests > 0
            ? "partial"
            : "none";
      return { state, docs, ...(next !== undefined ? { next } : {}), truncated };
    },

    async list(filter) {
      const keep = matches(filter);
      const rows: ResearchRow[] = [];
      let unreadable = 0;
      let scanned = 0;
      let listed = 0;
      let cursor = filter.after;
      let exhausted = false;
      const full = () =>
        rows.length >= RESEARCH_PAGE || scanned >= RESEARCH_DOC_SCAN || listed >= LIST_BOUND;
      try {
        outer: for (const [i, prefix] of PREFIXES.entries()) {
          // Paths sort by prefix, so the cursor alone says where to resume.
          if (cursor && cursor > `${prefix}/￿`) continue;
          let after = cursor && cursor.startsWith(`${prefix}/`) ? cursor : undefined;
          for (;;) {
            if (full()) break outer;
            const want = Math.min(LIST_PAGE, LIST_BOUND - listed);
            const paths = await content.list(prefix, want, after);
            for (const path of paths) {
              cursor = after = path;
              listed++;
              if (!researchKind(path)) {
                if (full()) break outer;
                continue;
              }
              // One row per job: a snapshot beside a Markdown report is the same job.
              if (
                path.endsWith("/report.json") &&
                (await content.lookup(path.replace(/json$/, "md")))
              ) {
                continue;
              }
              scanned++;
              const doc = await read(path);
              if (!doc) unreadable++;
              else if (keep(doc)) {
                const { text: _text, ...row } = doc;
                rows.push({
                  ...row,
                  ...(doc.citations ? { citationCount: doc.citations.length } : {}),
                });
              }
              if (full()) break outer;
            }
            if (paths.length < want) break;
          }
          if (i === PREFIXES.length - 1) exhausted = true;
        }
      } catch {
        return { state: "unavailable", rows: [], partial: false, unreadable: 0 };
      }
      return {
        state: "ok",
        rows,
        ...(!exhausted && cursor ? { next: cursor } : {}),
        partial: !exhausted && rows.length < RESEARCH_PAGE,
        unreadable,
      };
    },
    async detail(path, commit) {
      if (!/^[0-9a-f]{40,64}$/.test(commit)) return undefined;
      return read(path, commit);
    },
  };
}
