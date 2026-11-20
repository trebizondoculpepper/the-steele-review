/**
 * Draft one article from a saved writer package (#149).
 *
 *   draft-package --package <writer-packages/... path> [--source-url <https url>] [--model <openrouter model id>] [--json]
 *
 * Uses the configured model (STEELE_MODEL via OpenRouter). Reads the pinned
 * source text from the archive, validates the model's draft against the
 * package, and saves it write-once under articles/. Rerunning with the same
 * package, model and prompt reuses the saved draft without a model call.
 * The writer never browses or publishes.
 *
 * Configuration (environment):
 *   STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY   private content repository
 *   STEELE_ARCHIVE_PATH, STEELE_ARCHIVE_REPOSITORY   source archive (read only)
 *   OPENROUTER_API_KEY[_FILE], STEELE_MODEL
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { openRouterFromEnv } from "../controllers/openrouter.js";
import { draftFromPackage } from "../drafting/package-draft.js";

const USAGE =
  "Usage: draft-package --package <writer-packages/... path> [--source-url <https url>] [--model <openrouter model id>] [--json]";
const Env = z.object({
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
  STEELE_ARCHIVE_PATH: z.string().min(1),
  STEELE_ARCHIVE_REPOSITORY: z.string().min(1),
});

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        package: { type: "string" },
        "source-url": { type: "string" },
        model: { type: "string" },
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
  const url = z
    .url({ protocol: /^https$/ })
    .optional()
    .safeParse(values["source-url"]);
  if (
    !values.package ||
    !/^writer-packages\/[A-Za-z0-9/._-]+\.json$/.test(values.package) ||
    !url.success
  ) {
    console.error(USAGE);
    return 2;
  }
  const env = Env.safeParse(process.env);
  if (!env.success) {
    console.error(
      `draft-package: invalid or missing configuration: ${[...new Set(env.error.issues.map((i) => i.path.join(".")))].join(", ")}`,
    );
    return 2;
  }
  // Any OpenRouter model ID may be requested; omission uses the configured default.
  const requested =
    values.model === undefined
      ? undefined
      : z
          .string()
          .regex(/^[A-Za-z0-9._:/-]{1,200}$/)
          .safeParse(values.model);
  if (requested && !requested.success) {
    console.error(USAGE);
    return 2;
  }
  let resolved: string | undefined;
  let provider;
  try {
    provider = openRouterFromEnv(
      requested?.success ? { env: { ...process.env, STEELE_MODEL: requested.data } } : {},
      { onUsage: (u) => (resolved = u.model) },
    );
  } catch {
    console.error("draft-package: model provider is not configured");
    return 2;
  }
  const c = env.data;
  const content = new GitArtifactStore({
    repoPath: c.STEELE_CONTENT_PATH,
    repository: c.STEELE_CONTENT_REPOSITORY,
  });
  const archive = new GitArtifactStore({
    repoPath: c.STEELE_ARCHIVE_PATH,
    repository: c.STEELE_ARCHIVE_REPOSITORY,
  });
  const pkg = await content.lookup(values.package);
  if (!pkg) {
    console.error(JSON.stringify({ event: "draft-package", outcome: "package-not-found" }));
    return 1;
  }
  const out = await draftFromPackage({
    content,
    archive,
    package: pkg,
    provider,
    ...(url.data ? { sourceUrl: url.data } : {}),
    ...(requested?.success ? { requestedModel: requested.data } : {}),
    resolvedModel: () => resolved,
  });
  const report =
    out.status === "drafted"
      ? {
          event: "draft-package",
          outcome: "drafted",
          reused: out.reused,
          draft: `${out.draft.commit.slice(0, 12)}:${out.draft.path}`,
          metadata: out.metadata.path,
        }
      : {
          event: "draft-package",
          // An unknown or unavailable requested model is reported, never swapped for another.
          outcome:
            out.status === "failed" && out.providerError === "bad-request"
              ? "model-unavailable"
              : out.status,
          ...(requested?.success ? { model: requested.data } : {}),
          ...("reason" in out ? { reason: out.reason } : {}),
          ...("problems" in out && out.problems ? { problems: out.problems } : {}),
        };
  console.log(
    values.json
      ? JSON.stringify(report)
      : out.status === "drafted"
        ? `Saved draft ${report.draft}${out.reused ? " (reused)" : ""}.`
        : `No draft: ${JSON.stringify(report)}`,
  );
  return out.status === "drafted" ? 0 : 1;
}

process.exitCode = await main();
