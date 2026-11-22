import { reportPartialResearch } from "../observability/research-warning.js";
import { ConfigurationError } from "../controllers/configuration.js";
import { ArtifactStoreError } from "../controllers/artifact-store.js";
import { loadRetainedResearch, readAcceptedResearchRecovery } from "./retained-research-source.js";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import {
  captureResearchDiscovery,
  readLengthLimitedResearchDiscovery,
  ResearchDiscoveryError,
} from "./discovery.js";
import { discoveryFromAdapterReport } from "./discovery-data.js";
import { citationUrls } from "./sonar.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { loadPromptFile } from "../prompt-files.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { ModelProviderError } from "../controllers/openrouter.js";
import { WebAdapterError } from "../controllers/research-web.js";
import type { PageFetcher } from "./gap-research.js";
import {
  RESEARCH_JOB_SCHEMA_VERSION,
  ResearchManifestSchema,
  ResearchWarningsSchema,
  outputLimitWarning,
  type ResearchWarning,
  type ResearchManifest,
  ResearchRequestSchema,
  RetainedResearchRecoverySchema,
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

const SONAR_RESEARCH_PROMPT = loadPromptFile("research", "sonar-research-v1");
/**
 * Identity of the research prompt wording. Editing the Markdown changes this
 * version, so new jobs and report snapshots get a new identity. Snapshots
 * written under a known earlier wording stay readable and reusable.
 */
export const RESEARCH_PROMPT_VERSION = SONAR_RESEARCH_PROMPT.version;
const LEGACY_RESEARCH_PROMPT_VERSIONS: ReadonlySet<string> = new Set(["sonar-research-v1"]);

/** Bound on a retained report snapshot; larger values are rejected, not used. */
export const MAX_SAVED_REPORT_CHARS = 2_000_000;
/**
 * Bound on retained citations in a report snapshot. Matches what the Sonar
 * client retains and the manifest schema accepts, so a legitimate snapshot is
 * never rejected as invalid on recovery.
 */
export const MAX_SAVED_CITATIONS = 500;

/**
 * Narrow runtime parsers for retained provider snapshots (#432). Git hash
 * verification proves the bytes are unchanged, not that they are the declared
 * kind of record; a saved value with the wrong shape must fail the job rather
 * than reach `.entries()`/`normalise()` or be silently refetched.
 */
const SavedReportSchema = z
  .object({
    schemaVersion: z.literal(RESEARCH_JOB_SCHEMA_VERSION),
    jobId: z.string().min(1).max(200),
    promptVersion: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    report: z.string().min(1).max(MAX_SAVED_REPORT_CHARS),
    // No per-URL cap: the Sonar client and manifest keep long citation URLs; the report size bound applies.
    citations: z.array(z.string().min(1)).max(MAX_SAVED_CITATIONS),
    omittedCitations: z.number().int().min(0).optional(),
    discovery: ArtifactReferenceSchema.optional(),
    costUsd: z.number().nonnegative().optional(),
    discoveryCompleteness: z.enum(["provider-original", "adapter-return-only"]).optional(),
    retainedRecovery: RetainedResearchRecoverySchema.optional(),
    warnings: ResearchWarningsSchema.optional(),
  })
  .strict();

/** Parse retained bytes; malformed JSON becomes a schema failure, never a throw. */
const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const savedSourceSchema = (maxChars: number) =>
  z
    .object({
      url: z.url({ protocol: /^https?$/ }),
      title: z.string().max(2000),
      publisher: z.string().max(500).optional(),
      publishedAt: z.string().max(100).optional(),
      truncated: z.boolean(),
      // Empty text is legitimate (a script-only page); it stays an unverified source.
      text: z.string().max(maxChars),
    })
    .strict();

/** The finding id used for manual subject requests, which have no claims. */
export const REQUEST_FINDING_ID = "request";

export interface Finding {
  id: string;
  statement: string;
}

export interface SupportJudgement {
  passages: { findingId: string; passage: string }[];
  /** e.g. "treaty", "government record", "news report", "blog". */
  sourceType?: string;
  /** Why the source is or is not reliable support for these findings. */
  rationale?: string;
}

export interface SupportJudge {
  /**
   * The judge's prompt identity (version plus content hash). Saved with each
   * staged judgement so a prompt change is never mistaken for reuse (#593).
   */
  readonly identity?: string;
  /** Passages from `source` that directly support a finding; [] when none do. */
  judge(
    input: {
      findings: Finding[];
      /** The discovery report: support is judged for what it says about each finding, citing this source. */
      report: string;
      url: string;
      source: string;
    },
    signal: AbortSignal,
  ): Promise<SupportJudgement>;
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
    system: SONAR_RESEARCH_PROMPT.instructions,
    user: lines.join("\n"),
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** Whitespace-only normalisation: a kept passage must match the source's exact wording and case. */
const normalise = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

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
  sonar?: SonarClient;
  fetcher: PageFetcher;
  judge?: SupportJudge;
  limits?: RunnerLimits;
  /**
   * Hosts of the monitored publication(s). Their pages are the claimant's
   * own material: archived for provenance, but never accepted as
   * independent support for a finding.
   */
  monitoredHosts?: readonly string[];
  now?: () => Date;
  signal?: AbortSignal;
}): Promise<RunOutcome> {
  const now = input.now ?? (() => new Date());
  const submitted = ResearchRequestSchema.parse(input.request);
  if (!submitted.retainedRecovery) {
    const recovered = await readAcceptedResearchRecovery({ ...input, request: submitted });
    if (recovered) {
      reportPartialResearch(input.operations, recovered.result);
      return {
        status: "finished",
        jobId: recovered.binding.jobId,
        result: recovered.result,
        reused: true,
      };
    }
  }
  const retained = submitted.retainedRecovery
    ? await loadRetainedResearch({ ...input, request: submitted })
    : undefined;
  if (!retained && !input.sonar) throw new Error("research-discovery-capability-required");
  const opened = await openResearchJob({
    artifacts: input.artifacts,
    operations: input.operations,
    request: input.request,
    owner: input.owner,
    now,
  });
  if (opened.status === "busy") return { status: "busy", jobId: opened.jobId };
  if (opened.status === "finished") {
    reportPartialResearch(input.operations, opened.existing);
    return { status: "finished", jobId: opened.jobId, result: opened.existing, reused: true };
  }
  const { jobId } = opened;
  // Keep the run lease alive through slow source processing; losing it means
  // another caller has already recorded this run as interrupted, so stop.
  const keepLease = () => input.operations.renew(opened.claim, opened.leaseMs);
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

  // Exhausted credit is an operational block, not a research result (#407):
  // save nothing terminal and hand the claim back without spending it, so the
  // same job (same ID, same request) runs again after credit is restored. The
  // run that saw it stops at coverage with this outcome.
  const creditBlocked = (): RunOutcome => {
    input.operations.yieldClaim(opened.claim);
    return {
      status: "finished" as const,
      jobId,
      reused: false,
      result: {
        schemaVersion: RESEARCH_JOB_SCHEMA_VERSION,
        jobId,
        outcome: "failed" as const,
        failure: "budget-exceeded" as const,
        finishedAt: now().toISOString(),
      },
    };
  };
  const dir = `research-jobs/${jobId}`;

  // 1. One bounded provider call. No retry on any provider error. A report
  // saved by an attempt that later stopped for lack of credit is reused, so a
  // recovery neither pays for the report again nor diverges from the pinned one.
  let report: Awaited<ReturnType<SonarClient["research"]>>;
  let discoveryRef: ArtifactRef | undefined;
  let discoveryCompleteness: "provider-original" | "adapter-return-only" | undefined;
  let legacyDiscovery = false;
  let warnings: ResearchWarning[] = [];
  const savedReport = await input.artifacts.lookup(`${dir}/report.json`);
  if (savedReport) {
    const saved = SavedReportSchema.safeParse(parseJson(await input.artifacts.read(savedReport)));
    // A retained snapshot that is not this job's validated report is a
    // terminal operational failure: never reuse it, never refetch over it.
    const knownPrompt =
      saved.success &&
      (saved.data.promptVersion === RESEARCH_PROMPT_VERSION ||
        LEGACY_RESEARCH_PROMPT_VERSIONS.has(saved.data.promptVersion));
    if (!saved.success || saved.data.jobId !== jobId || !knownPrompt) {
      return fail("invalid-report");
    }
    if (
      JSON.stringify(saved.data.retainedRecovery ?? null) !==
      JSON.stringify(request.retainedRecovery ?? null)
    )
      return fail("invalid-report");
    if (
      retained &&
      (saved.data.report !== retained.retained.data.report ||
        saved.data.model !== retained.retained.data.model ||
        JSON.stringify(saved.data.citations) !==
          JSON.stringify(
            citationUrls(
              [...retained.retained.data.citations, ...retained.retained.data.annotationUrls],
              Number.MAX_SAFE_INTEGER,
            ).slice(0, MAX_SAVED_CITATIONS),
          ))
    )
      return fail("invalid-report");
    warnings = saved.data.warnings ?? [];
    if (warnings.length) {
      if (
        !saved.data.discovery ||
        JSON.stringify(warnings[0]!.discovery) !== JSON.stringify(saved.data.discovery)
      )
        return fail("invalid-report");
      const partial = await readLengthLimitedResearchDiscovery(
        input.artifacts,
        { ...saved.data.discovery, sha256: saved.data.discovery.hash.slice(7) },
        input.operations,
      );
      if (partial.data.report !== saved.data.report || partial.data.model !== saved.data.model)
        return fail("invalid-report");
    }
    legacyDiscovery = !saved.data.discovery;
    if (saved.data.discovery)
      discoveryRef = { ...saved.data.discovery, sha256: saved.data.discovery.hash.slice(7) };
    discoveryCompleteness = saved.data.discoveryCompleteness;
    report = {
      model: saved.data.model,
      report: saved.data.report,
      citations: saved.data.citations,
      ...(saved.data.costUsd === undefined ? {} : { costUsd: saved.data.costUsd }),
      ...(saved.data.omittedCitations ? { omittedCitations: saved.data.omittedCitations } : {}),
    } as typeof report;
  } else if (retained) {
    discoveryRef = {
      ...submitted.retainedRecovery!.discovery,
      sha256: submitted.retainedRecovery!.discovery.hash.slice(7),
    };
    warnings = [outputLimitWarning(submitted.retainedRecovery!.discovery)];
    discoveryCompleteness = retained.retained.data.citationProvenance;
    const data = retained.retained.data;
    const all = citationUrls([...data.citations, ...data.annotationUrls], Number.MAX_SAFE_INTEGER);
    report = {
      report: data.report,
      model: data.model,
      citations: all.slice(0, MAX_SAVED_CITATIONS),
      ...(all.length > MAX_SAVED_CITATIONS
        ? { omittedCitations: all.length - MAX_SAVED_CITATIONS }
        : {}),
      costUsd: 0,
    };
  } else {
    const sonar = input.sonar!;
    try {
      const captured = await captureResearchDiscovery({
        artifacts: input.artifacts,
        operations: input.operations,
        request,
        owner: input.owner,
        partialReport: "warning-v1",
        reuseSavedAttempt: sonar.liveTokens,
        processor: {
          version: "research-discovery-v1",
          model: sonar.model,
          promptVersion: RESEARCH_PROMPT_VERSION,
          parameters:
            sonar.discoveryParameters ??
            (sonar.settings
              ? {
                  timeoutMs: sonar.settings.timeoutMs,
                  maxOutputTokens: sonar.settings.maxOutputTokens,
                }
              : {}),
        },
        invoke: async (capture) =>
          discoveryFromAdapterReport(
            await sonar.research(researchPrompt(request), signal, capture),
          ),
        now,
      });
      discoveryRef = captured.ref;
      if (captured.partial)
        warnings = [
          outputLimitWarning({
            repository: captured.ref.repository,
            commit: captured.ref.commit,
            path: captured.ref.path,
            hash: `sha256:${captured.ref.sha256}`,
          }),
        ];
      discoveryCompleteness = captured.data.citationProvenance;
      const all = citationUrls(
          [...captured.data.citations, ...captured.data.annotationUrls],
          Number.MAX_SAFE_INTEGER,
        ),
        kept = all.slice(0, 500);
      report = {
        report: captured.data.report,
        model: captured.data.model,
        citations: kept,
        ...(all.length > kept.length ? { omittedCitations: all.length - kept.length } : {}),
        ...(captured.data.usage?.costUsd === undefined
          ? {}
          : { costUsd: captured.data.usage.costUsd }),
      };
    } catch (error) {
      if (
        error instanceof ConfigurationError ||
        (sonar.liveTokens && error instanceof ArtifactStoreError)
      ) {
        input.operations.yieldClaim(opened.claim);
        throw error;
      }
      if (error instanceof ResearchDiscoveryError && error.code === "busy") {
        input.operations.yieldClaim(opened.claim);
        return { status: "busy", jobId };
      }
      if (error instanceof ResearchDiscoveryError && error.code === "invalid-report")
        return fail("invalid-report");
      if (error instanceof ModelProviderError && error.code === "timeout") return fail("timeout");
      if (error instanceof ModelProviderError && error.code === "credit-exhausted") {
        return creditBlocked();
      }
      return fail("provider-error");
    }
  }
  const reportRef = await writeOnce(input.artifacts, `${dir}/report.json`, {
    schemaVersion: RESEARCH_JOB_SCHEMA_VERSION,
    jobId,
    promptVersion: RESEARCH_PROMPT_VERSION,
    model: report.model,
    report: report.report,
    citations: report.citations,
    ...(discoveryRef
      ? {
          discovery: {
            repository: discoveryRef.repository,
            commit: discoveryRef.commit,
            path: discoveryRef.path,
            hash: `sha256:${discoveryRef.sha256}`,
          },
        }
      : {}),
    ...(discoveryCompleteness ? { discoveryCompleteness } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(request.retainedRecovery ? { retainedRecovery: request.retainedRecovery } : {}),
    ...(report.costUsd === undefined ? {} : { costUsd: report.costUsd }),
    ...(report.omittedCitations ? { omittedCitations: report.omittedCitations } : {}),
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
  const gaps: string[] = legacyDiscovery
    ? [
        "Legacy report-only discovery lacks the original provider citation envelope and available usage metadata; it has not been reconstructed.",
      ]
    : [];
  if (warnings.length && !request.retainedRecovery) gaps.push(warnings[0]!.message);
  if (request.retainedRecovery)
    gaps.push(
      "The original provider report stopped at its output limit. Missing report text was not reconstructed; this recovery made no new discovery call.",
    );
  const monitored = (url: string) => {
    const host = new URL(url).hostname.toLowerCase();
    return (input.monitoredHosts ?? []).some(
      (h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`),
    );
  };
  for (const [index, url] of report.citations.entries()) {
    keepLease();
    if (index >= limits.maxSources) {
      citations.push({
        url,
        retrieval: "not-attempted",
        retrievalReason: "source-limit",
        passages: [],
      });
      continue;
    }
    const sourcePath = `${dir}/sources/${sha(url).slice(0, 32)}.json`;
    // A snapshot saved by an earlier attempt of this job (one that stopped for
    // lack of credit) is the pinned source: judge exactly that text rather
    // than a fresh fetch that may have changed since (#407).
    const savedSource = await input.artifacts.lookup(sourcePath);
    let text: string;
    let archived;
    if (savedSource) {
      const saved = savedSourceSchema(limits.maxSourceChars).safeParse(
        parseJson(await input.artifacts.read(savedSource)),
      );
      // The snapshot must be the source for this exact URL with bounded text;
      // anything else is invalid retained state, not a reason to refetch.
      if (!saved.success || saved.data.url !== url) return fail("invalid-report");
      archived = savedSource;
      text = saved.data.text;
    } else {
      let page;
      try {
        page = await withDeadline(limits.sourceTimeoutMs, (s) => input.fetcher.fetch(url, s));
      } catch (error) {
        const { retrieval, reason } = retrievalOf(error);
        citations.push({ url, retrieval, retrievalReason: reason, passages: [] });
        continue;
      }
      text = page.text.slice(0, limits.maxSourceChars);
      archived = await writeOnce(input.artifacts, sourcePath, {
        url,
        title: page.title,
        ...(page.publisher ? { publisher: page.publisher } : {}),
        ...(page.publishedAt ? { publishedAt: page.publishedAt } : {}),
        truncated: page.text.length > text.length,
        text,
      });
    }
    let passages: ResearchManifest["citations"][number]["passages"] = [];
    let support: "supported" | "unverified" | "not-checked" = "not-checked";
    let sourceType: string | undefined;
    let rationale: string | undefined;
    const own = monitored(url);
    // The claimant's own pages are checked too, so each claim gets explicit,
    // verbatim attribution passages; they stay "unverified" and are labelled
    // monitored, so they never count as independent support.
    if (input.judge) {
      try {
        const source = normalise(text);
        const judgement = await input.judge.judge(
          { findings, report: report.report, url, source: text },
          signal,
        );
        // "monitored-source" is reserved for the configured host decision.
        const proposedType = judgement.sourceType?.slice(0, 100);
        sourceType = proposedType === "monitored-source" ? undefined : proposedType;
        rationale = judgement.rationale?.slice(0, 2000);
        passages = judgement.passages
          .filter((p) => findingIds.has(p.findingId) && p.passage.trim().length > 0)
          .filter((p) => source.includes(normalise(p.passage)))
          .slice(0, 50)
          .map((p) => ({ claimRecordId: p.findingId, passage: p.passage.trim().slice(0, 4000) }));
        support = own ? "unverified" : passages.length > 0 ? "supported" : "unverified";
      } catch (error) {
        // A judge that ran out of credit must not leave the citation "not
        // checked" in a terminal result: stop the job, recoverably (#407).
        if (error instanceof ModelProviderError && error.code === "credit-exhausted") {
          return creditBlocked();
        }
        support = own ? "unverified" : "not-checked";
      }
    } else if (own) {
      support = "unverified";
    }
    citations.push({
      url,
      retrieval: "archived",
      ...(own
        ? {
            sourceType: "monitored-source",
            confidenceRationale: "The claimant's own material; not independent support.",
          }
        : {
            sourceType: sourceType ?? "web-page",
            confidenceRationale:
              rationale ??
              (support === "not-checked"
                ? "Support was not checked."
                : support === "supported"
                  ? "Contains a verbatim passage supporting the report's conclusion."
                  : "No passage directly supports the report's conclusion."),
          }),
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
  if (report.omittedCitations) {
    gaps.push(
      `${report.omittedCitations} further cited source(s) exceeded the manifest limit and were not recorded.`,
    );
  }
  const notArchived = count((c) => c.retrieval !== "archived");
  if (notArchived > 0)
    gaps.push(`${notArchived} cited source(s) could not be archived (see retrieval reasons).`);
  const unchecked = count((c) => c.retrieval === "archived" && c.support !== "supported");
  if (unchecked > 0)
    gaps.push(`${unchecked} archived source(s) have no verified supporting passage.`);
  for (const f of findings) {
    if (
      !citations.some(
        (c) =>
          c.sourceType !== "monitored-source" && c.passages.some((p) => p.claimRecordId === f.id),
      )
    ) {
      gaps.push(`No verified supporting passage for finding ${f.id}.`);
    }
  }

  const archivedCount = citations.length - notArchived;
  const note = [
    `# Research job ${jobId}`,
    "",
    request.retainedRecovery
      ? `An incomplete retained ${report.model} response was reused without a new discovery call; ${citations.length} source(s) cited, ${archivedCount} archived, ${count((c) => c.support === "supported")} with verified supporting passages.`
      : `One ${report.model} pass (${RESEARCH_PROMPT_VERSION}) cited ${citations.length} source(s); ${archivedCount} archived, ${count((c) => c.support === "supported")} with verified supporting passages.`,
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
    ...(request.retainedRecovery
      ? {
          retainedRecovery: request.retainedRecovery,
          discovery: request.retainedRecovery.discovery,
        }
      : {}),
    ...(discoveryRef ? { discovery: ref(discoveryRef) } : {}),
    coveringNote: ref(noteRef),
    ...(warnings.length ? { warnings } : {}),
    citations,
    gaps: gaps.slice(0, 100),
    provider: {
      model: report.model,
      ...(report.costUsd !== undefined ? { costUsd: report.costUsd } : {}),
    },
  });
  keepLease();
  const manifestRef = await writeOnce(input.artifacts, `${dir}/manifest.json`, manifest);
  const done = await finishResearchJob({
    artifacts: input.artifacts,
    operations: input.operations,
    jobId,
    outcome: gaps.length === 0 ? "complete" : "complete-with-gaps",
    manifest: manifestRef,
    ...(warnings.length ? { warnings } : {}),
    now,
  });
  reportPartialResearch(input.operations, done.result);
  return { status: "finished", jobId, result: done.result, reused: false };
}
