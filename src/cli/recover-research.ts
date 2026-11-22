/** Saved-response recovery only: this entry point never constructs a discovery/Sonar client. */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { OperationStore } from "../controllers/operation-store.js";
import { PublicPageFetcher } from "../controllers/research-web.js";
import { openRouterFromEnv } from "../controllers/openrouter.js";
import { ModelSupportJudge } from "../research/support-judge.js";
import { recoverRetainedResearch } from "../research/retained-research.js";
const Input = z
  .object({ discovery: ArtifactReferenceSchema, failedResult: ArtifactReferenceSchema })
  .strict();
const Config = z.object({
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
  STEELE_STATE_PATH: z.string().min(1),
});
const usage =
  "Usage: recover-research --input <private-reference-json-file> [--max-sources <1..20>] [--json]";
async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      "max-sources": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(usage);
    return 0;
  }
  const config = Config.safeParse(process.env),
    limit = z.coerce.number().int().min(1).max(20).default(20).safeParse(values["max-sources"]);
  if (!values.input || !config.success || !limit.success) {
    console.error(usage);
    return 2;
  }
  let refs;
  try {
    const raw = await readFile(values.input, "utf8");
    if (raw.length > 32_000) throw new Error();
    refs = Input.parse(JSON.parse(raw));
  } catch {
    console.error("Invalid retained research references.");
    return 2;
  }
  const operations = new OperationStore({ path: config.data.STEELE_STATE_PATH });
  try {
    const provider = openRouterFromEnv({
      env: {
        ...process.env,
        ...(process.env.STEELE_MODEL_SUPPORT
          ? { STEELE_MODEL: process.env.STEELE_MODEL_SUPPORT }
          : {}),
      },
    });
    const from = (r: z.infer<typeof ArtifactReferenceSchema>) => ({
      ...r,
      sha256: r.hash.slice(7),
    });
    const out = await recoverRetainedResearch({
      artifacts: new GitArtifactStore({
        repoPath: config.data.STEELE_CONTENT_PATH,
        repository: config.data.STEELE_CONTENT_REPOSITORY,
      }),
      operations,
      discovery: from(refs.discovery),
      failedResult: from(refs.failedResult),
      owner: `retained-research-${randomUUID()}`,
      fetcher: new PublicPageFetcher(),
      judge: new ModelSupportJudge(provider),
      limits: { maxSources: limit.data },
      monitoredHosts: process.env.STEELE_MONITORED_HOSTS?.split(",")
        .map((h) => h.trim())
        .filter(Boolean),
    });
    console.log(JSON.stringify(out));
    return out.status === "recovered" ? 0 : 1;
  } catch {
    console.error(
      "Retained research recovery stopped; inspect the saved artifacts and operation state.",
    );
    return 1;
  } finally {
    operations.close();
  }
}
process.exitCode = await main();
