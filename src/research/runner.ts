import { createHash } from "node:crypto";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { ModelProviderError } from "../controllers/openrouter.js";
import { WebAdapterError } from "../controllers/research-web.js";
import type { PageFetcher } from "./gap-research.js";
import {
  RESEARCH_JOB_SCHEMA_VERSION,
  ResearchManifestSchema,
  type ResearchManifest,
  type ResearchRequest,
  type ResearchResult,
  finishResearchJob,
  openResearchJob,
  writeOnce,
} from "./job.js";
import type { SonarClient } from "./sonar.js";

/**
 * Research runner (#216): one bounded Sonar pass, then bounded retrieval of
 * cited sources, support checks, the covering note and the manifest.
 *
 * - A provider error or timeout before a report ends the job as `failed`;
 *   there is never a second Sonar call for the job (redelivery returns the
 *   saved outcome, and a vanished run is recorded as `interrupted`).
 * - Once a report exists, inaccessible, unsupported (PDF, redirect) or
 *   unverified citations make the job `complete-with-gaps`, not failed.
 * - A passage counts as supporting only when the judge returns it, it
 *   appears verbatim in the archived source, and it names a finding of this
 *   request. Topical or uncertain matches are recorded as `unverified`.
 */

export const RESEARCH_PROMPT_VERSION = "sonar-research-v1";
export const SUPPORT_PROMPT_VERSION = "source-support-v1";
/** The finding id used for manual subject requests, which have no claims. */
export const REQUEST_FINDING_ID = "request";

export interface Finding {
  id: string;
  statement: string;
}

export interface SupportJudge {
  /** Passages from `source` that directly support a finding; [] when none do. */
  judge(
    input: { findings: Finding[]; url: string; source: string },
    signal: AbortSignal,
  ): Promise<{ findingId: string; passage: string }[]>;
}

export interface RunnerLimits {
  maxSources?: number;
  maxSourceChars?: number;
  /** Per-source retrieval deadline; the fetcher's own timeout also applies. */
  sourceTimeoutMs?: number;
}

export type RunOutcome =
  | { status: "busy"; jobId: string }
  | { status: "finished"; jobId: string; result: ResearchResult; reused: boolean };

export function findingsFor(request: ResearchRequest): Finding[] {
  if (request.claims.length > 0)
    return request.claims.map((c) => ({ id: c.claimRecordId, statement: c.statement }));
  return [{ id: REQUEST_FINDING_ID, statement: request.question ?? request.subject ?? "" }];
}

export function researchPrompt(request: ResearchRequest): { system: string; user: string } {
  const lines: string[] = [];
  if (request.subject) lines.push(`Subject: ${request.subject}`);
  if (request.brief) lines.push(`Brief: ${request.brief}`);
  if (request.question) lines.push(`Question: ${request.question}`);
  if (request.claims.length > 0) {
    lines.push("Claims to research (as made by the author; do not assume they are true):");
    for (const c of request.claims) lines.push(`- [${c.claimRecordId}] ${c.statement}`);
  }
  return {
    system:
      "You are a careful fact-checking researcher. Find primary and authoritative sources " +
      "that establish what is actually documented about each claim or question. Cite every " +
      "source you rely on. Distinguish evidence that supports, contradicts or fails to " +
      "address each claim, and say plainly when no independent evidence was found.",
    user: lines.join("\n"),
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const normalise = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

function retrievalOf(error: unknown): {
  retrieval: "inaccessible" | "unsupported";
  reason: string;
} {
  if (error instanceof WebAdapterError) {
    if (error.code === "redirected" || error.code === "unsupported-content") {
      return { retrieval: "unsupported", reason: error.code };
    }
    return { retrieval: "inaccessible", reason: error.code };
  }
  return { retrieval: "inaccessible", reason: "unavailable" };
}

async function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener("abort", () => reject(new WebAdapterError("timeout")), {
          once: true,
        }),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runResearchJob(input: {
  artifacts: GitArtifactStore;
  operations: OperationStore;
  request: unknown;
  owner: string;
  sonar: SonarClient;
  fetcher: PageFetcher;
  judge?: SupportJudge;
  limits?: RunnerLimits;
  now?: () => Date;
  signal?: AbortSignal;
}): Promise<RunOutcome> {
  const now = input.now ?? (() => new Date());
  const opened = await openResearchJob({
    artifacts: input.artifacts,
    operations: input.operations,
    request: input.request,
    owner: input.owner,
    now,
  });
  if (opened.status === "busy") return { status: "busy", jobId: opened.jobId };
  if (opened.status === "finished") {
    return { status: "finished", jobId: opened.jobId, result: opened.existing, reused: true };
  }
  const { jobId } = opened;
  const request = JSON.parse(await input.artifacts.read(opened.requestRef)) as ResearchRequest;
  const signal = input.signal ?? new AbortController().signal;
  const fail = async (failure: NonNullable<ResearchResult["failure"]>) => {
    const done = await finishResearchJob({
      artifacts: input.artifacts,
      operations: input.operations,
      jobId,
      outcome: "failed",
      failure,
      now,
    });
    return { status: "finished" as const, jobId, result: done.result, reused: false };
  };

  // 1. One bounded provider call. No retry on any provider error.
  let report;
  try {
    report = await input.sonar.research(researchPrompt(request), signal);
  } catch (error) {
    if (error instanceof ModelProviderError && error.code === "timeout") return fail("timeout");
    if (error instanceof ModelProviderError && error.code === "credit-exhausted")
      return fail("budget-exceeded");
    return fail("provider-error");
  }
  const dir = `research-jobs/${jobId}`;
  const reportRef = await writeOnce(input.artifacts, `${dir}/report.json`, {
    schemaVersion: RESEARCH_JOB_SCHEMA_VERSION,
    jobId,
    promptVersion: RESEARCH_PROMPT_VERSION,
    model: report.model,
    report: report.report,
    citations: report.citations,
  });

  // 2. Retrieve, archive and check each cited source within bounds.
  const limits = {
    maxSources: 20,
    maxSourceChars: 200_000,
    sourceTimeoutMs: 30_000,
    ...input.limits,
  };
  const findings = findingsFor(request);
  const findingIds = new Set(findings.map((f) => f.id));
  const citations: ResearchManifest["citations"] = [];
  const gaps: string[] = [];
  for (const [index, url] of report.citations.entries()) {
    if (index >= limits.maxSources) {
      citations.push({
        url,
        retrieval: "not-attempted",
        retrievalReason: "source-limit",
        passages: [],
      });
      continue;
    }
    let page;
    try {
      page = await withDeadline(limits.sourceTimeoutMs, (s) => input.fetcher.fetch(url, s));
    } catch (error) {
      const { retrieval, reason } = retrievalOf(error);
      citations.push({ url, retrieval, retrievalReason: reason, passages: [] });
      continue;
    }
    const text = page.text.slice(0, limits.maxSourceChars);
    const archived = await writeOnce(
      input.artifacts,
      `${dir}/sources/${sha(url).slice(0, 32)}.json`,
      {
        url,
        title: page.title,
        ...(page.publisher ? { publisher: page.publisher } : {}),
        ...(page.publishedAt ? { publishedAt: page.publishedAt } : {}),
        truncated: page.text.length > text.length,
        text,
      },
    );
    let passages: ResearchManifest["citations"][number]["passages"] = [];
    let support: "supported" | "unverified" | "not-checked" = "not-checked";
    if (input.judge) {
      try {
        const source = normalise(text);
        const proposed = await input.judge.judge({ findings, url, source: text }, signal);
        passages = proposed
          .filter((p) => findingIds.has(p.findingId) && p.passage.trim().length > 0)
          .filter((p) => source.includes(normalise(p.passage)))
          .slice(0, 50)
          .map((p) => ({ claimRecordId: p.findingId, passage: p.passage.trim().slice(0, 4000) }));
        support = passages.length > 0 ? "supported" : "unverified";
      } catch {
        support = "not-checked";
      }
    }
    citations.push({
      url,
      retrieval: "archived",
      archivedArtifact: {
        repository: archived.repository,
        commit: archived.commit,
        path: archived.path,
        hash: `sha256:${archived.sha256}`,
      },
      support,
      passages,
    });
  }

  // 3. Gaps and outcome.
  const count = (pred: (c: (typeof citations)[number]) => boolean) => citations.filter(pred).length;
  if (citations.length === 0) gaps.push("The report cited no retrievable sources.");
  const notArchived = count((c) => c.retrieval !== "archived");
  if (notArchived > 0)
    gaps.push(`${notArchived} cited source(s) could not be archived (see retrieval reasons).`);
  const unchecked = count((c) => c.retrieval === "archived" && c.support !== "supported");
  if (unchecked > 0)
    gaps.push(`${unchecked} archived source(s) have no verified supporting passage.`);
  for (const f of findings) {
    if (!citations.some((c) => c.passages.some((p) => p.claimRecordId === f.id))) {
      gaps.push(`No verified supporting passage for finding ${f.id}.`);
    }
  }

  const archivedCount = citations.length - notArchived;
  const note = [
    `# Research job ${jobId}`,
    "",
    `One ${report.model} pass (${RESEARCH_PROMPT_VERSION}) cited ${citations.length} source(s); ${archivedCount} archived, ${count((c) => c.support === "supported")} with verified supporting passages.`,
    "",
    "Retrieval uses the public-page fetcher only: PDFs and redirecting URLs are recorded as unsupported, not followed.",
    "",
    ...(gaps.length > 0 ? ["Gaps:", ...gaps.map((g) => `- ${g}`), ""] : ["No recorded gaps.", ""]),
  ].join("\n");
  const noteRef = await writeOnce(input.artifacts, `${dir}/covering-note.md`, note);

  const ref = (r: ArtifactRef) => ({
    repository: r.repository,
    commit: r.commit,
    path: r.path,
    hash: `sha256:${r.sha256}`,
  });
  const manifest = ResearchManifestSchema.parse({
    schemaVersion: RESEARCH_JOB_SCHEMA_VERSION,
    jobId,
    report: ref(reportRef),
    coveringNote: ref(noteRef),
    citations,
    gaps: gaps.slice(0, 100),
    provider: {
      model: report.model,
      ...(report.costUsd !== undefined ? { costUsd: report.costUsd } : {}),
    },
  });
  const manifestRef = await writeOnce(input.artifacts, `${dir}/manifest.json`, manifest);
  const done = await finishResearchJob({
    artifacts: input.artifacts,
    operations: input.operations,
    jobId,
    outcome: gaps.length === 0 ? "complete" : "complete-with-gaps",
    manifest: manifestRef,
    now,
  });
  return { status: "finished", jobId, result: done.result, reused: false };
}
