import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { SubstackClient, SubstackError, type SubstackErrorCode } from "./substack/client.ts";

/**
 * The single external effect this service performs: creating an unpublished
 * draft. There is no publish, schedule or send operation anywhere in this
 * interface (#912).
 */

export interface DraftInput {
  title: string;
  subtitle?: string;
  /** Substack ProseMirror document. */
  body: unknown;
}

export interface DraftReadback {
  id: string;
  title: string;
  published: boolean;
  emailSent: boolean;
}

export type DestinationErrorCode = SubstackErrorCode;
export { SubstackError as DestinationError };

export interface DraftDestination {
  /** Stable, non-secret identity of the configured target, recorded in receipts. */
  readonly identity: string;
  create(draft: DraftInput, signal?: AbortSignal): Promise<{ id: string }>;
  read(id: string, signal?: AbortSignal): Promise<DraftReadback>;
  /** Recent drafts whose title equals `title` exactly (used to reconcile an uncertain create). */
  findByTitle(title: string, signal?: AbortSignal): Promise<DraftReadback[]>;
  /** Editor link for an authorised caller. */
  editorUrl(id: string): string;
  /** Read-only access check: lists at most one draft and creates nothing. */
  preflight(signal?: AbortSignal): Promise<void>;
}

export class SubstackDraftDestination implements DraftDestination {
  readonly identity: string;
  private readonly client: SubstackClient;
  private readonly origin: string;

  constructor(config: { origin: string; session: () => Promise<string>; fetch?: typeof fetch }) {
    this.client = new SubstackClient(config);
    this.identity = this.client.draftTargetIdentity;
    this.origin = new URL(config.origin).origin;
  }

  create(draft: DraftInput, signal?: AbortSignal) {
    return this.client.createDraft(draft, signal);
  }

  async read(id: string, signal?: AbortSignal): Promise<DraftReadback> {
    const d = await this.client.getDraft(id, signal);
    return {
      id: d.id,
      title: d.draft_title ?? "",
      published: d.is_published === true,
      emailSent: Boolean(d.email_sent_at),
    };
  }

  async findByTitle(title: string, signal?: AbortSignal): Promise<DraftReadback[]> {
    const drafts = await this.client.listDrafts({ limit: 50 }, signal);
    return drafts
      .filter((d) => d.draft_title === title)
      .map((d) => ({
        id: d.id,
        title: d.draft_title ?? "",
        published: d.is_published === true,
        emailSent: Boolean(d.email_sent_at),
      }));
  }

  editorUrl(id: string): string {
    return `${this.origin}/publish/post/${id}`;
  }

  async preflight(signal?: AbortSignal): Promise<void> {
    await this.client.listDrafts({ limit: 1 }, signal);
  }
}

/**
 * File-backed fake destination for tests and fixture runs. It survives a
 * service restart, and it can simulate a lost response after creation
 * (`loseNextCreateResponse`) or an outright failure (`failNextCreate`).
 */
export class FakeDraftDestination implements DraftDestination {
  readonly identity = "fake-destination-v1";
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  private load(): { next: number; drafts: Record<string, DraftReadback>; faults: string[] } {
    if (!existsSync(this.file)) return { next: 1000, drafts: {}, faults: [] };
    return JSON.parse(readFileSync(this.file, "utf8"));
  }
  private save(state: ReturnType<FakeDraftDestination["load"]>) {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(state));
    renameSync(`${this.file}.tmp`, this.file);
  }

  inject(fault: "loseNextCreateResponse" | "failNextCreate") {
    const s = this.load();
    s.faults.push(fault);
    this.save(s);
  }
  count(): number {
    return Object.keys(this.load().drafts).length;
  }

  async create(draft: DraftInput): Promise<{ id: string }> {
    const s = this.load();
    const fault = s.faults.shift();
    if (fault === "failNextCreate") {
      this.save(s);
      throw new SubstackError("rate-limited", 429);
    }
    const id = String(s.next++);
    s.drafts[id] = { id, title: draft.title, published: false, emailSent: false };
    this.save(s);
    if (fault === "loseNextCreateResponse") throw new SubstackError("uncertain");
    return { id };
  }
  async read(id: string): Promise<DraftReadback> {
    const d = this.load().drafts[id];
    if (!d) throw new SubstackError("invalid-response", 404);
    return d;
  }
  async findByTitle(title: string): Promise<DraftReadback[]> {
    return Object.values(this.load().drafts).filter((d) => d.title === title);
  }
  editorUrl(id: string): string {
    return `https://fake.invalid/publish/post/${id}`;
  }
  async preflight(): Promise<void> {
    this.load();
  }
}
