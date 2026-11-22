import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { ArtifactReference } from "../content/artifact-reference.js";
import {
  JudgmentRecordSchema,
  type JudgmentRecord,
} from "../drafting/editorial-judgment.js";
import { parseJudgmentDocument } from "../drafting/judgment-document.js";

/**
 * Read-only Judgments browser (#643).
 *
 * Lists every saved judge attempt and shows the exact retained judgement
 * document, including the reasons and requested corrections that drive a
 * revision. A gated, malformed or failed judgement is never approval; reading
 * neither re-judges nor runs any model call.
 */

export const JUDGMENT_PAGE = 20;
export const JUDGMENT_SCAN = 200;
const LIST_PAGE = 50;
// Successful judgements sit under the post; provider failures are retained
// under `<key>.failed/<attempt>.json`.
const RECORD =
  /^judgments\/([^/]+)\/([^/]+)\/([0-9a-f]{32})(?:\.failed\/[0-9a-f]{16})?\.json$/;

export type JudgmentState = JudgmentRecord["state"];
export type JudgmentDecision = JudgmentRecord["decision"];

export interface JudgmentRow {
  path: string;
  publicationId: string;
  postId: string;
  state: JudgmentState;
  decision: JudgmentDecision;
  gateCount: number;
  judgeModel?: string;
  promptVersion?: string;
  decidedAt: string;
  hasDocument: boolean;
}

export interface JudgmentListing {
  state: "ok" | "unavailable";
  rows: JudgmentRow[];
  next?: string;
  partial: boolean;
  unreadable: number;
}

export interface JudgmentDetail {
  row: JudgmentRow;
  gates: string[];
  /** Exact versions the judgment is bound to (path alone is not an identity). */
  assessment: ArtifactReference;
  body: ArtifactReference;
  publication: ArtifactReference;
  document?: string;
  documentUnreadable: boolean;
  /** Parsed guidance when the retained document is a complete judgement. */
  guidance?: {
    decision: "approve" | "revise";
    reasons: string;
    requiredCorrections: string;
    acceptedMinorObservations: string;
  };
}

export interface JudgmentsPort {
  list(filter: {
    query?: string;
    post?: string;
    state?: JudgmentState;
    decision?: JudgmentDecision;
    after?: string;
  }): Promise<JudgmentListing>;
  detail(path: string): Promise<JudgmentDetail | undefined>;
}

type Store = Pick<GitArtifactStore, "list" | "lookup" | "read">;

export function savedJudgments(
  content: Store,
  options: { scanLimit?: number } = {},
): JudgmentsPort {
  const scanLimit = options.scanLimit ?? JUDGMENT_SCAN;
  const readRecord = async (
    path: string,
  ): Promise<{ row: JudgmentRow; record: JudgmentRecord } | undefined> => {
    const m = RECORD.exec(path);
    if (!m) return undefined;
    try {
      const ref = await content.lookup(path);
      if (!ref) return undefined;
      const parsed = JudgmentRecordSchema.safeParse(JSON.parse(await content.read(ref)));
      if (!parsed.success) return undefined;
      const r = parsed.data;
      return {
        record: r,
        row: {
          path,
          publicationId: m[1]!,
          postId: m[2]!,
          state: r.state,
          decision: r.decision,
          gateCount: r.gates.length,
          ...(r.judge ? { judgeModel: r.judge.model, promptVersion: r.judge.promptVersion } : {}),
          decidedAt: r.decidedAt,
          hasDocument: r.document !== undefined,
        },
      };
    } catch {
      return undefined;
    }
  };
  return {
    async list({ query, post, state: wanted, decision: wantedDecision, after }) {
      const q = query?.trim().toLowerCase();
      const rows: JudgmentRow[] = [];
      let unreadable = 0;
      let scanned = 0;
      let cursor = after;
      let exhausted = false;
      while (rows.length < JUDGMENT_PAGE && scanned < scanLimit) {
        let paths: string[];
        try {
          paths = await content.list("judgments", LIST_PAGE, cursor);
        } catch {
          return { state: "unavailable", rows: [], partial: false, unreadable: 0 };
        }
        if (paths.length === 0) {
          exhausted = true;
          break;
        }
        for (const path of paths) {
          if (scanned >= scanLimit) break;
          cursor = path;
          scanned++;
          if (!path.endsWith(".json")) continue;
          if (!RECORD.test(path)) {
            unreadable++;
            continue;
          }
          const found = await readRecord(path);
          if (!found) {
            unreadable++;
            continue;
          }
          const row = found.row;
          if (post && `${row.publicationId}/${row.postId}` !== post) continue;
          if (wanted && row.state !== wanted) continue;
          if (wantedDecision && row.decision !== wantedDecision) continue;
          if (
            q &&
            !`${row.postId} ${row.judgeModel ?? ""} ${row.promptVersion ?? ""} ${row.decision}`
              .toLowerCase()
              .includes(q)
          )
            continue;
          rows.push(row);
          if (rows.length >= JUDGMENT_PAGE || scanned >= scanLimit) break;
        }
      }
      return {
        state: "ok",
        rows,
        ...(exhausted || cursor === undefined ? {} : { next: cursor }),
        partial: scanned >= scanLimit,
        unreadable,
      };
    },

    async detail(path) {
      if (!RECORD.test(path)) return undefined;
      const found = await readRecord(path);
      if (!found) return undefined;
      const { row, record } = found;
      let document: string | undefined;
      let documentUnreadable = false;
      if (record.document) {
        try {
          const docRef = await content.lookup(record.document.path);
          if (docRef) document = await content.read(docRef);
          else documentUnreadable = true;
        } catch {
          documentUnreadable = true;
        }
      }
      const guidance = document ? parseJudgmentDocument(document) : undefined;
      return {
        row,
        gates: record.gates,
        assessment: record.assessment,
        body: record.body,
        publication: record.publication,
        ...(document === undefined ? {} : { document }),
        documentUnreadable,
        ...(guidance ? { guidance } : {}),
      };
    },
  };
}
