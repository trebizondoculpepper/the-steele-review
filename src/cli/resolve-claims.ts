/**
 * Manual command (#145): for one post's extracted claims, find equivalent
 * earlier claims and merge only confident, validated matches.
 *
 *   resolve-claims --post-id <slug>
 *
 * Run after extract-claims. Configuration (environment):
 *   STEELE_PUBLICATION_ID
 *   STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY
 *   OPENROUTER_API_KEY[_FILE], STEELE_MODEL
 *
 * Output is one JSON line with counts, IDs and versions only.
 */
import { z } from "zod";
import { resolveClaimEquivalence } from "../analysis/claim-equivalence.js";
import { ClaimExtractionRecordSchema } from "../analysis/grounded-claims.js";
import { describeSetupError } from "../config/credentials.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { openRouterFromEnv, type ModelUsage } from "../controllers/openrouter.js";

const EnvSchema = z.object({
  STEELE_PUBLICATION_ID: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
});
const USAGE = "Usage: resolve-claims --post-id <slug>";

async function main(argv: string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(USAGE);
    return 0;
  }
  if (argv.length !== 2 || argv[0] !== "--post-id" || !/^[a-z0-9][a-z0-9-]{0,299}$/.test(argv[1])) {
    console.error(USAGE);
    return 2;
  }
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`resolve-claims: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const c = env.data;
  const usage: ModelUsage[] = [];
  let provider;
  try {
    provider = openRouterFromEnv({}, { onUsage: (u) => usage.push(u) });
  } catch (error) {
    console.error(`resolve-claims: ${describeSetupError(error)}`);
    return 2;
  }
  const post = { publicationId: c.STEELE_PUBLICATION_ID, postId: argv[1] };
  const report = (fields: Record<string, unknown>) =>
    console.log(JSON.stringify({ event: "claim-equivalence", ...post, ...fields }));
  const content = new GitArtifactStore({
    repoPath: c.STEELE_CONTENT_PATH,
    repository: c.STEELE_CONTENT_REPOSITORY,
  });
  try {
    const paths = await content.list(`claim-extractions/${post.publicationId}/${post.postId}`, 100);
    const ids = new Set<string>();
    for (const path of paths) {
      const ref = await content.lookup(path);
      if (!ref) continue;
      const rec = ClaimExtractionRecordSchema.parse(JSON.parse(await content.read(ref)));
      for (const cl of rec.claims) if (cl.claimRecordId) ids.add(cl.claimRecordId);
    }
    if (ids.size === 0) {
      report({ outcome: "no-claims" });
      return 1;
    }
    const counts: Record<string, number> = {};
    const merges: Array<{ record: string; canonical: string }> = [];
    for (const id of ids) {
      const out = await resolveClaimEquivalence({ provider, artifacts: content, recordId: id });
      counts[out.status] = (counts[out.status] ?? 0) + 1;
      if (out.status === "merged") merges.push({ record: out.record, canonical: out.canonical });
    }
    report({
      outcome: "resolved",
      claims: ids.size,
      counts,
      merges,
      modelVersion: provider.modelVersion,
      usage,
    });
    return 0;
  } catch (error) {
    report({ outcome: "failed", error: error instanceof Error ? error.name : "error" });
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
