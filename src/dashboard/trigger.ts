import {
  researchExecutionFromEnv,
  researchSelectionFor,
  NON_BLOCKING_PACKAGE,
} from "../workflow/research-execution.js";
import { DEFAULT_EDITORIAL_POLICY, type EditorialPolicy } from "../workflow/editorial-contract.js";
import { z } from "zod";
import { CollectionRecordSchema, collectionArtifactPath } from "../collection/collection-store.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import {
  ArticleRunInputSchema,
  articleRunKey,
  type ArticleRunInput,
} from "../workflow/article-run.js";
import { escapeHtml, type DashboardView } from "./server.js";
import { randomUUID } from "node:crypto";
import type { OperationStore } from "../controllers/operation-store.js";
import { recordArticleAttempt } from "../workflow/article-attempt.js";
import type { RunStatusPort } from "./articles.js";

/** A one-time submission token carried by the confirm form (#749). */
const REQUEST = /^console-[0-9a-f-]{36}$/;
const requestKey = (token: string) => `console-run-request:${token}`;

/** The run a confirm token already started, if any (#749). */
function boundRun(ops: Pick<OperationStore, "operationStatus">, token: string): string | undefined {
  const status = ops.operationStatus(requestKey(token));
  if (status?.status !== "completed") return undefined;
  const key = (status.artifact as { workflowKey?: unknown } | undefined)?.workflowKey;
  return typeof key === "string" ? key : undefined;
}

/**
 * Bind a confirm token to the run it starts, before submitting, so one
 * confirmation can never start two runs. False when another submission of
 * the same token holds or already completed the binding.
 */
function bindRun(
  ops: Pick<OperationStore, "claim" | "complete">,
  token: string,
  workflowKey: string,
): boolean {
  const claim = ops.claim(requestKey(token), "dashboard-run", 60_000, 3);
  if (claim.kind !== "claimed") return false;
  try {
    ops.complete(claim.claim, { workflowKey }, []);
    return true;
  } catch {
    return false;
  }
}

const Selection = z
  .object({
    publication: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/),
    post: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/),
    revision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export interface ArticleSubmissionPort {
  /**
   * Submit a run. `workflowKey` is only supplied for an explicit recovery;
   * ordinary submissions use the stable key derived from the input.
   */
  submit(input: ArticleRunInput, workflowKey?: string): Promise<void>;
}

/** Resolve the exact confirmed revision using the archive controller only. */
export async function prepareArticleInput(
  deps: {
    archive: Pick<GitArtifactStore, "lookup" | "read">;
    researchDeadlineMs: number;
    researchRequestLimit: number;
    editorialPolicy?: EditorialPolicy;
  },
  selection: unknown,
): Promise<ArticleRunInput | undefined> {
  {
    const parsed = Selection.safeParse(selection);
    if (!parsed.success) return undefined;
    const { publication, post, revision } = parsed.data;
    const target = { publicationId: publication, postId: post };
    const ref = await deps.archive.lookup(collectionArtifactPath(target));
    if (!ref) return undefined;
    const record = CollectionRecordSchema.parse(JSON.parse(await deps.archive.read(ref)));
    if (
      !record.complete ||
      record.item.publicationId !== publication ||
      record.item.postId !== post ||
      sourceVersionFor(record.text) !== revision
    )
      return undefined;
    return ArticleRunInputSchema.parse({
      ...target,
      sourceVersion: revision,
      editorial: deps.editorialPolicy ?? DEFAULT_EDITORIAL_POLICY,
      sourceUrl: record.item.url,
      researchDeadlineMs: deps.researchDeadlineMs,
      researchRequestLimit: deps.researchRequestLimit,
      ...researchSelectionFor(deps.researchRequestLimit),
      ...researchExecutionFromEnv(),
      ...NON_BLOCKING_PACKAGE,
      source: { namespace: `substack/${publication}`, itemId: post, artifact: ref },
    });
  }
}

/** Resolve the exact confirmed revision using the archive controller only. */
export function articleTrigger(deps: {
  archive: Pick<GitArtifactStore, "lookup" | "read">;
  submitter: ArticleSubmissionPort;
  researchDeadlineMs: number;
  researchRequestLimit: number;
  editorialPolicy?: EditorialPolicy;
  /**
   * Rescheduling a finished run (#749): the current run state of the
   * revision, and the typed attempt store that records a fresh attempt.
   * Without them a finished revision is never rerun from the console.
   */
  runs?: RunStatusPort;
  attempts?: Pick<
    OperationStore,
    "recordArticleAttempt" | "claim" | "complete" | "operationStatus"
  >;
}) {
  const prepare = (selection: unknown) => prepareArticleInput(deps, selection);
  const view: DashboardView = {
    path: "/articles/run",
    title: "Run article",
    hidden: true,
    async render(url) {
      const selection = Object.fromEntries(url.searchParams);
      const input = await prepare(selection);
      if (!input)
        return "<p>The selected captured revision is unavailable or has changed. Return to the article trace.</p>";
      // A fresh token per confirm page: resubmitting this form attaches to
      // the attempt it started instead of starting another paid run.
      const fields = Object.entries({ ...selection, request: `console-${randomUUID()}` })
        .map(
          ([name, value]) =>
            `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
        )
        .join("");
      return `<p>Run ${escapeHtml(input.publicationId)}/${escapeHtml(input.postId)} at <code>${escapeHtml(input.sourceVersion)}</code>.</p>
<p>This can incur model and research charges. Provider key limits are controlled externally. Research is limited to ${input.researchRequestLimit} requests and ${input.researchDeadlineMs} milliseconds. If this revision's last run has finished, confirming starts a new attempt and keeps the earlier result as history; confirming the same form again reuses that attempt. This action does not change publication settings.</p>
<form method="post" action="/articles/run">${fields}<button name="confirm" value="yes">Confirm article run</button></form>`;
    },
  };
  return {
    view,
    async submit(form: URLSearchParams): Promise<{ status: number; location?: string }> {
      if (form.get("confirm") !== "yes") return { status: 400 };
      const values = Object.fromEntries(form);
      delete values.confirm;
      const request = values.request;
      delete values.request;
      const input = await prepare(values);
      if (!input) return { status: 409 };
      const done = {
        status: 303,
        location: `/articles/trace?publication=${encodeURIComponent(input.publicationId)}&post=${encodeURIComponent(input.postId)}`,
      };
      if (!deps.runs) {
        // Stable identity is shared with CLI and captured-content ingress.
        await deps.submitter.submit(input);
        return done;
      }
      const token = typeof request === "string" && REQUEST.test(request) ? request : undefined;
      // A token that already started a run only attaches to it, whatever
      // state that run has reached since: one confirmation, one run.
      if (token && deps.attempts && boundRun(deps.attempts, token)) return done;
      let state;
      try {
        state = await deps.runs.status(input);
      } catch {
        state = { state: "unavailable" as const };
      }
      // Unknown state: never guess, so a running or finished run is not
      // duplicated and a stale failure is not reported as current.
      if (state.state === "unavailable") return { status: 503 };
      if (state.state === "finished" && state.recovery) {
        // An explicit recovery of this run is active or unknown (#480):
        // never start another paid attempt beside it.
        if (state.recovery.state === "unavailable") return { status: 503 };
        if (state.recovery.state !== "finished") return done;
      }
      if (state.state === "finished") {
        // A finished run cannot be restarted under its own key: record an
        // explicit new attempt and submit under its identity (#749). The
        // earlier result stays readable as history.
        if (!deps.attempts || !token) return { status: 409 };
        let recorded;
        try {
          recorded = recordArticleAttempt(deps.attempts, input, token);
        } catch {
          return { status: 409 };
        }
        if (!bindRun(deps.attempts, token, recorded.identity.workflowKey)) return done;
        await deps.submitter.submit(recorded.input, recorded.identity.workflowKey);
        return done;
      }
      if (state.state === "not-started") {
        const latest = state.workflowKey ? state.attempts?.[0] : undefined;
        if (!latest) {
          // Never run: the stable identity shared with the CLI and ingress,
          // bound to this token first when attempts are recorded.
          if (deps.attempts) {
            if (!token) return { status: 409 };
            if (!bindRun(deps.attempts, token, articleRunKey(input))) return done;
          }
          await deps.submitter.submit(input);
        } else if (deps.attempts) {
          // A recorded attempt whose submission never reached the engine:
          // submit that same attempt again (its recorded input must match).
          try {
            const again = recordArticleAttempt(deps.attempts, input, latest.requestId);
            await deps.submitter.submit(again.input, again.identity.workflowKey);
          } catch {
            return { status: 409 };
          }
        }
      }
      // Queued or running: attach only; nothing new is submitted.
      return done;
    },
  };
}
