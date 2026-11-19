/**
 * Worker entry for the state inspection (#172, #173).
 *
 * The controller's inspection is synchronous SQLite, so it runs here rather
 * than on the diagnostic's main thread: a large or slow store must not block
 * other checks or outlive the deadline. The parent terminates this worker when
 * the deadline expires, so a reply only ever comes from a live inspection.
 *
 * The worker imports the controller instead of duplicating its read-only open,
 * keeping queries and the inspection boundary with their owner.
 */
import { parentPort, workerData } from "node:worker_threads";
import {
  OperationInspector,
  type OperationInspection,
  type OperationStatusCount,
} from "../controllers/operation-store.js";

export type StateProbeReply =
  | { status: "available"; counts: OperationStatusCount[] }
  | { status: "available"; operation: OperationInspection | null }
  | { status: "unavailable" };

export interface StateProbeRequest {
  path: string;
  /** Present for one-operation inspection; absent for pipeline counts. */
  key?: string;
}

function inspect(request: StateProbeRequest): StateProbeReply {
  const opened = OperationInspector.open(request.path);
  if (opened.status !== "available") return { status: "unavailable" };
  try {
    if (typeof request.key === "string") {
      return { status: "available", operation: opened.inspector.inspect(request.key) ?? null };
    }
    return { status: "available", counts: opened.inspector.statusCounts() };
  } catch {
    return { status: "unavailable" };
  } finally {
    opened.inspector.close();
  }
}

if (parentPort) {
  const request = workerData as StateProbeRequest | undefined;
  const reply: StateProbeReply =
    typeof request?.path === "string" ? inspect(request) : { status: "unavailable" };
  parentPort.postMessage(reply);
  parentPort.close();
}
