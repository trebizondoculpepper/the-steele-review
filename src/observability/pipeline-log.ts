import { createHash } from "node:crypto";
import { exportPipelineLog } from "../controllers/sentry-logs.js";
import { postCorrelationId } from "./post-correlation.js";

/** Call with stage names and outcome codes owned by the application. */
export function logPipeline(
  post: { publicationId: string; postId: string },
  stage: string,
  outcome: string,
  sourceVersion?: string,
  destination?: string,
): void {
  const attributes = {
    correlation_id: postCorrelationId(post),
    stage,
    outcome,
    ...(destination
      ? { destination_id: createHash("sha256").update(destination).digest("hex") }
      : {}),
    ...(/^sha256:[0-9a-f]{64}$/.test(sourceVersion ?? "") ? { revision: sourceVersion! } : {}),
  };
  console.log(JSON.stringify({ event: "article.pipeline", ...attributes }));
  exportPipelineLog(attributes);
}
