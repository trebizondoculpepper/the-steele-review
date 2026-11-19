/**
 * Worker entry for the state inspection (#172).
 *
 * The controller's inspection is synchronous SQLite, so it runs here rather
 * than on the diagnostic's main thread: a large or slow store must not block
 * the other checks or outlive the deadline. The parent terminates this worker
 * when the deadline expires, so the reply is only ever sent by a live check.
 *
 * The worker imports the controller instead of duplicating its read-only open,
 * keeping queries and the inspection boundary with their owner.
 */
import { parentPort, workerData } from "node:worker_threads";
import { OperationInspector, type OperationStatusCount } from "../controllers/operation-store.js";

export type StateProbeReply =
  | { status: "healthy"; counts: OperationStatusCount[] }
  | { status: "unavailable" };

export interface StateProbeRequest {
  path: string;
}

function inspect(path: string): StateProbeReply {
  const opened = OperationInspector.open(path);
  if (opened.status !== "available") return { status: "unavailable" };
  try {
    return { status: "healthy", counts: opened.inspector.statusCounts() };
  } catch {
    return { status: "unavailable" };
  } finally {
    opened.inspector.close();
  }
}

if (parentPort) {
  const request = workerData as StateProbeRequest | undefined;
  const reply: StateProbeReply =
    typeof request?.path === "string" ? inspect(request.path) : { status: "unavailable" };
  parentPort.postMessage(reply);
  parentPort.close();
}
