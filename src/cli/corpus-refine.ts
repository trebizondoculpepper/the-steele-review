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
import * as clients from "@restatedev/restate-sdk-clients";
import { z } from "zod";
import { CorpusRefinementInputSchema, syntheticBatch } from "../corpus-refinement/contracts.js";
import type { CorpusRefinementApi } from "../corpus-refinement/workflow.js";

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
  const input = CorpusRefinementInputSchema.safeParse(syntheticBatch(values["run-id"], size.data));
  if (!input.success) {
    console.error("corpus-refine: invalid run ID");
    return 2;
  }
  const wf = clients
    .connect({ url: url.data })
    .workflowClient<CorpusRefinementApi>({ name: "CorpusRefinement" }, input.data.runId);
  let submission;
  try {
    submission = await wf.workflowSubmit(input.data);
  } catch {
    console.error(JSON.stringify({ event: "corpus-refine", outcome: "submission-failed" }));
    return 1;
  }
  const out: Record<string, unknown> = {
    event: "corpus-refine",
    runId: input.data.runId,
    invocationId: submission.invocationId,
    submitted: submission.status === "PreviouslyAccepted" ? "already-submitted" : "started",
  };
  if (values.wait) {
    try {
      out.result = await wf.workflowAttach();
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
