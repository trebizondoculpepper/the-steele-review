import { z } from "zod";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { WriterPackageSchema } from "../drafting/writer-package.js";
import {
  WriterAttemptManifestSchema,
  type WriterAttemptManifest,
} from "../drafting/writer-attempts.js";
import type { CollectionAdapter, CollectionPage, CollectionRow } from "./collection-query.js";

/**
 * Writer briefs and retained writer attempts through the shared collection
 * contract (#623, on #617). Two distinct record types:
 *
 * - `brief`: a saved writer evidence package (ready or evidence gap);
 * - `attempt`: one retained writer call (initial, correction or revision),
 *   shown at its final state: the validation record (accepted/rejected) when
 *   one exists, otherwise the captured manifest (returned, no-response,
 *   interrupted).
 *
 * List rows carry only bounded metadata and exact references, never raw
 * provider output. Read-only: no rescue, rerun or model call.
 */

type Store = Pick<GitArtifactStore, "list" | "lookup" | "read">;
export type WriterKind = "brief" | "attempt";

const BRIEF = /^writer-packages\/([^/]+)\/([^/]+)\/[^/]+\.json$/;
const ATTEMPT = /^writer-attempts\/((?:writer|editorial)-attempt-[0-9a-f]{32})\/manifest\.json$/;
/** Bound on stored paths examined for one page request. */
export const WRITER_SCAN = 500;
const LIST_PAGE = 100;

export type WriterBrowseRow = CollectionRow & {
  kind: WriterKind;
  /** Brief: ready | evidence-gap. Attempt: final outcome. */
  outcome: string;
  publicationId?: string;
  postId?: string;
  attempt?: {
    kind: WriterAttemptManifest["kind"];
    number: number;
    revision?: number;
    stopReason: string;
    failure?: string;
    model: string;
    promptVersion: string;
    hasDiagnostic: boolean;
    /** The exact package (brief) the attempt was written from. */
    package: string;
  };
  claims?: number;
};

const ref = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

const Cursor = z.object({ k: z.enum(["brief", "attempt"]), after: z.string().max(1000) }).strict();
const encode = (c: z.infer<typeof Cursor>) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decode(raw: string) {
  try {
    const parsed = Cursor.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** One attempt at its final state: validation when present, else the manifest. */
export async function attemptRecord(
  content: Store,
  attemptId: string,
): Promise<{ manifest: WriterAttemptManifest; ref: ArtifactRef } | undefined> {
  const validation = await content.lookup(`writer-attempts/${attemptId}/validation.json`);
  const r = validation ?? (await content.lookup(`writer-attempts/${attemptId}/manifest.json`));
  if (!r) return undefined;
  const parsed = WriterAttemptManifestSchema.safeParse(JSON.parse(await content.read(r)));
  return parsed.success ? { manifest: parsed.data, ref: r } : undefined;
}

const POST = /^([a-z0-9][a-z0-9-]{0,299})\/([a-z0-9][a-z0-9-]{0,299})$/;

export function writerCollection(content: Store): CollectionAdapter & {
  search(
    query: Parameters<CollectionAdapter["search"]>[0],
  ): Promise<CollectionPage & { rows: WriterBrowseRow[] }>;
} {
  return {
    name: "writer-records",
    filters: {
      kind: {
        schema: z.enum(["brief", "attempt"]),
        description: "Briefs or attempts (never mixed)",
      },
      outcome: {
        schema: z.enum([
          "ready",
          "evidence-gap",
          "accepted",
          "rejected",
          "returned",
          "no-response",
          "interrupted",
        ]),
        description: "Brief status or attempt final outcome",
      },
      post: { schema: z.string().regex(POST), description: "Briefs only: publication/post" },
    },
    sorts: ["stored"],
    async search(query) {
      const f = query.filters as { kind?: WriterKind; outcome?: string; post?: string };
      const kind: WriterKind = f.kind ?? "attempt";
      const limitations: string[] = [];
      let cursor = query.cursor ? decode(query.cursor) : undefined;
      if (query.cursor && (!cursor || cursor.k !== kind)) {
        limitations.push("The page link was not valid for this list; showing the first page.");
        cursor = undefined;
      }
      if (kind === "attempt" && f.post)
        limitations.push("Attempts are listed by attempt; the post filter applies to briefs only.");
      const m = f.post ? POST.exec(f.post) : null;
      const prefix =
        kind === "brief"
          ? m
            ? `writer-packages/${m[1]}/${m[2]}`
            : "writer-packages"
          : "writer-attempts";
      const text = query.text?.toLowerCase();
      const rows: WriterBrowseRow[] = [];
      let after = cursor?.after;
      let lastSeen: string | undefined;
      let scanned = 0;
      let unreadable = 0;
      let exhausted = false;
      while (rows.length < query.limit && scanned < WRITER_SCAN) {
        let paths: string[];
        try {
          paths = await content.list(prefix, LIST_PAGE, after);
        } catch (error) {
          if (scanned === 0 && rows.length === 0) throw error;
          limitations.push("The saved records could not be listed completely right now.");
          break;
        }
        if (paths.length === 0) {
          exhausted = true;
          break;
        }
        for (const path of paths) {
          after = path;
          if (rows.length >= query.limit || scanned >= WRITER_SCAN) break;
          lastSeen = path;
          if (kind === "brief" ? !BRIEF.test(path) : !ATTEMPT.test(path)) continue;
          scanned++;
          try {
            if (kind === "brief") {
              const r = await content.lookup(path);
              if (!r) continue;
              const pkg = WriterPackageSchema.parse(JSON.parse(await content.read(r)));
              if (f.outcome && pkg.status !== f.outcome) continue;
              const summary = `${pkg.post.publicationId}/${pkg.post.postId}`;
              if (text && !`${summary}\n${pkg.status}`.toLowerCase().includes(text)) continue;
              rows.push({
                id: path,
                summary,
                artifact: ref(r),
                kind,
                outcome: pkg.status,
                publicationId: pkg.post.publicationId,
                postId: pkg.post.postId,
                claims: pkg.claims.length,
              });
            } else {
              const id = ATTEMPT.exec(path)![1]!;
              const found = await attemptRecord(content, id);
              if (!found) {
                unreadable++;
                continue;
              }
              const a = found.manifest;
              if (f.outcome && a.outcome !== f.outcome) continue;
              const hay = `${a.attemptId}\n${a.kind}\n${a.outcome}\n${a.requestedModel}\n${a.package.path}`;
              if (text && !hay.toLowerCase().includes(text)) continue;
              const post = /^writer-packages\/([^/]+)\/([^/]+)\//.exec(a.package.path);
              rows.push({
                id: a.attemptId,
                summary: `${a.kind} attempt ${a.number}${a.revision ? ` (revision ${a.revision})` : ""}`,
                artifact: ref(found.ref),
                kind,
                outcome: a.outcome,
                ...(post ? { publicationId: post[1]!, postId: post[2]! } : {}),
                attempt: {
                  kind: a.kind,
                  number: a.number,
                  ...(a.revision ? { revision: a.revision } : {}),
                  stopReason: a.completion.stopReason,
                  ...(a.failure ? { failure: String(a.failure) } : {}),
                  model: a.requestedModel,
                  promptVersion: a.promptVersion,
                  hasDiagnostic: Boolean(a.diagnostic),
                  package: a.package.path,
                },
              });
            }
          } catch {
            unreadable++;
          }
        }
        if (paths.length < LIST_PAGE) {
          exhausted = lastSeen === paths[paths.length - 1];
          break;
        }
      }
      if (unreadable > 0) limitations.push(`${unreadable} saved record(s) could not be read.`);
      if (!exhausted && scanned >= WRITER_SCAN)
        limitations.push("This page reached its scan bound; continue to see more.");
      const next = !exhausted && lastSeen ? encode({ k: kind, after: lastSeen }) : undefined;
      return { rows, ...(next ? { next } : {}), limitations };
    },
  };
}
