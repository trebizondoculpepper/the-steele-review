/**
 * Reconcile automatic admissions before switching to admission by post
 * (#874). Read-only unless `--apply` is given; prints counts only.
 *
 * Environment:
 *   STEELE_STATE_PATH          the bridge's state database (required)
 *   STEELE_RESTATE_ADMIN_URL   Restate admin API, for ArticleRun keys (optional)
 *   STEELE_CONTENT_PATH        content repository, for captured submissions (optional)
 *   STEELE_CONTENT_REPOSITORY  its repository name (optional)
 */
import { z } from "zod";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { OperationStore } from "../controllers/operation-store.js";
import {
  candidatesFromSubmissionPaths,
  candidatesFromWorkflowKeys,
  reconcileAdmissions,
} from "../workflow/admission-reconcile.js";

const EnvSchema = z.object({
  STEELE_STATE_PATH: z.string().min(1),
  STEELE_RESTATE_ADMIN_URL: z.url({ protocol: /^https?$/ }).optional(),
  STEELE_CONTENT_PATH: z.string().min(1).optional(),
  STEELE_CONTENT_REPOSITORY: z.string().min(1).optional(),
});

async function restateKeys(adminUrl: string): Promise<string[]> {
  const res = await fetch(`${adminUrl.replace(/\/+$/, "")}/query`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      query:
        "SELECT DISTINCT target_service_key AS key FROM sys_invocation WHERE target_service_name = 'ArticleRun' AND target_handler_name = 'run'",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error("restate query failed");
  const body = (await res.json()) as { rows?: { key?: unknown }[] };
  return (body.rows ?? []).flatMap((r) => (typeof r.key === "string" ? [r.key] : []));
}

async function submissionPaths(content: GitArtifactStore): Promise<string[]> {
  const out: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await content.list("article-submissions", 1000, after);
    out.push(...page);
    if (page.length < 1000) return out;
    after = page.at(-1);
  }
}

async function main(): Promise<number> {
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    console.error("reconcile-admissions: STEELE_STATE_PATH is required");
    return 2;
  }
  const apply = process.argv.includes("--apply");
  const e = env.data;
  const candidates = [];
  if (e.STEELE_CONTENT_PATH) {
    const content = new GitArtifactStore({
      repoPath: e.STEELE_CONTENT_PATH,
      repository: e.STEELE_CONTENT_REPOSITORY ?? "steele-content",
    });
    candidates.push(...candidatesFromSubmissionPaths(await submissionPaths(content)));
  }
  if (e.STEELE_RESTATE_ADMIN_URL)
    candidates.push(...candidatesFromWorkflowKeys(await restateKeys(e.STEELE_RESTATE_ADMIN_URL)));
  const operations = new OperationStore({ path: e.STEELE_STATE_PATH });
  try {
    const report = reconcileAdmissions(operations, candidates, { apply });
    console.log(JSON.stringify({ event: "reconcile-admissions", apply, ...report }));
    return 0;
  } finally {
    operations.close();
  }
}

process.exitCode = await main();
