import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { OperationStore } from "../controllers/operation-store.js";
import { PublicPageFetcher } from "../controllers/research-web.js";
import { sonarFromEnv } from "../controllers/sonar.js";
import { dossierPath, DossierStore } from "../research/dossier.js";
import { ResearchRequestSchema } from "../research/job.js";
import { runSonarResearch } from "../research/sonar-runner.js";

const usage =
  "Usage: research-subject --subject <subject> [--question <question>] [--brief <brief>] [--dossier <id>] [--json]";
const Config = z.object({
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
  STEELE_STATE_PATH: z.string().min(1),
  STEELE_RESEARCH_MODEL: z.string().min(1).default("perplexity/sonar-deep-research"),
  STEELE_RESEARCH_TIMEOUT_MS: z.coerce.number().int().min(1).max(600_000).default(180_000),
  STEELE_RESEARCH_MAX_TOKENS: z.coerce.number().int().min(1).max(16_000).default(4000),
});

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      subject: { type: "string" },
      question: { type: "string" },
      brief: { type: "string" },
      dossier: { type: "string" },
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
  const configuration = Config.safeParse(process.env);
  if (!parsed.success || !configuration.success) {
    console.error(parsed.success ? "Research configuration is invalid or incomplete." : usage);
    return 2;
  }
  const request = parsed.data;
  const c = configuration.data;
  if (values.dossier) dossierPath(values.dossier);
  const discover = sonarFromEnv({
    model: c.STEELE_RESEARCH_MODEL,
    timeoutMs: c.STEELE_RESEARCH_TIMEOUT_MS,
    maxTokens: c.STEELE_RESEARCH_MAX_TOKENS,
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
    let attachment;
    if (values.dossier && outcome.status === "finished" && outcome.result.manifest) {
      const { manifest } = outcome.result;
      const dossiers = new DossierStore(artifacts);
      const current = await dossiers.current(values.dossier);
      const link = `\n- Research job \`${outcome.result.jobId}\`: \`${manifest.commit}:${manifest.path}\`\n`;
      if (!current?.body.includes(link.trim())) {
        attachment = (
          await dossiers.save(
            {
              metadata: {
                ...(current?.metadata ?? {
                  schemaVersion: 1,
                  themeId: values.dossier,
                  title: request.subject!.slice(0, 200),
                  scope: request.subject!,
                  claims: [],
                  citations: [],
                  gaps: [],
                }),
                updatedAt: outcome.result.finishedAt,
              },
              body: `${current?.body ?? "# Research jobs"}\n${link}`,
            },
            current?.ref,
          )
        ).ref;
      } else {
        attachment = current.ref;
      }
    }
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

try {
  process.exitCode = await main();
} catch {
  console.error(
    "Could not complete the command. Check credentials, arguments and private storage, then inspect the saved job.",
  );
  process.exitCode = 1;
}
