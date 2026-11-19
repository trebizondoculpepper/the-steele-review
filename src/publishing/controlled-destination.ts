import { VendorResponseError, type SubstackDestinationClient } from "./destination.js";

/**
 * Controlled, in-memory stand-in for the Substack vendor client. It follows
 * the observed draft/publish shapes and lets tests inject the failures that
 * matter for safety: lost responses (the side effect happens but the caller
 * sees an error), outages, rate limits and expired sessions. It never makes
 * network calls and publishes nothing real.
 */

type Fault = "lost-response" | "outage" | "rate-limited" | "auth-expired" | "rejected";

interface StoredDraft {
  id: string;
  title: string;
  subtitle?: string;
  body: string;
  is_published: boolean;
  canonical_url?: string;
  post_date?: string;
  emailed: boolean;
}

const failureFor = (fault: Exclude<Fault, "lost-response">) =>
  new VendorResponseError(
    fault === "outage"
      ? 503
      : fault === "rate-limited"
        ? 429
        : fault === "auth-expired"
          ? 401
          : 400,
  );

export class ControlledSubstackClient implements SubstackDestinationClient {
  readonly drafts = new Map<string, StoredDraft>();
  private nextId = 1000;
  private readonly faults: Record<"createDraft" | "getDraft" | "publishDraft", Fault[]> = {
    createDraft: [],
    getDraft: [],
    publishDraft: [],
  };

  constructor(
    private readonly baseUrl = "https://destination.example",
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Queue a fault for the next call(s) of an operation. */
  inject(operation: keyof ControlledSubstackClient["faults"], ...faults: Fault[]): this {
    this.faults[operation].push(...faults);
    return this;
  }

  private take(operation: keyof ControlledSubstackClient["faults"]): Fault | undefined {
    return this.faults[operation].shift();
  }

  async createDraft(draft: { title: string; subtitle?: string; body: string }): Promise<unknown> {
    const fault = this.take("createDraft");
    if (fault && fault !== "lost-response") throw failureFor(fault);
    const id = String(this.nextId++);
    this.drafts.set(id, { id, ...draft, is_published: false, emailed: false });
    if (fault === "lost-response") throw new VendorResponseError("timeout");
    return { id: Number(id), draft_title: draft.title };
  }

  async getDraft(draftId: string): Promise<unknown> {
    const fault = this.take("getDraft");
    if (fault === "lost-response") throw new VendorResponseError("timeout");
    if (fault) throw failureFor(fault);
    const draft = this.drafts.get(draftId);
    if (!draft) throw new VendorResponseError(404);
    return {
      id: Number(draft.id),
      draft_title: draft.title,
      is_published: draft.is_published,
      canonical_url: draft.canonical_url,
      post_date: draft.post_date ?? null,
    };
  }

  async publishDraft(draftId: string, options: { sendEmail: boolean }): Promise<unknown> {
    const fault = this.take("publishDraft");
    if (fault && fault !== "lost-response") throw failureFor(fault);
    const draft = this.drafts.get(draftId);
    if (!draft) throw new VendorResponseError(404);
    if (!draft.is_published) {
      draft.is_published = true;
      draft.emailed = options.sendEmail;
      draft.canonical_url = `${this.baseUrl}/p/post-${draft.id}`;
      draft.post_date = this.now().toISOString();
    }
    if (fault === "lost-response") throw new VendorResponseError("timeout");
    return { id: Number(draft.id), is_published: true };
  }
}
