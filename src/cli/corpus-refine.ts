#!/usr/bin/env node
/**
 * corpus-refine (#830): submit a bounded synthetic Corpus Refinement batch
 * through Restate ingress and report the invocation identity.
 *
 *   corpus-refine --run-id <id> [--size <1..200>] [--wait] [--json]
 *
 * Environment: RESTATE_INGRESS_URL (required).
 * The same run ID always names the same run: a repeated submission attaches
 * to it and reports `already-submitted`, never a second run.
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  CorpusRefinementInputError,
  corpusRefinementSubmitter,
} from "../corpus-refinement/submission.js";

const USAGE = "Usage: corpus-refine --run-id <id> [--size <1..200>] [--wait] [--json]";

async function main(): Promise<number> {
  let values;
  try {
    values = parseArgs({
      options: {
        "run-id": { type: "string" },
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
  try {
    submission = await submitter.submit(values["run-id"], size.data);
  } catch (error) {
    if (error instanceof CorpusRefinementInputError) {
      console.error("corpus-refine: invalid run ID");
      return 2;
    }
    console.error(JSON.stringify({ event: "corpus-refine", outcome: "submission-failed" }));
    return 1;
  }
  const out: Record<string, unknown> = { event: "corpus-refine", ...submission };
  if (values.wait) {
    try {
      out.result = await submitter.attach(submission.runId);
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
