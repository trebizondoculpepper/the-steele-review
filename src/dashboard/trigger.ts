import { researchExecutionFromEnv } from "../workflow/research-execution.js";
import { z } from "zod";
import { CollectionRecordSchema, collectionArtifactPath } from "../collection/collection-store.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { ArticleRunInputSchema, type ArticleRunInput } from "../workflow/article-run.js";
import { escapeHtml, type DashboardView } from "./server.js";

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
      sourceUrl: record.item.url,
      researchDeadlineMs: deps.researchDeadlineMs,
      researchRequestLimit: deps.researchRequestLimit,
      ...researchExecutionFromEnv(),
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
      const fields = Object.entries(selection)
        .map(
          ([name, value]) =>
            `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
        )
        .join("");
      return `<p>Run ${escapeHtml(input.publicationId)}/${escapeHtml(input.postId)} at <code>${escapeHtml(input.sourceVersion)}</code>.</p>
<p>This can incur model and research charges. Provider key limits are controlled externally. Research is limited to ${input.researchRequestLimit} requests and ${input.researchDeadlineMs} milliseconds. Repeated submission reuses the same workflow. This action does not change publication settings.</p>
<form method="post" action="/articles/run">${fields}<button name="confirm" value="yes">Confirm article run</button></form>`;
    },
  };
  return {
    view,
    async submit(form: URLSearchParams): Promise<{ status: number; location?: string }> {
      if (form.get("confirm") !== "yes") return { status: 400 };
      const values = Object.fromEntries(form);
      delete values.confirm;
      const input = await prepare(values);
      if (!input) return { status: 409 };
      // Stable identity is shared with CLI and captured-content ingress.
      await deps.submitter.submit(input);
      return {
        status: 303,
        location: `/articles/trace?publication=${encodeURIComponent(input.publicationId)}&post=${encodeURIComponent(input.postId)}`,
      };
    },
  };
}
