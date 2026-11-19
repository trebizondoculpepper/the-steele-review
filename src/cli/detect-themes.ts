/**
 * Manual command (#143, revised by #181): propose themes for one captured post
 * and save the per-post proposal result in the private content repository.
 *
 *   detect-themes --post-id <slug>
 *
 * Extraction never writes canonical catalogue identities. If a catalogue
 * exists in the content repository it is read as optional context only.
 *
 * Configuration (environment):
 *   STEELE_PUBLICATION_ID
 *   STEELE_ARCHIVE_PATH, STEELE_ARCHIVE_REPOSITORY   captured sources (read only)
 *   STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY   private content repository
 *   OPENROUTER_API_KEY[_FILE], STEELE_MODEL
 *
 * Output is one JSON line: identities, counts, versions and usage only.
 */
import { z } from "zod";
import { ThemeCatalogueStore } from "../analysis/theme-catalogue.js";
import { proposeThemes } from "../analysis/theme-proposals.js";
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
const USAGE = "Usage: detect-themes --post-id <slug>";

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
  const post = { publicationId: c.STEELE_PUBLICATION_ID, postId: argv[1] };
  const report = (fields: Record<string, unknown>) =>
    console.log(JSON.stringify({ event: "theme-proposals", ...post, ...fields }));
  const archive = new GitArtifactStore({
    repoPath: c.STEELE_ARCHIVE_PATH,
    repository: c.STEELE_ARCHIVE_REPOSITORY,
  });
  const content = new GitArtifactStore({
    repoPath: c.STEELE_CONTENT_PATH,
    repository: c.STEELE_CONTENT_REPOSITORY,
  });
  try {
    await content.initialise();
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
    // Optional read-only context; never written by extraction.
    const known = await new ThemeCatalogueStore(content).load();
    const outcome = await proposeThemes({
      provider,
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
      ...(known.ref
        ? {
            catalogue: {
              themes: known.catalogue.themes,
              version: `${known.ref.commit}:${known.ref.sha256}`,
            },
          }
        : {}),
    });
    if (outcome.status === "failed") {
      report({ outcome: outcome.reason, attempts: outcome.attempts });
      return 1;
    }
    report({
      outcome: "proposed",
      reused: outcome.reused,
      proposals: outcome.result.proposals.length,
      rejected: outcome.result.rejected.length,
      result: `${outcome.ref.commit.slice(0, 12)}:${outcome.ref.path}`,
      modelVersion: outcome.result.extraction.modelVersion,
      promptVersion: outcome.result.extraction.promptVersion,
      usage,
    });
    return 0;
  } catch (error) {
    report({ outcome: "failed", error: error instanceof Error ? error.name : "error" });
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
