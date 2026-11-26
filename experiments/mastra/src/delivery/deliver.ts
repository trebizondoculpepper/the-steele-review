import { createHash } from "node:crypto";
import type { VersionStore } from "../capture/store.js";
import type { AttemptStore } from "../writing/store.js";
import { DraftServiceUnreachable, type DraftRequest, type DraftResponse, type DraftServiceClient } from "./client.js";

/**
 * Delivery of one saved article to the shared draft service (#922).
 *
 * - The request is built only from the immutable saved article and its
 *   pinned source version. The request ID is `exp-911:mastra:<attempt>`, so
 *   every retry of the same attempt sends the same ID and identical payload.
 *   A fresh attempt is a new ID and, deliberately, a new labelled draft.
 * - Bounded retries for eligible outcomes only. `uncertain` and unreachable
 *   outcomes are reconciled through the service, never by sending a fresh
 *   create. A `conflict`, `invalid` or `forbidden` response is never retried.
 * - The outcome and receipt are recorded durably with the attempt.
 */

export const MAX_DELIVERY_TRIES = 3;

export class DeliveryStop extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export async function buildRequest(attempts: AttemptStore, versions: VersionStore, articleId: string): Promise<{ request: DraftRequest; payloadSha256: string }> {
  const a = await attempts.article(articleId);
  if (!a) throw new DeliveryStop("article-not-found");
  const v = await versions.read(a.sourceVersion);
  const label = `[exp-911 mastra ${a.attempt}] `;
  const request: DraftRequest = {
    requestId: `exp-911:mastra:${a.attempt}`,
    experiment: "exp-911",
    platform: "mastra",
    attempt: a.attempt,
    title: `${label}${a.title}`.slice(0, 280),
    ...(a.subtitle ? { subtitle: a.subtitle.slice(0, 300) } : {}),
    bodyMarkdown: a.markdown,
    source: { item: v.bundle.item, version: v.version, url: v.bundle.url },
    article: a.articleId,
  };
  return { request, payloadSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex") };
}

const SETTLED_OK = new Set(["created", "existing"]);
const NEVER_RETRY = new Set(["conflict", "invalid", "forbidden", "not-found", "unauthorised"]);

export interface DeliveryOutcome {
  requestId: string;
  status: string;
  draftId: string | null;
  receiptId: string | null;
  editorUrl: string | null;
  readback: DraftResponse["readback"] | null;
  tries: number;
  history: { try: number; action: "deliver" | "reconcile"; status: string; httpStatus: number | null }[];
}

export async function deliverArticle(
  deps: { attempts: AttemptStore; versions: VersionStore; client: DraftServiceClient; sleep?: (ms: number) => Promise<void> },
  articleId: string,
): Promise<DeliveryOutcome> {
  const { request } = await buildRequest(deps.attempts, deps.versions, articleId);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const history: DeliveryOutcome["history"] = [];
  let last: DraftResponse | undefined;
  let mustReconcile = false;
  // True once a create may have reached the destination without a settled answer.
  let maybeCreated = false;
  for (let i = 1; i <= MAX_DELIVERY_TRIES; i++) {
    const action: "deliver" | "reconcile" = mustReconcile ? "reconcile" : "deliver";
    try {
      last = action === "reconcile" ? await deps.client.reconcile(request.requestId) : await deps.client.deliver(request);
    } catch (e) {
      if (!(e instanceof DraftServiceUnreachable)) throw e;
      history.push({ try: i, action, status: "unreachable", httpStatus: null });
      last = undefined;
      maybeCreated = true;
      // The request may have reached the service: reconcile before anything else.
      mustReconcile = true;
      await sleep(500 * i);
      continue;
    }
    history.push({ try: i, action, status: last.status, httpStatus: last.httpStatus });
    // Checked before the terminal statuses: the service never recorded the request, so a create is safe.
    if (action === "reconcile" && last.status === "not-found") {
      mustReconcile = false;
      maybeCreated = false;
      continue;
    }
    if (SETTLED_OK.has(last.status) || NEVER_RETRY.has(last.status)) break;
    if (last.status === "uncertain") maybeCreated = true;
    if (last.status === "failed") maybeCreated = false;
    // uncertain: reconcile; failed (definitely not created): a same-ID retry may create.
    mustReconcile = last.status === "uncertain";
    await sleep(500 * i);
  }
  // Success requires explicit readback evidence: the expected title, unpublished, no email.
  const verified = (r: DraftResponse | undefined) => Boolean(r?.readback && r.readback.titleMatches && !r.readback.published && !r.readback.emailSent);
  if (last && SETTLED_OK.has(last.status) && !verified(last)) {
    try {
      const fresh = await deps.client.status(request.requestId);
      history.push({ try: history.length + 1, action: "reconcile", status: `readback:${fresh.status}`, httpStatus: fresh.httpStatus });
      if (verified(fresh)) last = { ...last, readback: fresh.readback, draftId: fresh.draftId ?? last.draftId, receiptId: fresh.receiptId ?? last.receiptId };
    } catch {
      history.push({ try: history.length + 1, action: "reconcile", status: "readback:unreachable", httpStatus: null });
    }
  }
  const status =
    last && SETTLED_OK.has(last.status)
      ? verified(last)
        ? last.status
        : "unverified"
      : maybeCreated
        ? "uncertain"
        : (last?.status ?? "unreachable");
  const outcome: DeliveryOutcome = {
    requestId: request.requestId,
    status,
    draftId: last?.draftId ?? null,
    receiptId: last?.receiptId ?? null,
    editorUrl: last?.editorUrl ?? null,
    readback: last?.readback ?? null,
    tries: history.length,
    history,
  };
  await deps.attempts.recordDelivery(
    { requestId: request.requestId, articleId, status: outcome.status, draftId: outcome.draftId, receiptId: outcome.receiptId, detail: JSON.stringify({ history, readback: outcome.readback, error: last?.error ?? null }) },
    new Date().toISOString(),
  );
  return outcome;
}
