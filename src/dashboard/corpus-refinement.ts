import type {
  CorpusRefinementSubmission,
  CorpusRefinementSubmitter,
} from "../corpus-refinement/submission.js";
import { CorpusRefinementInputError } from "../corpus-refinement/submission.js";
import type { RestateUiLinks } from "./restate-links.js";
import { escapeHtml, type DashboardView } from "./server.js";

/**
 * Run Corpus Refinement from the console (#831). The action submits the same
 * registered workflow as the CLI, through the same submission contract, in
 * bounded fixture mode. It is independent of article generation and
 * publishing. The dashboard's same-origin action check applies to the POST.
 * A repeated submission of the same run ID attaches to the existing
 * invocation; the page then shows that invocation and, when the Restate
 * console is configured, a progress link to it.
 */

const RUN_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const INVOCATION = /^inv_[A-Za-z0-9]{10,100}$/;
const SUBMITTED = new Set(["started", "already-submitted"]);

export function corpusRefinementAction(deps: {
  submitter: CorpusRefinementSubmitter;
  /** Restate console links, when configured (#561, #816). */
  links?: RestateUiLinks;
}) {
  const view: DashboardView = {
    path: "/corpus-refinement",
    title: "Corpus Refinement",
    render(url) {
      const runId = url.searchParams.get("run") ?? "";
      const invocationId = url.searchParams.get("invocation") ?? "";
      const submitted = url.searchParams.get("submitted") ?? "";
      const error = url.searchParams.get("error");
      let result = "";
      if (RUN_ID.test(runId) && INVOCATION.test(invocationId) && SUBMITTED.has(submitted)) {
        const progress = deps.links?.invocation(invocationId);
        result = `<h2>Submitted</h2><dl><dt>Run ID</dt><dd><code>${escapeHtml(runId)}</code></dd><dt>Invocation</dt><dd><code>${escapeHtml(invocationId)}</code></dd><dt>Submission</dt><dd>${
          submitted === "started" ? "started a new run" : "attached to the existing run"
        }</dd></dl>${
          progress
            ? `<p><a href="${escapeHtml(progress)}" target="_blank" rel="noopener noreferrer">Open progress in the Restate console</a></p>`
            : "<p>Progress link unavailable: the Restate console is not configured.</p>"
        }`;
      } else if (error === "invalid") {
        result = '<p class="empty">The run ID or batch size was not valid.</p>';
      } else if (error === "unavailable") {
        result = '<p class="empty">The workflow could not be reached; nothing was submitted.</p>';
      }
      return `<p>Runs the Corpus Refinement prototype on a bounded <strong>fixture</strong> batch: three stages, no model calls, no archive writes, and no effect on articles or publishing. The same run ID always names the same run; submitting it again attaches to that run.</p>
${result}
<form method="post" action="/corpus-refinement/run">
<p><label>Run ID <input name="run" required pattern="[a-z0-9][a-z0-9-]{0,99}" maxlength="100" placeholder="e.g. fixture-2026-11-24"></label></p>
<p><label>Batch size <input name="size" type="number" min="1" max="200" value="5" required></label></p>
<button name="confirm" value="yes">Run Corpus Refinement</button>
</form>`;
    },
  };

  const back = (query: Record<string, string>) => ({
    status: 303,
    location: `/corpus-refinement?${new URLSearchParams(query).toString()}`,
  });

  return {
    view,
    async submit(form: URLSearchParams): Promise<{ status: number; location?: string }> {
      if (form.get("confirm") !== "yes") return { status: 400 };
      const runId = form.get("run") ?? "";
      const size = Number(form.get("size") ?? "5");
      let sent: CorpusRefinementSubmission;
      try {
        sent = await deps.submitter.submit(runId, size);
      } catch (error) {
        return back({
          error: error instanceof CorpusRefinementInputError ? "invalid" : "unavailable",
        });
      }
      return back({ run: sent.runId, invocation: sent.invocationId, submitted: sent.submitted });
    },
  };
}
