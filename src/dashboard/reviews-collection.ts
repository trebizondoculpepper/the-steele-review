import { z } from "zod";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { AssessmentsPort } from "./assessments.js";
import {
  CollectionQueryError,
  type CollectionAdapter,
  type CollectionPage,
  type CollectionRow,
} from "./collection-query.js";
import type { JudgmentsPort } from "./judgments.js";
import type { ReviewHistoryPort } from "./reviews.js";

/**
 * Assessment and judgment records through the shared collection contract
 * (#622, on #617). Three distinct record types, selected by a required kind:
 *
 * - `assessment`: the assessor's findings for one exact publication version;
 * - `judgment`: the editorial judge's decision on an assessment;
 * - `verifier-report`: legacy package-verifier reports, which the reader keeps
 *   per post, so this kind needs a post filter.
 *
 * Outcomes are only the ones recorded: a missing or incomplete record is
 * never presented as approval. Every row carries its exact saved artifact and
 * links to the existing detail page. Read-only, no model calls.
 */

type Store = Pick<GitArtifactStore, "lookup">;
export type ReviewKind = "assessment" | "judgment" | "verifier-report";

const OUTCOMES: Record<ReviewKind, readonly string[]> = {
  assessment: ["findings", "no-faults", "incomplete", "malformed", "provider-failed"],
  judgment: ["approve", "revise", "none", "gated", "malformed", "provider-failed"],
  "verifier-report": ["approved", "redraft", "skip", "unresolved", "unreadable"],
};

export type ReviewBrowseRow = CollectionRow & {
  kind: ReviewKind;
  outcome: string;
  publicationId: string;
  postId: string;
  at?: string;
  model?: string;
  /** Count of recorded findings, gates or issues, when recorded. */
  count?: number;
  /** Verifier reports: where this report sits in the post's review history. */
  history?: { page: number; after?: string };
};

const ref = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});
const POST = /^([a-z0-9][a-z0-9-]{0,299})\/([a-z0-9][a-z0-9-]{0,299})$/;

const Cursor = z
  .object({
    k: z.enum(["assessment", "judgment", "verifier-report"]),
    after: z.string().optional(),
    /** Verifier reports: the reader's page within its current window. */
    page: z.number().int().min(0).optional(),
    /** The last record already shown from this reader page. */
    last: z.string().max(1000).optional(),
  })
  .strict();
type CursorValue = z.infer<typeof Cursor>;
const encode = (c: CursorValue) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decode(raw: string): CursorValue | undefined {
  try {
    const parsed = Cursor.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function reviewsCollection(
  ports: { assessments: AssessmentsPort; judgments: JudgmentsPort; reviews: ReviewHistoryPort },
  content: Store,
): CollectionAdapter & {
  search(
    query: Parameters<CollectionAdapter["search"]>[0],
  ): Promise<CollectionPage & { rows: ReviewBrowseRow[] }>;
} {
  return {
    name: "reviews",
    filters: {
      kind: {
        schema: z.enum(["assessment", "judgment", "verifier-report"]),
        description: "Record type (never mixed)",
      },
      post: { schema: z.string().regex(POST), description: "publication/post" },
      outcome: {
        schema: z.string().regex(/^[a-z-]{1,40}$/),
        description: "A recorded outcome valid for the chosen kind",
      },
    },
    sorts: ["stored"],
    async search(query) {
      const f = query.filters as { kind?: ReviewKind; post?: string; outcome?: string };
      const kind: ReviewKind = f.kind ?? "assessment";
      if (f.outcome && !OUTCOMES[kind].includes(f.outcome))
        throw new CollectionQueryError("invalid-filter", ["outcome"]);
      const limitations: string[] = [];
      let cursor = query.cursor ? decode(query.cursor) : undefined;
      if (query.cursor && (!cursor || cursor.k !== kind)) {
        limitations.push("The page link was not valid for this list; showing the first page.");
        cursor = undefined;
      }
      const after = cursor?.after;
      const readerPage = cursor?.page ?? 0;
      const last = cursor?.last;
      const text = query.text?.toLowerCase();

      type Candidate = Omit<ReviewBrowseRow, "artifact" | "summary" | "id"> & { path: string };
      let candidates: Candidate[];
      let readerNext: string | undefined;
      /** Verifier reports only: the next page within the reader's window. */
      let nextReaderPage: number | undefined;

      if (kind === "verifier-report") {
        const m = f.post ? POST.exec(f.post) : null;
        if (!m)
          return {
            rows: [],
            limitations: [
              "Legacy verifier reports are kept per post: choose a post (publication/post) to list them.",
            ],
          };
        const history = await ports.reviews.forPost(
          { publicationId: m[1]!, postId: m[2]! },
          readerPage,
          after,
        );
        if (history.state === "unavailable") throw new Error("verifier reports unavailable");
        if (history.truncated || history.state === "partial")
          limitations.push("Not every saved report could be examined.");
        // Exhaust the pages within this window before moving to the next one.
        nextReaderPage = history.next;
        readerNext = history.nextWindow;
        candidates = history.reviews.map((r) => ({
          path: r.path,
          kind,
          outcome: r.kind === "unreadable" ? "unreadable" : r.outcome,
          publicationId: m[1]!,
          postId: m[2]!,
          ...(r.kind === "review" && r.verifiedAt ? { at: r.verifiedAt } : {}),
          ...(r.kind === "review" && r.modelVersion ? { model: r.modelVersion } : {}),
          ...(r.kind !== "unreadable" ? { count: r.issues.length } : {}),
          history: { page: readerPage, ...(after ? { after } : {}) },
        }));
      } else if (kind === "assessment") {
        const listing = await ports.assessments.list({
          ...(f.post ? { post: f.post } : {}),
          ...(f.outcome ? { state: f.outcome as never } : {}),
          ...(after ? { after } : {}),
        });
        if (listing.state === "unavailable") throw new Error("assessments unavailable");
        if (listing.partial)
          limitations.push("This page reached its scan bound; continue to see more.");
        if (listing.unreadable)
          limitations.push(`${listing.unreadable} assessment(s) could not be read.`);
        readerNext = listing.next;
        candidates = listing.rows.map((r) => ({
          path: r.path,
          kind,
          outcome: r.state,
          publicationId: r.publicationId,
          postId: r.postId,
          at: r.assessedAt,
          model: r.assessorModel,
          ...(r.findings !== undefined ? { count: r.findings } : {}),
        }));
      } else {
        // The outcome filter applies to the displayed outcome (below), so a
        // gated record never matches a decision it did not make.
        const listing = await ports.judgments.list({
          ...(f.post ? { post: f.post } : {}),
          ...(after ? { after } : {}),
        });
        if (listing.state === "unavailable") throw new Error("judgments unavailable");
        if (listing.partial)
          limitations.push("This page reached its scan bound; continue to see more.");
        if (listing.unreadable)
          limitations.push(`${listing.unreadable} judgment(s) could not be read.`);
        readerNext = listing.next;
        candidates = listing.rows.map((r) => ({
          path: r.path,
          kind,
          // A decision is shown only when one was actually decided.
          outcome: r.state === "decided" ? r.decision : r.state,
          publicationId: r.publicationId,
          postId: r.postId,
          at: r.decidedAt,
          ...(r.judgeModel ? { model: r.judgeModel } : {}),
          count: r.gateCount,
        }));
      }

      // Resume after the last record shown, by identity, so records saved in
      // between can never make a page repeat an earlier one.
      let start = 0;
      if (last !== undefined) {
        const at = candidates.findIndex((c) => c.path === last);
        if (at >= 0) start = at + 1;
        else if (kind !== "verifier-report") {
          // Listings are in path order: continue after where it would have been.
          start = candidates.findIndex((c) => c.path > last);
          if (start < 0) start = candidates.length;
        } else
          limitations.push(
            "The last shown report is no longer listed; continuing from the start of this page.",
          );
      }
      const rows: ReviewBrowseRow[] = [];
      let lastShown: string | undefined;
      let consumed = start;
      for (const c of candidates.slice(start)) {
        if (rows.length >= query.limit) break;
        consumed++;
        lastShown = c.path;
        if (kind !== "assessment" && f.outcome && c.outcome !== f.outcome) continue;
        if (
          text &&
          !`${c.publicationId}/${c.postId}\n${c.outcome}\n${c.model ?? ""}`
            .toLowerCase()
            .includes(text)
        )
          continue;
        const r = await content.lookup(c.path);
        if (!r) {
          limitations.push("Some saved records could not be found at their recorded path.");
          continue;
        }
        const { path, ...rest } = c;
        rows.push({
          ...rest,
          id: path,
          summary: `${c.publicationId}/${c.postId}: ${c.outcome}`,
          artifact: ref(r),
        });
      }
      const more = consumed < candidates.length;
      const next = more
        ? encode({
            k: kind,
            ...(after ? { after } : {}),
            ...(readerPage ? { page: readerPage } : {}),
            ...(lastShown ? { last: lastShown } : {}),
          })
        : nextReaderPage !== undefined
          ? encode({ k: kind, ...(after ? { after } : {}), page: nextReaderPage })
          : readerNext
            ? encode({ k: kind, after: readerNext })
            : undefined;
      return { rows, ...(next ? { next } : {}), limitations: [...new Set(limitations)] };
    },
  };
}
