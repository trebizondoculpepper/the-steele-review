import * as clients from "@restatedev/restate-sdk-clients";
import { z } from "zod";
import { ArtifactRefSchema } from "./artifact-store.js";
import type { ArtifactReference } from "../content/artifact-reference.js";
import { artifactReference } from "../drafting/publication-payload.js";
import {
  EDITORIAL_CONTINUATION_WORKFLOW,
  type EditorialContinuationRunInput,
  EditorialContinuationResultSchema,
  safeContinuationReason,
} from "../content/editorial-continuation-contract.js";
import type { EditorialContinuationApi } from "../workflow/editorial-continuation.js";
export interface ParentCompletionPort {
  read(
    workflowKey: string,
  ): Promise<
    { state: "not-complete" } | { state: "completed"; outcome: string; summary?: ArtifactReference }
  >;
}
export class EditorialIngressError extends Error {
  constructor(readonly code: "unconfigured" | "unavailable" | "invalid-response" | "timeout") {
    super(`editorial ingress: ${code}`);
  }
}
const ParentResultSchema = z
  .object({
    outcome: z.enum(["verified", "rejected", "drafted-unverified", "evidence-gap", "failed"]),
    editorial: z.object({ summary: ArtifactRefSchema }).passthrough().optional(),
  })
  .passthrough();
/** Status-only SDK adapter. It never invokes ArticleRun.run or submits a missing parent. */
export function restateParentCompletion(
  url: string | undefined,
  connect: typeof clients.connect = clients.connect,
  timeoutMs = 10_000,
): ParentCompletionPort {
  if (!url || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    return {
      read: async () => {
        throw new EditorialIngressError("unconfigured");
      },
    };
  let ingress: ReturnType<typeof clients.connect>;
  try {
    validateIngressUrl(url);
    ingress = connect({ url });
  } catch {
    return {
      read: async () => {
        throw new EditorialIngressError("unconfigured");
      },
    };
  }
  return {
    async read(key) {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const parent = ingress.workflowClient<{
          run: (value: unknown) => Promise<unknown>;
          final: () => Promise<unknown>;
        }>({ name: "ArticleRun" }, key);
        let output: { ready: boolean; result?: unknown };
        try {
          output = await parent.workflowOutput(clients.rpc.opts({ signal }));
        } catch (error) {
          // A failed parent ends as a terminal failure in Restate (#825); its
          // saved final result is the completed outcome.
          let saved: unknown = null;
          try {
            saved = await parent.final(clients.rpc.opts({ signal }));
          } catch {
            saved = null;
          }
          if (!saved) throw error;
          output = { ready: true, result: saved };
        }
        if (!output.ready) return { state: "not-complete" };
        const parsed = ParentResultSchema.safeParse(output.result);
        if (!parsed.success) throw new EditorialIngressError("invalid-response");
        return {
          state: "completed",
          outcome: parsed.data.outcome,
          ...(parsed.data.editorial
            ? { summary: artifactReference(parsed.data.editorial.summary) }
            : {}),
        };
      } catch (error) {
        if (signal.aborted) throw new EditorialIngressError("timeout");
        if (error instanceof EditorialIngressError) throw error;
        if (error instanceof clients.HttpCallError && error.status === 404)
          return { state: "not-complete" };
        throw new EditorialIngressError("unavailable");
      }
    },
  };
}
export interface EditorialContinuationIngress {
  submit(
    key: string,
    input: EditorialContinuationRunInput,
  ): Promise<{ invocationId: string; repeated: boolean }>;
  attach(key: string, waitMs: number): Promise<unknown>;
}
/** Submission and attach stay behind the same external protocol boundary. */
export function restateEditorialContinuation(url: string): EditorialContinuationIngress {
  let ingress: ReturnType<typeof clients.connect>;
  try {
    validateIngressUrl(url);
    ingress = clients.connect({ url });
  } catch {
    throw new EditorialIngressError("unconfigured");
  }
  const client = (key: string) =>
    ingress.workflowClient<EditorialContinuationApi>(
      { name: EDITORIAL_CONTINUATION_WORKFLOW },
      key,
    );
  return {
    async submit(key, input) {
      const signal = AbortSignal.timeout(10_000);
      try {
        const out = await client(key).workflowSubmit(input, clients.rpc.sendOpts({ signal }));
        const parsed = z
          .object({
            invocationId: z.string().regex(/^inv_[A-Za-z0-9_-]{1,200}$/),
            status: z.enum(["Accepted", "PreviouslyAccepted"]),
          })
          .safeParse(out);
        if (!parsed.success) throw new EditorialIngressError("invalid-response");
        return {
          invocationId: parsed.data.invocationId,
          repeated: parsed.data.status === "PreviouslyAccepted",
        };
      } catch (error) {
        if (signal.aborted) throw new EditorialIngressError("timeout");
        if (error instanceof EditorialIngressError) throw error;
        throw new EditorialIngressError("unavailable");
      }
    },
    async attach(key, waitMs) {
      if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 3_600_000)
        throw new EditorialIngressError("unconfigured");
      const signal = AbortSignal.timeout(waitMs);
      try {
        const out = EditorialContinuationResultSchema.safeParse(
          await client(key).workflowAttach(clients.rpc.opts({ signal })),
        );
        if (!out.success) throw new EditorialIngressError("invalid-response");
        return {
          ...out.data,
          ...(out.data.reason ? { reason: safeContinuationReason(out.data.reason) } : {}),
        };
      } catch (error) {
        if (signal.aborted) throw new EditorialIngressError("timeout");
        if (error instanceof EditorialIngressError) throw error;
        throw new EditorialIngressError("unavailable");
      }
    },
  };
}

function validateIngressUrl(value: string) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new EditorialIngressError("unconfigured");
}
