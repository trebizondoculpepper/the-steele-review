import { exportPipelineLog } from "../controllers/sentry-logs.js";
import type { OperationStore } from "../controllers/operation-store.js";
import {
  ResearchResultSchema,
  ResearchWarningSchema,
  type ResearchResult,
} from "../research/job.js";

/** Best-effort diagnostics only: no source prose, URL, prompt, secret or artifact path. */
export function reportPartialResearch(
  operations: Pick<OperationStore, "markResearchPartialWarning">,
  result: ResearchResult,
): void {
  try {
    const parsed = ResearchResultSchema.parse(result);
    for (const raw of parsed.warnings ?? []) {
      const warning = ResearchWarningSchema.parse(raw);
      if (
        !operations.markResearchPartialWarning({
          jobId: parsed.jobId,
          discoveryHash: warning.discovery.hash,
        })
      )
        continue;
      // Reserve before export so restarts/recovered aliases never repeat the
      // warning. A crash here can lose telemetry; the durable warning remains
      // in the research artifacts and UI. Telemetry never controls processing.
      exportPipelineLog(
        {
          correlation_id: parsed.jobId,
          stage: "research",
          outcome: "partial-report-output-limit",
          revision: warning.discovery.hash,
        },
        "warn",
      );
    }
  } catch {
    /* State/Sentry availability must never veto usable research. */
  }
}
