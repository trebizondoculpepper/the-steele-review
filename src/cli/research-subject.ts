import { researchTokensFromConfiguration } from "../config/research-tokens.js";
import { DEFAULT_SONAR_MAX_OUTPUT_TOKENS } from "../research/sonar.js";
import { ResearchModelSelectionSchema } from "../config/research-model.js";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { OperationStore } from "../controllers/operation-store.js";
import { PublicPageFetcher } from "../controllers/research-web.js";
import { sonarFromEnv } from "../controllers/sonar.js";
import { dossierPath, DossierStore } from "../research/dossier.js";
import {
  ResearchRequestSchema,
  ResearchResultSchema,
  researchJobId,
  researchJobPath,
  type ResearchRequest,
  type ResearchResult,
} from "../research/job.js";
import type { ArtifactRef } from "../controllers/artifact-store.js";
import {
  reprocessedRequest,
  restateResearchIngress,
  submitManualResearch,
} from "../research/research-submission.js";
import { researchExecutionFromEnv } from "../workflow/research-execution.js";
import { runSonarResearch } from "../research/sonar-runner.js";

const usage = `Usage: research-subject --subject <subject> [--question <question>] [--brief <brief>] [--json]
  Submit (default, needs RESTATE_INGRESS_URL): [--wait <ms>] [--reprocess <n>] [--dossier <id> with --wait]
  Status of a saved job, no submission:        --status
  Run in this process (legacy):                --local [--dossier <id>] [--model <id>] [--timeout-ms <1..900000>]`;
const Config = z.object({
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
  STEELE_STATE_PATH: z.string().min(1),
  STEELE_RESEARCH_MODEL: ResearchModelSelectionSchema,
  STEELE_RESEARCH_TIMEOUT_MS: z.coerce.number().int().min(1).max(900_000).default(180_000),
});

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      subject: { type: "string" },
      question: { type: "string" },
      brief: { type: "string" },
      dossier: { type: "string" },
      model: { type: "string" },
      "timeout-ms": { type: "string" },
      local: { type: "boolean" },
      status: { type: "boolean" },
      wait: { type: "string" },
      reprocess: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(usage);
    return 0;
  }
  const parsed = ResearchRequestSchema.safeParse({
    schemaVersion: 1,
    origin: "manual",
    pass: 1,
    subject: values.subject,
    question: values.question,
    brief: values.brief,
    claims: [],
    corpusRefs: [],
  });
  if (!parsed.success) {
    console.error(usage);
    return 2;
  }
  if (!values.local) return submitted(values, parsed.data);
  const configuration = Config.safeParse({
    ...process.env,
    STEELE_RESEARCH_MODEL: {
      configured: process.env.STEELE_RESEARCH_MODEL,
      requested: values.model,
    },
    STEELE_RESEARCH_TIMEOUT_MS: values["timeout-ms"] ?? process.env.STEELE_RESEARCH_TIMEOUT_MS,
  });
  if (!configuration.success) {
    console.error("Research configuration is invalid or incomplete.");
    return 2;
  }
  const request = parsed.data;
  const c = configuration.data;
  if (values.dossier) dossierPath(values.dossier);
  const discover = sonarFromEnv({
    model: c.STEELE_RESEARCH_MODEL,
    timeoutMs: c.STEELE_RESEARCH_TIMEOUT_MS,
    maxTokens: DEFAULT_SONAR_MAX_OUTPUT_TOKENS,
    tokens: researchTokensFromConfiguration(),
  });
  const artifacts = new GitArtifactStore({
    repoPath: c.STEELE_CONTENT_PATH,
    repository: c.STEELE_CONTENT_REPOSITORY,
  });
  const operations = new OperationStore({ path: c.STEELE_STATE_PATH });
  try {
    await artifacts.initialise();
    const outcome = await runSonarResearch({
      artifacts,
      operations,
      owner: randomUUID(),
      request,
      discover,
      fetcher: new PublicPageFetcher({ timeoutMs: 8_000, preserveOriginal: true }),
    });
    const attachment =
      values.dossier && outcome.status === "finished"
        ? await attachToDossier(artifacts, values.dossier, request, outcome.result)
        : undefined;
    const output = { ...outcome, ...(attachment ? { attachment } : {}) };
    if (values.json) console.log(JSON.stringify(output));
    else if (outcome.status === "busy")
      console.log(`Research job ${outcome.jobId} is in progress.`);
    else {
      const { result } = outcome;
      console.log(
        `${result.jobId}: ${result.outcome}${result.failure ? ` (${result.failure})` : ""}`,
      );
      if (result.manifest)
        console.log(`Manifest: ${result.manifest.commit}:${result.manifest.path}`);
      if (attachment) console.log(`Dossier: ${attachment.commit}:${attachment.path}`);
    }
    return outcome.status === "finished" && outcome.result.outcome !== "failed" ? 0 : 1;
  } finally {
    operations.close();
  }
}

/** Link a finished job's manifest into a dossier, once (unchanged behaviour). */
async function attachToDossier(
  artifacts: GitArtifactStore,
  dossierId: string,
  request: ResearchRequest,
  result: ResearchResult,
): Promise<ArtifactRef | undefined> {
  if (!result.manifest) return undefined;
  const { manifest } = result;
  const dossiers = new DossierStore(artifacts);
  const current = await dossiers.current(dossierId);
  const link = `\n- Research job \`${result.jobId}\`: \`${manifest.commit}:${manifest.path}\`\n`;
  if (current?.body.includes(link.trim())) return current.ref;
  return (
    await dossiers.save(
      {
        metadata: {
          ...(current?.metadata ?? {
            schemaVersion: 1,
            themeId: dossierId,
            title: request.subject!.slice(0, 200),
            scope: request.subject!,
            claims: [],
            citations: [],
            gaps: [],
          }),
          updatedAt: result.finishedAt,
        },
        body: `${current?.body ?? "# Research jobs"}\n${link}`,
      },
      current?.ref,
    )
  ).ref;
}

const SubmitConfig = z.object({
  RESTATE_INGRESS_URL: z.url({ protocol: /^https?$/ }),
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
});
// A reprocess is a later pass of the same request; passes are bounded at 5.
const Count = z.coerce.number().int().min(1).max(4);
const WaitMs = z.coerce.number().int().min(1_000).max(3_600_000);

/**
 * Submission client (#594): validates first, then submits to the shared
 * Restate Research service. The model and timeout belong to the worker in
 * this mode, so those options are refused rather than silently ignored.
 */
async function submitted(
  values: Record<string, string | boolean | undefined>,
  request: ResearchRequest,
): Promise<number> {
  if (values.model !== undefined || values["timeout-ms"] !== undefined) {
    console.error(
      "--model and --timeout-ms apply only with --local: submitted research uses the worker's configured model and timeout.",
    );
    return 2;
  }
  const reprocess = values.reprocess === undefined ? 0 : Count.safeParse(values.reprocess);
  const wait = values.wait === undefined ? undefined : WaitMs.safeParse(values.wait);
  if ((typeof reprocess === "object" && !reprocess.success) || (wait && !wait.success)) {
    console.error(usage);
    return 2;
  }
  if (values.dossier && !values.wait && !values.status) {
    console.error("--dossier needs --wait when submitting, so the finished job can be attached.");
    return 2;
  }
  if (values.dossier) dossierPath(String(values.dossier));
  const config = SubmitConfig.safeParse(process.env);
  // --status needs only the content store; submission also needs the ingress.
  if (!config.success && !(values.status && process.env.STEELE_CONTENT_PATH)) {
    console.error("Submission configuration is invalid or incomplete.");
    return 2;
  }
  const artifacts = new GitArtifactStore({
    repoPath: process.env.STEELE_CONTENT_PATH!,
    repository: process.env.STEELE_CONTENT_REPOSITORY ?? "content",
  });
  // Status of exactly the generation asked for (with --reprocess, the later pass).
  const jobId = researchJobId(
    reprocessedRequest(request, typeof reprocess === "object" ? reprocess.data : 0),
  );
  if (values.status) {
    const saved = await artifacts.lookup(researchJobPath(jobId, "result"));
    const result = saved
      ? ResearchResultSchema.parse(JSON.parse(await artifacts.read(saved)))
      : undefined;
    if (values.json) console.log(JSON.stringify({ jobId, ...(result ? { result } : {}) }));
    else console.log(result ? `${jobId}: ${result.outcome}` : `${jobId}: no saved result yet`);
    return result ? 0 : 1;
  }
  const c = config.data!;
  const out = await submitManualResearch({
    ingress: restateResearchIngress(c.RESTATE_INGRESS_URL),
    request,
    ...researchExecutionFlag(),
    ...(typeof reprocess === "object" ? { reprocess: reprocess.data } : {}),
    ...(wait?.success ? { waitMs: wait.data } : {}),
  });
  // A cached "busy" answer (the job was running elsewhere, e.g. --local) is
  // never final: the saved result is read directly, by the same job identity.
  let result = out.job?.result;
  if (!result && out.job?.status === "busy") {
    const saved = await artifacts.lookup(researchJobPath(out.jobId, "result"));
    if (saved) result = ResearchResultSchema.parse(JSON.parse(await artifacts.read(saved)));
    else if (!values.json) console.log("The job is running elsewhere; check later with --status.");
  }
  const attachment =
    values.dossier && result
      ? await attachToDossier(artifacts, String(values.dossier), request, result)
      : undefined;
  if (values.json) {
    console.log(JSON.stringify({ ...out, ...(attachment ? { attachment } : {}) }));
  } else {
    console.log(
      `${out.jobId}: ${out.repeated ? "already submitted" : "submitted"} as ${out.invocationId}`,
    );
    if (out.waitEnded) console.log("Still running; check later with --status.");
    if (result)
      console.log(`Outcome: ${result.outcome}${result.failure ? ` (${result.failure})` : ""}`);
    if (attachment) console.log(`Dossier: ${attachment.commit}:${attachment.path}`);
  }
  if (result) return result.outcome === "failed" ? 1 : 0;
  return 0;
}

const researchExecutionFlag = () => ({
  staged: researchExecutionFromEnv().researchExecution === "staged",
});

try {
  process.exitCode = await main();
} catch {
  console.error(
    "Could not complete the command. Check credentials, arguments and private storage, then inspect the saved job.",
  );
  process.exitCode = 1;
}
