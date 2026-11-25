import * as clients from "@restatedev/restate-sdk-clients";
import {
  CorpusRefinementInputSchema,
  syntheticBatch,
  type CorpusRefinementInput,
  type CorpusRefinementResult,
} from "./contracts.js";
import type { CorpusRefinementApi } from "./workflow.js";

/**
 * The shared submission contract for Corpus Refinement (#831), used by both
 * the CLI and the dashboard: submit a bounded fixture batch under a stable run
 * ID. A repeated submission of the same run ID attaches to the existing
 * invocation and never starts a second run.
 */
export interface CorpusRefinementSubmission {
  runId: string;
  invocationId: string;
  submitted: "started" | "already-submitted";
}

export class CorpusRefinementInputError extends Error {
  constructor() {
    super("corpus-refinement: invalid run ID or batch size");
    this.name = "CorpusRefinementInputError";
  }
}

export interface CorpusRefinementSubmitter {
  submit(runId: string, size: number): Promise<CorpusRefinementSubmission>;
  /** Submits a prepared, validated input (the archive experiment, #832). */
  submitInput(input: CorpusRefinementInput): Promise<CorpusRefinementSubmission>;
  /** Waits for one run's result (the CLI's --wait). */
  attach(runId: string): Promise<CorpusRefinementResult>;
}

export function corpusRefinementSubmitter(ingressUrl: string): CorpusRefinementSubmitter {
  const ingress = clients.connect({ url: ingressUrl });
  const client = (runId: string) =>
    ingress.workflowClient<CorpusRefinementApi>({ name: "CorpusRefinement" }, runId);
  return {
    attach: (runId) => client(runId).workflowAttach(),
    async submit(runId, size) {
      if (!Number.isInteger(size) || size < 1 || size > 200) throw new CorpusRefinementInputError();
      return this.submitInput(syntheticBatch(runId, size));
    },
    async submitInput(raw) {
      const input = CorpusRefinementInputSchema.safeParse(raw);
      if (!input.success) throw new CorpusRefinementInputError();
      const sent = await client(input.data.runId).workflowSubmit(input.data);
      return {
        runId: input.data.runId,
        invocationId: sent.invocationId,
        submitted: sent.status === "PreviouslyAccepted" ? "already-submitted" : "started",
      };
    },
  };
}
