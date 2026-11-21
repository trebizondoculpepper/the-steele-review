import { postAttribution, sourceMetadataFromEnv } from "../content/source-metadata.js";
/**
 * Build the writer's evidence package from a saved librarian coverage record (#148).
 *
 *   writer-package --coverage <librarian/coverage/... path> [--comparison <comparisons/... path>]... [--json]
 *
 * Reads every pinned input by its exact version, saves the package write-once
 * under writer-packages/, and prints its reference for the writer (#149).
 * Rerunning with the same coverage record reuses the same package.
 *
 * Configuration (environment):
 *   STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY   private content repository
 *   STEELE_ARCHIVE_PATH?, STEELE_ARCHIVE_REPOSITORY? source archive, to verify the pinned post
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { PackageInputError, saveWriterPackage } from "../drafting/writer-package.js";

const USAGE =
  "Usage: writer-package --coverage <librarian/coverage/... path> [--comparison <comparisons/... path>]... [--json]";
const Env = z.object({
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
  STEELE_ARCHIVE_PATH: z.string().min(1).optional(),
  STEELE_ARCHIVE_REPOSITORY: z.string().min(1).optional(),
});

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        coverage: { type: "string" },
        comparison: { type: "string", multiple: true },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
      strict: true,
    }));
  } catch {
    console.error(USAGE);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!values.coverage || !/^librarian\/coverage\/[A-Za-z0-9/._-]+\.json$/.test(values.coverage)) {
    console.error(USAGE);
    return 2;
  }
  const env = Env.safeParse(process.env);
  if (!env.success) {
    console.error(
      `writer-package: invalid or missing configuration: ${[...new Set(env.error.issues.map((i) => i.path.join(".")))].join(", ")}`,
    );
    return 2;
  }
  const c = env.data;
  const content = new GitArtifactStore({
    repoPath: c.STEELE_CONTENT_PATH,
    repository: c.STEELE_CONTENT_REPOSITORY,
  });
  const archive =
    c.STEELE_ARCHIVE_PATH && c.STEELE_ARCHIVE_REPOSITORY
      ? new GitArtifactStore({
          repoPath: c.STEELE_ARCHIVE_PATH,
          repository: c.STEELE_ARCHIVE_REPOSITORY,
        })
      : undefined;
  const coverage = await content.lookup(values.coverage);
  if (!coverage) {
    console.error(JSON.stringify({ event: "writer-package", outcome: "coverage-not-found" }));
    return 1;
  }
  const comparisons = [];
  for (const path of values.comparison ?? []) {
    if (!/^comparisons\/[A-Za-z0-9/._-]+\.json$/.test(path)) {
      console.error(USAGE);
      return 2;
    }
    const found = await content.lookup(path);
    if (!found) {
      console.error(JSON.stringify({ event: "writer-package", outcome: "comparison-not-found" }));
      return 1;
    }
    comparisons.push(found);
  }
  try {
    const metadata = sourceMetadataFromEnv(process.env);
    const { package: pkg, ref } = await saveWriterPackage({
      resolveAuthor: (item) => postAttribution(metadata, item),
      content,
      ...(archive ? { archive } : {}),
      coverage,
      ...(comparisons.length > 0 ? { comparisons } : {}),
    });
    const out = {
      event: "writer-package",
      outcome: pkg.status,
      package: `${ref.commit.slice(0, 12)}:${ref.path}`,
      claims: pkg.claims.length,
      covered: pkg.claims.filter((x) => x.status === "covered").length,
      gaps: pkg.claims.filter((x) => x.status === "gap").length,
    };
    console.log(
      values.json
        ? JSON.stringify(out)
        : `Saved ${out.outcome} package ${out.package} (${out.covered} covered, ${out.gaps} gaps).`,
    );
    return pkg.status === "ready" ? 0 : 1;
  } catch (error) {
    const reason = error instanceof PackageInputError ? error.message : "failed";
    console.error(JSON.stringify({ event: "writer-package", outcome: "rejected", reason }));
    return 1;
  }
}

process.exitCode = await main();
