/**
 * Private inspection of saved theme and claim results for one post (#187).
 *
 *   inspect-post --post-id <slug> [--limit <n>] [--json]
 *
 * Configuration (environment): STEELE_PUBLICATION_ID, STEELE_CONTENT_PATH,
 * STEELE_CONTENT_REPOSITORY. Read-only: never initialises or writes the
 * content repository, calls a model or sends events. Shows source quotations
 * and summaries on purpose; do not route this output to public logs.
 *
 * Exit: 0 shown (including "no saved results"); 1 repository unavailable;
 * 2 invalid usage or configuration.
 */
import { z } from "zod";
import { MAX_ITEM_LIMIT, inspectPost, renderInspection } from "../analysis/inspect-results.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";

const USAGE = "Usage: inspect-post --post-id <slug> [--limit <n>] [--json]";
const EnvSchema = z.object({
  STEELE_PUBLICATION_ID: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
});

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  let postId: string | undefined;
  let limit: number | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === "--json") json = true;
    else if (argv[i] === "--post-id" && v && /^[a-z0-9][a-z0-9-]{0,299}$/.test(v)) {
      postId = v;
      i++;
    } else if (argv[i] === "--limit" && v && /^\d+$/.test(v) && +v >= 1 && +v <= MAX_ITEM_LIMIT) {
      limit = +v;
      i++;
    } else {
      console.error(USAGE);
      return 2;
    }
  }
  if (!postId) {
    console.error(USAGE);
    return 2;
  }
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`inspect-post: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const content = new GitArtifactStore({
    repoPath: env.data.STEELE_CONTENT_PATH,
    repository: env.data.STEELE_CONTENT_REPOSITORY,
  });
  let report;
  try {
    report = await inspectPost(
      content,
      { publicationId: env.data.STEELE_PUBLICATION_ID, postId },
      limit ? { limit } : {},
    );
  } catch {
    console.error("inspect-post: content repository unavailable");
    return 1;
  }
  console.log(json ? JSON.stringify(report) : renderInspection(report));
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
