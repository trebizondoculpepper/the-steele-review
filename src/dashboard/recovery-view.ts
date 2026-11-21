import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { articleRunKey, type ArticleRunInput } from "../workflow/article-run.js";
import { isCreditBlocked } from "./article-views.js";
import type { RunState, RunStatusPort } from "./articles.js";
import { escapeHtml, type DashboardView } from "./server.js";
import { prepareArticleInput, type ArticleSubmissionPort } from "./trigger.js";
import type { RecoveryIdentities } from "./recovery.js";

/**
 * Explicit recovery of a stopped article run (#480).
 *
 * Only a run that is finished with a documented recoverable operational
 * reason (today: provider credit exhaustion) can be recovered. The recovery
 * uses one durably recorded workflow identity per normal run, so duplicate
 * clicks, reconnects and an uncertain submission response all resolve to the
 * same run. Prior state is never erased and stages reuse their saved work.
 */

export interface ArticleRecoveryDeps {
  archive: Pick<GitArtifactStore, "lookup" | "read">;
  researchDeadlineMs: number;
  researchRequestLimit: number;
  submitter: ArticleSubmissionPort;
  runs: RunStatusPort;
  identities: RecoveryIdentities;
}

/** The recoverable reason this action supports. */
export const recoveryEligible = (run: RunState): boolean =>
  run.state === "finished" && isCreditBlocked(run.result.reason);

const postOf = (input: ArticleRunInput) => ({
  publicationId: input.publicationId,
  postId: input.postId,
  sourceVersion: input.sourceVersion,
});

export function articleRecovery(deps: ArticleRecoveryDeps) {
  const selectionFrom = (url: URL) => Object.fromEntries(url.searchParams);
  const view: DashboardView = {
    path: "/articles/recover",
    title: "Recover stopped run",
    hidden: true,
    async render(url) {
      const input = await prepareArticleInput(deps, selectionFrom(url));
      if (!input) {
        return "<p>The selected captured revision is unavailable or has changed. Return to the article trace.</p>";
      }
      let run: RunState;
      try {
        run = await deps.runs.status(postOf(input));
      } catch {
        run = { state: "unavailable" };
      }
      if (!recoveryEligible(run)) {
        return "<p>This run is not stopped on a recoverable operational failure, so recovery is not available. Use the normal run action or inspect the trace.</p>";
      }
      const fields = Object.entries(selectionFrom(url))
        .map(
          ([name, value]) =>
            `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
        )
        .join("");
      return `<p>Recover ${escapeHtml(input.publicationId)}/${escapeHtml(input.postId)} at <code>${escapeHtml(input.sourceVersion)}</code>.</p>
<p>The earlier run stopped because the model provider's credit budget ran out. This starts one recovery run under a new, durably recorded identity; completed stage results are reused and existing state is not changed.</p>
<p>This can incur model and research charges. Repeated confirmation reuses the same recovery identity.</p>
<form method="post" action="/articles/recover">${fields}<button name="confirm" value="yes">Confirm recovery</button></form>`;
    },
  };
  return {
    view,
    async submit(form: URLSearchParams): Promise<{ status: number; location?: string }> {
      if (form.get("confirm") !== "yes") return { status: 400 };
      const values = Object.fromEntries(form);
      delete values.confirm;
      const input = await prepareArticleInput(deps, values);
      if (!input) return { status: 409 };
      let run: RunState;
      try {
        run = await deps.runs.status(postOf(input));
      } catch {
        return { status: 409 };
      }
      if (!recoveryEligible(run)) return { status: 409 };
      let identity;
      try {
        ({ identity } = await deps.identities.ensure(articleRunKey(input)));
      } catch {
        // A concurrent submission owns the identity: never start a second run.
        return { status: 409 };
      }
      await deps.submitter.submit({ ...input, recoveryGeneration: 1 }, identity.workflowKey);
      return {
        status: 303,
        location: `/articles/trace?publication=${encodeURIComponent(input.publicationId)}&post=${encodeURIComponent(input.postId)}`,
      };
    },
  };
}
