/**
 * Verify a package draft against its exact evidence package (#150).
 *
 *   verify-package-draft --metadata <articles/.../<key>.json> --source-url <https url> [--revise] [--json]
 *
 * Checks the exact saved draft against the exact package and pinned source.
 * Without --revise it saves one report (approved or redraft with passages
 * and reasons). With --revise it redrafts with the verifier's feedback up to
 * the existing limit (two) and saves an unresolved result if it still fails.
 * Approval applies only to the exact draft text it names. Nothing is published.
 *
 * Configuration (environment):
 *   STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY, STEELE_ARCHIVE_PATH, STEELE_ARCHIVE_REPOSITORY
 *   OPENROUTER_API_KEY[_FILE], STEELE_MODEL; STEELE_MODEL_VERIFIER?, STEELE_MODEL_WRITER? overrides
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { openRouterFromEnv } from "../controllers/openrouter.js";
import { PackageDraftMetadataSchema } from "../drafting/package-draft.js";
import { verifyPackageDraft, verifyWithRevisions } from "../drafting/package-verify.js";

const USAGE =
  "Usage: verify-package-draft --metadata <articles/.../<key>.json> --source-url <https url> [--revise] [--json]";
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
        metadata: { type: "string" },
        "source-url": { type: "string" },
        revise: { type: "boolean" },
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
  const url = z.url({ protocol: /^https$/ }).safeParse(values["source-url"]);
  if (
    !values.metadata ||
    !/^articles\/[A-Za-z0-9/._-]+\.json$/.test(values.metadata) ||
    !url.success
  ) {
    console.error(USAGE);
    return 2;
  }
  const env = Env.safeParse(process.env);
  if (!env.success) {
    console.error("verify-package-draft: content and archive repositories must be configured");
    return 2;
  }
  const model = (override: string) =>
    openRouterFromEnv({
      env: {
        ...process.env,
        ...(process.env[override] ? { STEELE_MODEL: process.env[override] } : {}),
      },
    });
  let verifier, writer;
  try {
    verifier = model("STEELE_MODEL_VERIFIER");
    // The writer is needed only to redraft.
    if (values.revise) writer = model("STEELE_MODEL_WRITER");
  } catch {
    console.error("verify-package-draft: model provider is not configured");
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
  const metadata = await content.lookup(values.metadata);
  if (!metadata) {
    console.error(JSON.stringify({ event: "verify-package-draft", outcome: "draft-not-found" }));
    return 1;
  }
  let report: Record<string, unknown>;
  let ok: boolean;
  if (values.revise) {
    const meta = PackageDraftMetadataSchema.parse(JSON.parse(await content.read(metadata)));
    const pkg = {
      repository: meta.package.repository,
      commit: meta.package.commit,
      path: meta.package.path,
      sha256: meta.package.hash.replace(/^sha256:/, ""),
    };
    const out = await verifyWithRevisions({
      content,
      archive,
      package: pkg,
      metadata,
      writer: writer!,
      verifier,
      sourceUrl: url.data,
    });
    ok = out.outcome === "approved";
    report =
      out.outcome === "failed"
        ? { outcome: "failed", reason: out.reason, revisions: out.revisions }
        : {
            outcome: out.outcome,
            revisions: out.revisions,
            draft: out.draft.path,
            report: out.report.path,
            ...(out.outcome === "unresolved" ? { issues: out.issues.length } : {}),
          };
  } else {
    const out = await verifyPackageDraft({ content, archive, metadata, verifier });
    ok = out.status === "verified" && out.report.outcome === "approved";
    report =
      out.status === "verified"
        ? {
            outcome: out.report.outcome,
            report: out.ref.path,
            issues: out.report.issues.map((i) => ({ severity: i.severity, reason: i.reason })),
          }
        : { outcome: out.status, reason: out.reason };
  }
  console.log(
    values.json
      ? JSON.stringify({ event: "verify-package-draft", ...report })
      : JSON.stringify(report, null, 2),
  );
  return ok ? 0 : 1;
}

process.exitCode = await main();
