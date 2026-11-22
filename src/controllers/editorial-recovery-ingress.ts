import * as clients from "@restatedev/restate-sdk-clients";
import { z } from "zod";
import { EditorialContinuationResultSchema } from "../content/editorial-continuation-contract.js";
import {
  EDITORIAL_JUDGE_RECOVERY_WORKFLOW,
  JudgeRecoveryResultSchema,
  safeJudgeRecoveryReason,
  type JudgeRecoveryResult,
  type JudgeRecoveryRunInput,
} from "../content/editorial-judge-recovery-contract.js";
import { EditorialIngressError } from "./editorial-continuation-ingress.js";
type EditorialContinuationResult = z.infer<typeof EditorialContinuationResultSchema>;
import type { EditorialJudgeRecoveryApi } from "../workflow/editorial-judge-recovery.js";
export interface RecoveryParentCompletionPort {
  read(
    key: string,
  ): Promise<
    { state: "not-complete" } | { state: "completed"; result: EditorialContinuationResult }
  >;
}
const urlValid = (value: string) => {
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new EditorialIngressError("unconfigured");
};
export function restateRecoveryParentCompletion(
  url: string | undefined,
  connect: typeof clients.connect = clients.connect,
  timeoutMs = 10000,
): RecoveryParentCompletionPort {
  let ingress: ReturnType<typeof clients.connect>;
  try {
    if (!url || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
      throw new Error();
    urlValid(url);
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
        const output = await ingress
          .workflowClient<{ run: (input: unknown) => Promise<unknown> }>(
            { name: "EditorialContinuation" },
            key,
          )
          .workflowOutput(clients.rpc.opts({ signal }));
        if (!output.ready) return { state: "not-complete" };
        const result = EditorialContinuationResultSchema.safeParse(output.result);
        if (!result.success) throw new EditorialIngressError("invalid-response");
        return { state: "completed", result: result.data };
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
export interface JudgeRecoveryIngress {
  submit(
    key: string,
    input: JudgeRecoveryRunInput,
  ): Promise<{ invocationId: string; repeated: boolean }>;
  attach(key: string, waitMs: number): Promise<JudgeRecoveryResult>;
}
export interface JudgeRecoveryCompletionPort {
  read(
    key: string,
  ): Promise<{ state: "not-complete" } | { state: "completed"; result: JudgeRecoveryResult }>;
}
/** Status only: never invokes run or submits an absent workflow. */
export function restateJudgeRecoveryCompletion(
  url: string,
  connect: typeof clients.connect = clients.connect,
  timeoutMs = 10000,
): JudgeRecoveryCompletionPort {
  let ingress: ReturnType<typeof clients.connect>;
  try {
    urlValid(url);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error();
    ingress = connect({ url });
  } catch {
    throw new EditorialIngressError("unconfigured");
  }
  return {
    async read(key) {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const output = await ingress
          .workflowClient<EditorialJudgeRecoveryApi>(
            { name: EDITORIAL_JUDGE_RECOVERY_WORKFLOW },
            key,
          )
          .workflowOutput(clients.rpc.opts({ signal }));
        if (!output.ready) return { state: "not-complete" };
        const parsed = JudgeRecoveryResultSchema.safeParse(output.result);
        if (!parsed.success) throw new EditorialIngressError("invalid-response");
        return { state: "completed", result: parsed.data };
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
export function restateJudgeRecovery(url: string): JudgeRecoveryIngress {
  let ingress: ReturnType<typeof clients.connect>;
  try {
    urlValid(url);
    ingress = clients.connect({ url });
  } catch {
    throw new EditorialIngressError("unconfigured");
  }
  const client = (key: string) =>
    ingress.workflowClient<EditorialJudgeRecoveryApi>(
      { name: EDITORIAL_JUDGE_RECOVERY_WORKFLOW },
      key,
    );
  return {
    async submit(key, input) {
      const signal = AbortSignal.timeout(10000);
      try {
        const raw = await client(key).workflowSubmit(input, clients.rpc.sendOpts({ signal }));
        const value = z
          .object({
            invocationId: z.string().regex(/^inv_[A-Za-z0-9_-]{1,200}$/),
            status: z.enum(["Accepted", "PreviouslyAccepted"]),
          })
          .safeParse(raw);
        if (!value.success) throw new EditorialIngressError("invalid-response");
        return {
          invocationId: value.data.invocationId,
          repeated: value.data.status === "PreviouslyAccepted",
        };
      } catch (error) {
        if (signal.aborted) throw new EditorialIngressError("timeout");
        if (error instanceof EditorialIngressError) throw error;
        throw new EditorialIngressError("unavailable");
      }
    },
    async attach(key, waitMs) {
      if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 3600000)
        throw new EditorialIngressError("unconfigured");
      const signal = AbortSignal.timeout(waitMs);
      try {
        const value = JudgeRecoveryResultSchema.safeParse(
          await client(key).workflowAttach(clients.rpc.opts({ signal })),
        );
        if (!value.success) throw new EditorialIngressError("invalid-response");
        return {
          ...value.data,
          ...(value.data.reason ? { reason: safeJudgeRecoveryReason(value.data.reason) } : {}),
        };
      } catch (error) {
        if (signal.aborted) throw new EditorialIngressError("timeout");
        if (error instanceof EditorialIngressError) throw error;
        throw new EditorialIngressError("unavailable");
      }
    },
  };
}
