import { readFileSync } from "node:fs";

/**
 * Narrow client for the shared draft service (#912). Substack authentication
 * and conversion stay inside that service; this side only holds Mastra's own
 * platform token, read from a mounted file on every call and never logged.
 */

export interface DraftRequest {
  requestId: string;
  experiment: "exp-911";
  platform: "mastra";
  attempt: string;
  title: string;
  subtitle?: string;
  bodyMarkdown: string;
  source: { item: string; version: string; url: string };
  article: string;
}

export interface DraftResponse {
  httpStatus: number;
  status: string;
  requestId?: string;
  draftId?: string | null;
  editorUrl?: string;
  readback?: { titleMatches: boolean; published: boolean; emailSent: boolean };
  receiptId?: string | null;
  payloadHash?: string;
  createAttempts?: number;
  error?: string | null;
  issues?: { path: string; message: string }[];
}

export class DraftServiceUnreachable extends Error {
  constructor() {
    super("draft-service-unreachable");
  }
}

export class DraftServiceClient {
  private readonly baseUrl: string;
  private readonly tokenFile: string;
  private readonly fetchImpl: typeof fetch;
  constructor(baseUrl: string, tokenFile: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.tokenFile = tokenFile;
    this.fetchImpl = fetchImpl;
  }

  private token(): string {
    const t = readFileSync(this.tokenFile, "utf8").trim();
    if (!/^[A-Za-z0-9._~+/=-]{32,256}$/.test(t)) throw new Error("draft-service token unavailable");
    return t;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<DraftResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${this.token()}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new DraftServiceUnreachable();
    }
    const json = (await res.json().catch(() => ({}))) as Omit<DraftResponse, "httpStatus">;
    return { httpStatus: res.status, ...json, status: json.status ?? `http-${res.status}` };
  }

  deliver(req: DraftRequest) {
    return this.call("POST", "/v1/drafts", req);
  }
  /** Reconciles a pending or uncertain delivery against the destination; never creates. */
  reconcile(requestId: string) {
    return this.call("POST", `/v1/deliveries/${encodeURIComponent(requestId)}/reconcile`);
  }
  status(requestId: string) {
    return this.call("GET", `/v1/deliveries/${encodeURIComponent(requestId)}`);
  }
}
