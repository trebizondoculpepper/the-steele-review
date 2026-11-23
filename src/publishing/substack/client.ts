import { z } from "zod";
import { createHash } from "node:crypto";

/**
 * Minimal Substack editor client (#385; design in doc/architecture/06).
 *
 * Substack has no official publishing API: these are the private web-API
 * calls the editor uses, as observed in public clients. They are unverified
 * until the live proof (#384). Only drafts are created; publish is not
 * implemented.
 *
 * Transport safety: the `substack.sid` cookie is sent only to the single
 * configured HTTPS origin; redirects are never followed (Substack redirects
 * expired sessions to sign-in); every call has a timeout and honours an
 * AbortSignal; responses are schema-validated, and errors carry only a code
 * and HTTP status, never bodies, cookies or the origin.
 */

export type SubstackErrorCode =
  | "auth-expired"
  | "rate-limited"
  | "unavailable"
  | "invalid-response"
  /** A create was sent but its outcome is unknown. */
  | "uncertain";

export class SubstackError extends Error {
  constructor(
    readonly code: SubstackErrorCode,
    readonly status?: number,
  ) {
    super(`substack: ${code}${status ? ` (${status})` : ""}`);
    this.name = "SubstackError";
  }
}

export interface SubstackClientConfig {
  /** The publication origin, e.g. https://<name>.substack.com. HTTPS only. */
  origin: string;
  /** Returns the current session cookie value; re-read per request so a replaced file takes effect. */
  session: () => Promise<string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const Id = z.union([z.number().int(), z.string().regex(/^[0-9]+$/)]).transform(String);

const DraftShape = z.looseObject({
  id: Id,
  draft_title: z.string().nullable().optional(),
  draft_body: z.string().nullable().optional(),
  is_published: z.boolean().optional(),
  email_sent_at: z.string().nullable().optional(),
  draft_created_at: z.string().nullable().optional(),
  /** Bylines the editor reports for the draft, when it reports any. */
  draft_bylines: z
    .array(z.looseObject({ id: Id.optional(), name: z.string().optional() }))
    .nullable()
    .optional(),
  /**
   * Where the draft endpoint actually reports saved bylines (#814): an array
   * of user ids (or objects with an id). Folded into `draft_bylines` below.
   */
  // Entries are objects like { user_id, is_draft, is_guest, user } (seen
  // live); parsed leniently so an unexpected entry never fails a read-back.
  postBylines: z.array(z.unknown()).nullable().optional(),
});
/**
 * A draft as read back. Substack reports saved bylines as `postBylines`, not
 * `draft_bylines` (verified live, #814), so read-back byline checks use
 * `postBylines` when present and fall back to `draft_bylines` otherwise.
 */
export const DraftSchema = DraftShape.transform((d) => {
  if (!d.postBylines) return d;
  const ids = d.postBylines.flatMap((b) => {
    const raw =
      typeof b === "number" || typeof b === "string"
        ? b
        : b && typeof b === "object"
          ? ((b as { user_id?: unknown; id?: unknown }).user_id ?? (b as { id?: unknown }).id)
          : undefined;
    const id = Id.safeParse(raw);
    return id.success ? [id.data] : [];
  });
  return { ...d, draft_bylines: ids.map((id) => ({ id })) } as typeof d;
});
export type SubstackDraft = z.infer<typeof DraftSchema>;

export interface NewDraft {
  title: string;
  subtitle?: string;
  /** ProseMirror document, serialised as Substack expects. */
  body: unknown;
  /** Explicit destination byline IDs; omitted means no explicit selection. */
  bylines?: string[];
}

/** Pure adapter-owned target binding; requires no session or transport. */
export function substackDraftOriginIdentity(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.username)
    throw new Error("substack: invalid draft origin");
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(["substack-draft-origin-v1", url.origin]))
    .digest("hex")}`;
}

export class SubstackClient {
  /** Opaque publication binding for draft-only authorizations; never exposes the origin. */
  readonly draftTargetIdentity: string;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: SubstackClientConfig) {
    const url = new URL(config.origin);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.username) {
      throw new Error("substack origin must be a bare https origin");
    }
    this.origin = url.origin;
    this.draftTargetIdentity = substackDraftOriginIdentity(this.origin);
    this.timeoutMs = config.timeoutMs ?? 20_000;
    this.fetchImpl = config.fetch ?? fetch;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    sideEffect: boolean,
  ): Promise<unknown> {
    const session = (await this.config.session()).trim();
    if (!session || /[\s;,]/.test(session)) throw new SubstackError("auth-expired");
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error("substack path left the origin");
    const deadline = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        redirect: "manual",
        headers: {
          cookie: `substack.sid=${session}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch {
      // Sent or not, a create's outcome is unknown once the request may have left.
      throw new SubstackError(sideEffect ? "uncertain" : "unavailable");
    }
    const status = response.status;
    if (status === 401 || status === 403 || (status >= 300 && status < 400)) {
      throw new SubstackError("auth-expired", status);
    }
    if (status === 429) throw new SubstackError("rate-limited", status);
    if (status >= 500) throw new SubstackError(sideEffect ? "uncertain" : "unavailable", status);
    if (status < 200 || status >= 300) throw new SubstackError("invalid-response", status);
    try {
      return await response.json();
    } catch {
      throw new SubstackError(sideEffect ? "uncertain" : "invalid-response", status);
    }
  }

  /** Recent drafts, newest first. Also serves as the access preflight. */
  async listDrafts(
    options: { limit: number; offset?: number },
    signal?: AbortSignal,
  ): Promise<SubstackDraft[]> {
    const limit = Math.min(Math.max(options.limit, 1), 50);
    const raw = await this.request(
      "GET",
      `/api/v1/drafts?filter=draft&limit=${limit}&offset=${options.offset ?? 0}`,
      undefined,
      signal,
      false,
    );
    const parsed = z
      .array(DraftSchema)
      .safeParse(Array.isArray(raw) ? raw : (raw as { posts?: unknown })?.posts);
    if (!parsed.success) throw new SubstackError("invalid-response");
    return parsed.data;
  }

  async createDraft(draft: NewDraft, signal?: AbortSignal): Promise<{ id: string }> {
    const raw = await this.request(
      "POST",
      "/api/v1/drafts",
      {
        draft_title: draft.title,
        draft_subtitle: draft.subtitle ?? "",
        // The editor requires the field even when no explicit byline is chosen.
        draft_bylines: (draft.bylines ?? []).map((id) => ({ id })),
        draft_body: JSON.stringify(draft.body),
        audience: "everyone",
        type: "newsletter",
      },
      signal,
      true,
    );
    const parsed = DraftSchema.safeParse(raw);
    // A 2xx without a usable ID means the draft may exist: uncertain, not failed.
    if (!parsed.success) throw new SubstackError("uncertain");
    return { id: parsed.data.id };
  }

  async getDraft(id: string, signal?: AbortSignal): Promise<SubstackDraft> {
    if (!/^[0-9]+$/.test(id)) throw new Error("invalid draft id");
    const parsed = DraftSchema.safeParse(
      await this.request("GET", `/api/v1/drafts/${id}`, undefined, signal, false),
    );
    if (!parsed.success) throw new SubstackError("invalid-response");
    return parsed.data;
  }

  /**
   * Publish an existing draft (#789), sending it to subscribers by email when
   * `send` is true. Private web API, like the rest of this client. A
   * non-definitive response is `uncertain`: the post may be live.
   */
  async publishDraft(id: string, options: { send: boolean }, signal?: AbortSignal): Promise<void> {
    if (!/^[0-9]+$/.test(id)) throw new Error("invalid draft id");
    await this.request(
      "POST",
      `/api/v1/drafts/${id}/publish`,
      { send: options.send, share_automatically: false },
      signal,
      true,
    );
  }
}
