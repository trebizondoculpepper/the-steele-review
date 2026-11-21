/**
 * Hand-select one passage from saved research into a coverage record (#261).
 *
 *   select-saved-evidence --coverage <librarian/coverage/... path> --claim <claimRecordId>
 *       --job <research job id> --url <cited URL> --passage <verbatim text> --note <who/why>
 *
 * The passage must appear in the source snapshot that the finished job
 * archived for that URL. Saves a new coverage record write-once and prints its
 * reference; build the writer package from it with `writer-package`.
 * No model or network calls.
 *
 * Configuration (environment):
 *   STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY   private content repository
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { SavedEvidenceError, selectSavedEvidence } from "../research/saved-evidence.js";

const usage =
  "Usage: select-saved-evidence --coverage PATH --claim ID --job ID --url URL --passage TEXT --note TEXT";

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        coverage: { type: "string" },
        claim: { type: "string" },
        job: { type: "string" },
        url: { type: "string" },
        passage: { type: "string" },
        note: { type: "string" },
      },
    }));
  } catch {
    console.error(usage);
    return 2;
  }
  const args = z
    .object({
      coverage: z.string().min(1),
      claim: z.string().min(1),
      job: z.string().min(1),
      url: z.url(),
      passage: z.string().min(20),
      note: z.string().min(1),
    })
    .safeParse(values);
  const env = z
    .object({
      STEELE_CONTENT_PATH: z.string().min(1),
      STEELE_CONTENT_REPOSITORY: z.string().min(1),
    })
    .safeParse(process.env);
  if (!args.success || !env.success) {
    console.error(usage);
    return 2;
  }
  const content = new GitArtifactStore({
    repoPath: env.data.STEELE_CONTENT_PATH,
    repository: env.data.STEELE_CONTENT_REPOSITORY,
  });
  const coverage = await content.lookup(args.data.coverage);
  if (!coverage) {
    console.error("select-saved-evidence: coverage record not found");
    return 1;
  }
  try {
    const { ref } = await selectSavedEvidence({
      content,
      coverage,
      claimRecordId: args.data.claim,
      jobId: args.data.job,
      url: args.data.url,
      passage: args.data.passage,
      note: args.data.note,
    });
    console.log(JSON.stringify({ event: "select-saved-evidence", ok: true, coverage: ref }));
    return 0;
  } catch (error) {
    const reason = error instanceof SavedEvidenceError ? error.code : "failed";
    console.error(JSON.stringify({ event: "select-saved-evidence", ok: false, reason }));
    return 1;
  }
}

process.exitCode = await main();
