import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { versions } from "./capture.js";
import { attempts } from "./writing.js";
import { DraftServiceClient } from "../../delivery/client.js";
import { buildRequest, DeliveryStop, deliverArticle } from "../../delivery/deliver.js";

/**
 * Delivery of one saved article through the shared draft service (#922).
 *
 * `deliver-article` {article} shows two steps: `build-request` (the exact
 * payload from the immutable article and its pinned source version, and its
 * hash) and `deliver` (bounded tries, reconciliation, readback and receipt).
 * It creates only unpublished, editable drafts with no email; there is no
 * publishing or announcement step.
 *
 * Delivery is refused unless STEELE_EXP_MASTRA_DELIVERY_ENABLED=1, because the
 * deployed draft service creates real (unpublished) Substack drafts.
 */

const env = process.env;
const client = () =>
  new DraftServiceClient(env.STEELE_EXP_MASTRA_DRAFT_SERVICE_URL ?? "http://127.0.0.1:4200", env.STEELE_EXP_MASTRA_DRAFT_TOKEN_FILE ?? "/run/draft-service/token");
const Any = z.record(z.string(), z.unknown());

const build = createStep({
  id: "build-request",
  description: "Build the delivery request from the immutable saved article and its pinned source version.",
  inputSchema: z.object({ article: z.string().max(300) }),
  outputSchema: Any,
  execute: async ({ inputData }) => {
    try {
      const { request, payloadSha256 } = await buildRequest(attempts, versions, inputData.article);
      const { bodyMarkdown, ...visible } = request;
      return { ...visible, bodyChars: bodyMarkdown.length, payloadSha256 };
    } catch (e) {
      throw new Error(e instanceof DeliveryStop ? `stopped: ${e.reason}` : String(e));
    }
  },
});

const deliver = createStep({
  id: "deliver",
  description: "Call the shared draft service; reconcile uncertain outcomes; record the receipt.",
  inputSchema: Any,
  outputSchema: Any,
  execute: async ({ inputData }) => {
    if (env.STEELE_EXP_MASTRA_DELIVERY_ENABLED !== "1") throw new Error("stopped: delivery-disabled");
    const out = await deliverArticle({ attempts, versions, client: client() }, String(inputData.article));
    if (out.status !== "created" && out.status !== "existing") throw new Error(`stopped: delivery-${out.status} (${out.tries} tries; request ${out.requestId})`);
    return out as unknown as Record<string, unknown>;
  },
});

export const deliverArticleWorkflow = createWorkflow({
  id: "deliver-article",
  description: "Deliver one saved article as an unpublished, no-email Substack draft through the shared draft service (#922).",
  inputSchema: z.object({ article: z.string().max(300) }),
  outputSchema: Any,
})
  .then(build)
  .then(deliver)
  .commit();

export const listDeliveriesWorkflow = createWorkflow({
  id: "list-deliveries",
  description: "Read-only: recent delivery outcomes, draft IDs and receipts (#922).",
  inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
  outputSchema: z.object({ deliveries: z.array(Any) }),
})
  .then(
    createStep({
      id: "list-deliveries",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      outputSchema: z.object({ deliveries: z.array(Any) }),
      execute: async ({ inputData }) => ({ deliveries: await attempts.deliveries(inputData.limit) }),
    }),
  )
  .commit();
