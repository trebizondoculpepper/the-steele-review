import { z } from "zod";
import { ArtifactStoreError, type GitArtifactStore } from "../controllers/artifact-store.js";

/**
 * Recoverable trash for saved drafts (#478).
 *
 * Deleting from the console removes a draft from the active listing and
 * nothing else: the saved artifact is never rewritten, no external Substack
 * draft is touched, and a restore brings the same revision back. Each action
 * is bound to the exact saved-draft identity the operator saw and recorded as
 * a durable, versioned marker with a stable request id, so a retry cannot
 * duplicate the record or affect another revision.
 */

export const TRASH_MARKER_SCHEMA_VERSION = 1;

/** Saved draft metadata artifact path; both drafts/ and articles/ layouts exist. */
const DraftPath = z.string().regex(/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9/._-]*\.json$/);
const RequestId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);

export const TrashMarkerSchema = z
  .object({
    schemaVersion: z.literal(TRASH_MARKER_SCHEMA_VERSION),
    /** Exact saved-draft artifact path the operator acted on. */
    draftPath: DraftPath,
    /** Publication payload hash shown with the draft, when it had one. */
    publicationHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    action: z.enum(["delete", "restore"]),
    /** Stable request identity; the same id must always describe the same action. */
    requestId: RequestId,
    at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type TrashMarker = z.infer<typeof TrashMarkerSchema>;

export function trashMarkerPath(requestId: string): string {
  return `draft-trash/${requestId}.json`;
}

export class TrashConflictError extends Error {
  constructor() {
    super("draft trash: request id already describes a different action");
    this.name = "TrashConflictError";
  }
}

export type TrashState = "active" | "trashed";

/** Bound on pagination when reading marker history. */
export const MAX_MARKER_PAGES = 20;

export class DraftTrashStore {
  constructor(
    private readonly artifacts: Pick<GitArtifactStore, "write" | "lookup" | "read" | "list">,
  ) {}

  /**
   * Record one action. Write-once per request id: replaying the same action
   * returns the stored marker and writes nothing, while reusing an id for a
   * different draft or action is refused instead of overwriting history.
   */
  async mark(marker: TrashMarker): Promise<{ marker: TrashMarker; recorded: boolean }> {
    const payload = TrashMarkerSchema.parse(marker);
    const path = trashMarkerPath(payload.requestId);
    const existing = await this.stored(path);
    if (existing) {
      const same =
        existing.draftPath === payload.draftPath &&
        existing.action === payload.action &&
        existing.publicationHash === payload.publicationHash;
      if (!same) throw new TrashConflictError();
      return { marker: existing, recorded: false };
    }
    try {
      await this.artifacts.write(path, `${JSON.stringify(payload, null, 2)}\n`);
      return { marker: payload, recorded: true };
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.code === "immutable-conflict") {
        const winner = await this.stored(path);
        if (winner) {
          const same =
            winner.draftPath === payload.draftPath &&
            winner.action === payload.action &&
            winner.publicationHash === payload.publicationHash;
          // A concurrent caller reusing this id for something else is a
          // conflict, not a successful retry.
          if (!same) throw new TrashConflictError();
          return { marker: winner, recorded: false };
        }
      }
      throw error;
    }
  }

  /** Whether the most recent recorded action for this draft leaves it trashed. */
  async state(draftPath: string): Promise<TrashState> {
    const markers = await this.markers();
    const forDraft = markers.filter((m) => m.draftPath === draftPath);
    if (forDraft.length === 0) return "active";
    const latest = forDraft.reduce((a, b) => {
      const at = Date.parse(a.at);
      const bt = Date.parse(b.at);
      // Offsets are legal in the schema, so order by instant, not by string.
      if (bt !== at) return bt > at ? b : a;
      return b.requestId > a.requestId ? b : a;
    });
    return latest.action === "delete" ? "trashed" : "active";
  }

  /**
   * Recorded markers, oldest first by instant then request id.
   *
   * The listing is paginated: `list()` returns paths in lexical order, so a
   * single bounded page cannot be assumed to contain the newest action.
   */
  async markers(limit = 1000): Promise<TrashMarker[]> {
    const out: TrashMarker[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_MARKER_PAGES; page++) {
      const paths = await this.artifacts.list("draft-trash", limit, after);
      for (const path of paths) {
        const marker = await this.stored(path);
        if (marker) out.push(marker);
      }
      if (paths.length < limit) break;
      after = paths[paths.length - 1];
    }
    return out.sort((a, b) => {
      const at = Date.parse(a.at);
      const bt = Date.parse(b.at);
      return at === bt ? a.requestId.localeCompare(b.requestId) : at - bt;
    });
  }

  private async stored(path: string): Promise<TrashMarker | undefined> {
    const ref = await this.artifacts.lookup(path);
    if (!ref) return undefined;
    const parsed = TrashMarkerSchema.safeParse(JSON.parse(await this.artifacts.read(ref)));
    return parsed.success ? parsed.data : undefined;
  }
}
