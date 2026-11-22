import type { GitArtifactStore } from "../controllers/artifact-store.js";
import {
  AssessmentRecordSchema,
  type AssessmentState,
} from "../drafting/article-assessment.js";

/**
 * Read-only Assessments browser (#642).
 *
 * Lists every saved assessor attempt with its completion state and provenance,
 * and shows the exact retained findings document. Absence of a completed
 * assessment is never approval, and no assessment, judgement or model call is
 * run by reading.
 */

export const ASSESSMENT_PAGE = 20;
export const ASSESSMENT_SCAN = 200;
const LIST_PAGE = 50;
// Successful attempts sit directly under the post; provider failures are kept
// under `<key>.failed/<attempt>.json` by the producer.
const RECORD =
  /^assessments\/([^/]+)\/([^/]+)\/([0-9a-f]{32})(?:\.failed\/[0-9a-f]{16})?\.json$/;

export interface AssessmentRow {
  path: string;
  publicationId: string;
  postId: string;
  state: AssessmentState;
  findings?: number;
  deterministicFindings: number;
  assessorModel: string;
  promptVersion: string;
  assessedAt: string;
  /** True when a retained findings document exists. */
  hasDocument: boolean;
}

export interface AssessmentListing {
  state: "ok" | "unavailable";
  rows: AssessmentRow[];
  next?: string;
  partial: boolean;
  unreadable: number;
}

export interface AssessmentDetail {
  row: AssessmentRow;
  deterministic: { passage: string; reason: string }[];
  /** The retained findings document exactly as received. */
  document?: string;
  documentUnreadable: boolean;
}

export interface AssessmentsPort {
  list(filter: {
    query?: string;
    post?: string;
    state?: AssessmentState;
    after?: string;
  }): Promise<AssessmentListing>;
  detail(path: string): Promise<AssessmentDetail | undefined>;
}

type Store = Pick<GitArtifactStore, "list" | "lookup" | "read">;

export function savedAssessments(
  content: Store,
  options: { scanLimit?: number } = {},
): AssessmentsPort {
  const scanLimit = options.scanLimit ?? ASSESSMENT_SCAN;
  const readRow = async (path: string): Promise<AssessmentRow | undefined> => {
    const m = RECORD.exec(path);
    if (!m) return undefined;
    try {
      const ref = await content.lookup(path);
      if (!ref) return undefined;
      const parsed = AssessmentRecordSchema.safeParse(JSON.parse(await content.read(ref)));
      if (!parsed.success) return undefined;
      const r = parsed.data;
      return {
        path,
        publicationId: m[1]!,
        postId: m[2]!,
        state: r.state,
        ...(r.findings === undefined ? {} : { findings: r.findings }),
        deterministicFindings: r.deterministicFindings.length,
        assessorModel: r.assessor.model,
        promptVersion: r.assessor.promptVersion,
        assessedAt: r.assessedAt,
        hasDocument: r.document !== undefined,
      };
    } catch {
      return undefined;
    }
  };
  return {
    async list({ query, post, state: wanted, after }) {
      const q = query?.trim().toLowerCase();
      const rows: AssessmentRow[] = [];
      let unreadable = 0;
      let scanned = 0;
      let cursor = after;
      let exhausted = false;
      while (rows.length < ASSESSMENT_PAGE && scanned < scanLimit) {
        let paths: string[];
        try {
          paths = await content.list("assessments", LIST_PAGE, cursor);
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
          const row = await readRow(path);
          if (!row) {
            unreadable++;
            continue;
          }
          if (post && `${row.publicationId}/${row.postId}` !== post) continue;
          if (wanted && row.state !== wanted) continue;
          if (q && !`${row.postId} ${row.assessorModel} ${row.promptVersion}`.toLowerCase().includes(q))
            continue;
          rows.push(row);
          if (rows.length >= ASSESSMENT_PAGE || scanned >= scanLimit) break;
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
      const row = await readRow(path);
      if (!row) return undefined;
      let deterministic: AssessmentDetail["deterministic"] = [];
      let document: string | undefined;
      let documentUnreadable = false;
      try {
        const ref = await content.lookup(path);
        if (!ref) return undefined;
        const record = AssessmentRecordSchema.parse(JSON.parse(await content.read(ref)));
        deterministic = record.deterministicFindings;
        if (record.document) {
          try {
            const docRef = await content.lookup(record.document.path);
            if (docRef) document = await content.read(docRef);
            else documentUnreadable = true;
          } catch {
            documentUnreadable = true;
          }
        }
      } catch {
        return undefined;
      }
      return {
        row,
        deterministic,
        ...(document === undefined ? {} : { document }),
        documentUnreadable,
      };
    },
  };
}
