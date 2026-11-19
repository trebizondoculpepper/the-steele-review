/**
 * Manual command (#144): extract source-grounded claims for one post, link
 * them to the themes detected for it (#143), save the extraction and the
 * normalised claim records, and optionally index the occurrences.
 *
 *   extract-claims --post-id <slug>
 *
 * Run detect-themes for the post first, with the same STEELE_MODEL: claims
 * link to that exact theme-proposal result.
 *
 * Configuration (environment):
 *   STEELE_PUBLICATION_ID
 *   STEELE_ARCHIVE_PATH, STEELE_ARCHIVE_REPOSITORY   captured sources (read only)
 *   STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY   private content repository
 *   OPENROUTER_API_KEY[_FILE], STEELE_MODEL
 *   ELASTICSEARCH_URL[_FILE], ELASTICSEARCH_API_KEY[_FILE]?  optional: index occurrences
 *
 * Output is one JSON line with identities, counts and versions only.
 */
import { z } from "zod";
import {
  CLAIM_OCCURRENCE_INDEX_MAPPING,
  CLAIM_OCCURRENCE_INDEX_V1,
  CLAIM_OCCURRENCE_MAPPING_ADDITIONS,
} from "../analysis/claim-occurrence.js";
import { extractGroundedClaims } from "../analysis/grounded-claims.js";
import {
  DEFAULT_THEME_PROPOSAL_PROMPT,
  parseThemeProposalResult,
  themeProposalPath,
} from "../analysis/theme-proposals.js";
import { CollectionRecordSchema, collectionArtifactPath } from "../collection/collection-store.js";
import { describeSetupError, elasticsearchConnection } from "../config/credentials.js";
import { transcriptTimingsFor } from "../content/embedding-consumer.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { ElasticsearchController } from "../controllers/elasticsearch.js";
import { openRouterFromEnv, type ModelUsage } from "../controllers/openrouter.js";

const EnvSchema = z.object({
  STEELE_PUBLICATION_ID: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  STEELE_ARCHIVE_PATH: z.string().min(1),
  STEELE_ARCHIVE_REPOSITORY: z.string().min(1),
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
});
const USAGE = "Usage: extract-claims --post-id <slug>";

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
    console.error(`extract-claims: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const c = env.data;
  const usage: ModelUsage[] = [];
  let provider;
  let es: ElasticsearchController | undefined;
  try {
    provider = openRouterFromEnv({}, { onUsage: (u) => usage.push(u) });
    if (process.env.ELASTICSEARCH_URL || process.env.ELASTICSEARCH_URL_FILE) {
      const conn = elasticsearchConnection();
      es = new ElasticsearchController(conn.url, conn.apiKey);
      // Create the occurrence index if needed, then apply additive field upgrades.
      await es.provisionIndex(CLAIM_OCCURRENCE_INDEX_V1, CLAIM_OCCURRENCE_INDEX_MAPPING);
      await es.addMappingFields(CLAIM_OCCURRENCE_INDEX_V1, CLAIM_OCCURRENCE_MAPPING_ADDITIONS);
    }
  } catch (error) {
    await es?.close().catch(() => undefined);
    console.error(`extract-claims: ${describeSetupError(error)}`);
    return 2;
  }
  const post = { publicationId: c.STEELE_PUBLICATION_ID, postId: argv[1] };
  const report = (fields: Record<string, unknown>) =>
    console.log(JSON.stringify({ event: "claim-extraction", ...post, ...fields }));
  const archive = new GitArtifactStore({
    repoPath: c.STEELE_ARCHIVE_PATH,
    repository: c.STEELE_ARCHIVE_REPOSITORY,
  });
  const content = new GitArtifactStore({
    repoPath: c.STEELE_CONTENT_PATH,
    repository: c.STEELE_CONTENT_REPOSITORY,
  });
  try {
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
    const sourceVersion = sourceVersionFor(record.text);
    // Claims link to the exact saved theme-proposal result (#181).
    const themeRef = await content.lookup(
      themeProposalPath(
        post,
        sourceVersion,
        provider.modelVersion,
        DEFAULT_THEME_PROPOSAL_PROMPT.version,
      ),
    );
    if (!themeRef) {
      report({ outcome: "themes-not-proposed" });
      return 1;
    }
    const themeResult = parseThemeProposalResult(JSON.parse(await content.read(themeRef)));
    const themes = themeResult.proposals.map((p) => ({
      id: p.id,
      name: p.title,
      definition: p.description ?? p.title,
    }));
    const outcome = await extractGroundedClaims({
      provider,
      artifacts: content,
      ...(es ? { index: es } : {}),
      themes,
      themeResult: `${themeRef.commit}:${themeRef.path}`,
      source: {
        text: record.text,
        sourceVersion,
        artifact: {
          repository: ref.repository,
          commit: ref.commit,
          path: ref.path,
          hash: `sha256:${ref.sha256}`,
        },
        publicationId: post.publicationId,
        postId: post.postId,
        url: record.item.url,
        ...(record.item.publishedAt ? { publishedAt: record.item.publishedAt } : {}),
        // Supplied transcript timings, aligned the same way as for passages.
        ...transcriptTimingsFor(record),
      },
    });
    if (outcome.status === "failed") {
      report({ outcome: outcome.reason, attempts: outcome.attempts });
      return 1;
    }
    const kinds: Record<string, number> = {};
    for (const cl of outcome.record.claims) kinds[cl.kind] = (kinds[cl.kind] ?? 0) + 1;
    report({
      outcome: "extracted",
      reused: outcome.reused,
      claims: outcome.record.claims.length,
      kinds,
      unclassified: outcome.record.claims.filter((cl) => cl.classification === "unclassified")
        .length,
      rejected: outcome.record.rejected.length,
      claimRecords: outcome.claimRecords.length,
      indexed: outcome.indexed,
      modelVersion: outcome.record.extraction.modelVersion,
      promptVersion: outcome.record.extraction.promptVersion,
      usage,
    });
    return 0;
  } catch (error) {
    // Name the failure only: Git and search errors can carry paths or output.
    report({ outcome: "failed", error: error instanceof Error ? error.name : "error" });
    return 1;
  } finally {
    await es?.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
