/**
 * Manual command (#143): detect themes for one captured post against the
 * known-theme catalogue, persist the detection, and register new themes.
 *
 *   detect-themes --post-id <slug> [--seed-file <catalogue-seed.json>]
 *
 * A seed file is a JSON array of {name, definition, aliases?}; seeding is
 * idempotent and happens before detection.
 *
 * Configuration (environment):
 *   STEELE_PUBLICATION_ID                       publication of the post
 *   STEELE_ARCHIVE_PATH, STEELE_ARCHIVE_REPOSITORY   captured-source archive (read only)
 *   STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY   private content repository
 *   OPENROUTER_API_KEY[_FILE], STEELE_MODEL     model provider
 *
 * Output is one JSON line: post identity, theme IDs, counts and versions.
 * No source text, prompts or credentials are printed. No event is emitted
 * and no downstream consumer is triggered.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ThemeCatalogueStore, detectThemes } from "../analysis/theme-catalogue.js";
import { CollectionRecordSchema, collectionArtifactPath } from "../collection/collection-store.js";
import { describeSetupError } from "../config/credentials.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { openRouterFromEnv, type ModelUsage } from "../controllers/openrouter.js";

const EnvSchema = z.object({
  STEELE_PUBLICATION_ID: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  STEELE_ARCHIVE_PATH: z.string().min(1),
  STEELE_ARCHIVE_REPOSITORY: z.string().min(1),
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
});

const SeedSchema = z
  .array(
    z
      .object({
        name: z.string().trim().min(1).max(120),
        definition: z.string().trim().min(1).max(2000),
        aliases: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
      })
      .strict(),
  )
  .max(500);

const USAGE = "Usage: detect-themes --post-id <slug> [--seed-file <path>]";

function parseArgs(argv: string[]): { postId: string; seedFile?: string } {
  let postId: string | undefined;
  let seedFile: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (!value) throw new Error(USAGE);
    if (argv[i] === "--post-id") postId = value;
    else if (argv[i] === "--seed-file") seedFile = value;
    else throw new Error(USAGE);
  }
  if (!postId || !/^[a-z0-9][a-z0-9-]{0,299}$/.test(postId)) throw new Error(USAGE);
  return { postId, ...(seedFile ? { seedFile } : {}) };
}

async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch {
    console.error(USAGE);
    return 2;
  }
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`detect-themes: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const c = env.data;
  const usage: ModelUsage[] = [];
  let provider;
  try {
    provider = openRouterFromEnv({}, { onUsage: (u) => usage.push(u) });
  } catch (error) {
    console.error(`detect-themes: ${describeSetupError(error)}`);
    return 2;
  }
  const archive = new GitArtifactStore({
    repoPath: c.STEELE_ARCHIVE_PATH,
    repository: c.STEELE_ARCHIVE_REPOSITORY,
  });
  const content = new GitArtifactStore({
    repoPath: c.STEELE_CONTENT_PATH,
    repository: c.STEELE_CONTENT_REPOSITORY,
  });
  await content.initialise();
  const catalogue = new ThemeCatalogueStore(content);
  const post = { publicationId: c.STEELE_PUBLICATION_ID, postId: args.postId };
  const report = (fields: Record<string, unknown>) =>
    console.log(JSON.stringify({ event: "theme-detection", ...post, ...fields }));

  if (args.seedFile) {
    let seed;
    try {
      seed = SeedSchema.parse(JSON.parse(readFileSync(args.seedFile, "utf8")));
    } catch {
      console.error("detect-themes: seed file is unreadable or invalid");
      return 2;
    }
    await catalogue.register(seed.map((s) => ({ ...s, origin: "seed" as const })));
  }

  const ref = await archive.lookup(collectionArtifactPath(post));
  if (!ref) {
    report({ outcome: "source-not-found" });
    return 1;
  }
  const record = CollectionRecordSchema.parse(JSON.parse(await archive.read(ref)));
  if (!record.complete) {
    report({ outcome: "incomplete-source" });
    return 1;
  }
  const outcome = await detectThemes({
    provider,
    catalogue,
    artifacts: content,
    post,
    source: {
      text: record.text,
      sourceVersion: sourceVersionFor(record.text),
      artifact: {
        repository: ref.repository,
        commit: ref.commit,
        path: ref.path,
        hash: `sha256:${ref.sha256}`,
      },
    },
  });
  if (outcome.status === "failed") {
    report({ outcome: outcome.reason, attempts: outcome.attempts });
    return 1;
  }
  report({
    outcome: "detected",
    reused: outcome.reused,
    themeIds: outcome.themeIds,
    existing: outcome.detection.existing.length,
    proposed: outcome.detection.proposed.length,
    rejected: outcome.detection.rejected.length,
    detection: `${outcome.detectionRef.commit.slice(0, 12)}:${outcome.detectionRef.path}`,
    modelVersion: outcome.detection.extraction.modelVersion,
    promptVersion: outcome.detection.extraction.promptVersion,
    usage,
  });
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
