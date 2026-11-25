#!/usr/bin/env node
/**
 * corpus-refine (#830): submit a bounded synthetic Corpus Refinement batch
 * through Restate ingress and report the invocation identity.
 *
 *   corpus-refine --run-id <id> [--size <1..200>] [--wait] [--json]
 *   corpus-refine --run-id <id> --mode archive --posts <pub/post,...>
 *                 [--max-claims <n>] [--max-chars <n>] [--wait] [--json]
 *
 * Archive mode (#832) builds one reproducible batch of archived claims,
 * read-only, from STEELE_CONTENT_PATH / STEELE_CONTENT_REPOSITORY, and runs
 * both mappings on the configured model. Fixture mode makes no model calls.
 *
 * Environment: RESTATE_INGRESS_URL (required).
 * The same run ID always names the same run: a repeated submission attaches
 * to it and reports `already-submitted`, never a second run.
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { buildArchiveBatch } from "../corpus-refinement/archive-batch.js";
import {
  CorpusRefinementInputError,
  corpusRefinementSubmitter,
} from "../corpus-refinement/submission.js";

const USAGE =
  "Usage: corpus-refine --run-id <id> [--size <1..200>] | --mode archive --posts <pub/post,...> [--max-claims <n>] [--max-chars <n>] [--wait] [--json]";

async function main(): Promise<number> {
  let values;
  try {
    values = parseArgs({
      options: {
        "run-id": { type: "string" },
        mode: { type: "string" },
        posts: { type: "string" },
        "max-claims": { type: "string" },
        "max-chars": { type: "string" },
        size: { type: "string" },
        wait: { type: "boolean" },
        json: { type: "boolean" },
      },
    }).values;
  } catch {
    console.error(USAGE);
    return 2;
  }
  const size = z.coerce.number().int().min(1).max(200).default(5).safeParse(values.size);
  const url = z.url({ protocol: /^https?$/ }).safeParse(process.env.RESTATE_INGRESS_URL);
  if (!size.success || !url.success || !values["run-id"]) {
    console.error(USAGE);
    return 2;
  }
  // The same submission contract as the dashboard action (#831).
  const submitter = corpusRefinementSubmitter(url.data);
  let submission;
  const out: Record<string, unknown> = { event: "corpus-refine" };
  try {
    if (values.mode === "archive") {
      const posts = (values.posts ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const maxClaims = z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .default(40)
        .safeParse(values["max-claims"]);
      const maxChars = z.coerce
        .number()
        .int()
        .min(1000)
        .max(200_000)
        .default(24_000)
        .safeParse(values["max-chars"]);
      if (
        !posts.length ||
        !maxClaims.success ||
        !maxChars.success ||
        !process.env.STEELE_CONTENT_PATH
      ) {
        console.error(USAGE);
        return 2;
      }
      const content = new GitArtifactStore({
        repoPath: process.env.STEELE_CONTENT_PATH,
        repository: process.env.STEELE_CONTENT_REPOSITORY ?? "steele-content",
      });
      const batch = await buildArchiveBatch(content, {
        runId: values["run-id"],
        posts,
        maxClaims: maxClaims.data,
        maxChars: maxChars.data,
      });
      out.batch = {
        included: batch.input.claims.length,
        covered: batch.input.claims.filter((c) => c.covered).length,
        deferred: batch.input.deferred?.length ?? 0,
        sources: batch.sources,
        missing: batch.missing,
      };
      submission = await submitter.submitInput(batch.input);
    } else {
      submission = await submitter.submit(values["run-id"], size.data);
    }
  } catch (error) {
    if (error instanceof CorpusRefinementInputError) {
      console.error("corpus-refine: invalid run ID");
      return 2;
    }
    console.error(JSON.stringify({ event: "corpus-refine", outcome: "submission-failed" }));
    return 1;
  }
  Object.assign(out, submission);
  if (values.wait) {
    const started = Date.now();
    try {
      out.result = await submitter.attach(submission.runId);
      out.elapsedMs = Date.now() - started;
    } catch {
      // A failed run or a lost connection: report it without raw client errors.
      console.error(JSON.stringify({ ...out, outcome: "failed-or-unavailable" }));
      return 1;
    }
  }
  console.log(
    values.json || values.wait
      ? JSON.stringify(out)
      : `Corpus refinement ${out.runId}: ${out.submitted} (${out.invocationId}).`,
  );
  return 0;
}

process.exitCode = await main();
