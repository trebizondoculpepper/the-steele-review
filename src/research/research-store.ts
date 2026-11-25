import { createHash } from "node:crypto";
import { z } from "zod";
import type { ArtifactReference } from "../content/artifact-reference.js";
import {
  ArtifactStoreError,
  sha256,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import type { SearchHit } from "../controllers/elasticsearch.js";
import {
  parseResearchEntry,
  type EvidenceSource,
  type Finding,
  type ResearchEntry,
} from "./research-entry.js";

/**
 * Versioned independent research corpus.
 *
 * Git (the #21 artifact store) is the source of truth: each entry has a
 * stable ID derived from its normalised question, and each saved version is
 * an immutable revision at `research/<id>/v<n>.json`. A new revision must
 * name the revision it replaces, so revisions are deliberate rather than
 * accidental overwrites; saving content identical to the latest revision is
 * a no-op.
 *
 * Elasticsearch provides derived retrieval only, in a dedicated research
 * index that is separate from monitored-source documents. Search results are
 * re-read from Git at the exact indexed revision, so returned evidence is the
 * committed record, never index text, and the generated explanation stays
 * labelled as generated rather than presented as evidence.
 */

export const RESEARCH_INDEX_V1 = "steele-research-v1";
export const MAX_REVISIONS = 1_000;
const MAX_RESULTS = 20;

/** Explicit strict mapping for {@link RESEARCH_INDEX_V1}. */
export const RESEARCH_INDEX_MAPPING = {
  dynamic: "strict",
  properties: {
    corpus: { type: "keyword" },
    entryId: { type: "keyword" },
    revision: { type: "integer" },
    question: { type: "text" },
    statements: { type: "text" },
    claimIds: { type: "keyword" },
    findings: { type: "keyword" },
    evidenceUrls: { type: "keyword" },
    artifact: {
      type: "object",
      properties: {
        repository: { type: "keyword" },
        commit: { type: "keyword" },
        path: { type: "keyword" },
        hash: { type: "keyword" },
      },
    },
    createdAt: { type: "date" },
  },
} as const;

const IndexedResearchSchema = z.object({
  corpus: z.literal("research"),
  entryId: z.string(),
  revision: z.number().int().positive(),
  artifact: z.object({
    repository: z.string(),
    commit: z.string(),
    path: z.string(),
    hash: z.string(),
  }),
});

/** Narrow search-index surface (the Elasticsearch controller), injectable for tests. */
export interface ResearchSearchIndex {
  indexDocument(
    index: string,
    id: string,
    document: unknown,
    options?: { version?: number },
  ): Promise<unknown>;
  search(
    index: string,
    query: unknown,
    options?: { size?: number },
  ): Promise<SearchHit[]>;
}

export class ResearchRevisionConflictError extends Error {
  constructor(readonly latestRevision: number) {
    super("research entry was revised by someone else; reload and retry");
    this.name = "ResearchRevisionConflictError";
  }
}

export class ResearchRevisionLimitError extends Error {
  constructor() {
    super(`research entry has reached the ${MAX_REVISIONS}-revision limit`);
    this.name = "ResearchRevisionLimitError";
  }
}

export interface StoredResearchEntry {
  entryId: string;
  revision: number;
  artifact: ArtifactReference;
  entry: ResearchEntry;
}

/** One search candidate: committed evidence with the reason it matched. */
export interface ResearchCandidate {
  entryId: string;
  revision: number;
  score: number;
  question: string;
  /** Addressed claims with their findings and the exact committed evidence. */
  matches: Array<{
    statement: string;
    claimId?: string;
    finding: Finding;
    /** Why the claim is unresolved; present for `unresolved` findings. */
    unresolvedReason?: string;
    evidence: EvidenceSource[];
  }>;
  /** Generated prose, labelled with its generator; never evidence. */
  explanation: { text: string; generatedBy: string; isEvidence: false };
  limitations: string[];
  unresolvedGaps: string[];
  artifact: ArtifactReference;
}

/** Stable entry ID from the normalised question. */
export function researchEntryId(question: string): string {
  const normalised = question
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  return `research-${createHash("sha256").update(normalised, "utf8").digest("hex").slice(0, 32)}`;
}

function revisionPath(entryId: string, revision: number): string {
  return `research/${entryId}/v${revision}.json`;
}

function toReference(ref: ArtifactRef): ArtifactReference {
  return {
    repository: ref.repository,
    commit: ref.commit,
    path: ref.path,
    hash: `sha256:${ref.sha256}`,
  };
}

function fromReference(ref: ArtifactReference): ArtifactRef {
  return {
    repository: ref.repository,
    commit: ref.commit,
    path: ref.path,
    sha256: ref.hash.replace(/^sha256:/, ""),
  };
}

const serialise = (entry: ResearchEntry) =>
  `${JSON.stringify(entry, null, 2)}\n`;

export class ResearchStore {
  constructor(
    private readonly artifacts: GitArtifactStore,
    private readonly index: ResearchSearchIndex,
    private readonly indexName: string = RESEARCH_INDEX_V1,
  ) {}

  /** Latest committed revision of an entry, or undefined if none exists. */
  async latest(entryId: string): Promise<StoredResearchEntry | undefined> {
    let found: { revision: number; ref: ArtifactRef } | undefined;
    for (let revision = 1; revision <= MAX_REVISIONS; revision++) {
      const ref = await this.artifacts.lookup(revisionPath(entryId, revision));
      if (!ref) break;
      found = { revision, ref };
    }
    if (!found) return undefined;
    const entry = parseResearchEntry(
      JSON.parse(await this.artifacts.read(found.ref)),
    );
    return {
      entryId,
      revision: found.revision,
      artifact: toReference(found.ref),
      entry,
    };
  }

  /**
   * Save a validated entry. `expectedRevision` is the revision being replaced
   * (0 for a new entry); a mismatch is refused. Identical content to the
   * latest revision is a no-op. The new revision is committed to Git first,
   * then indexed; indexing is idempotent and can be repeated with
   * {@link reindex}.
   */
  async save(
    entryInput: unknown,
    expectedRevision: number,
  ): Promise<StoredResearchEntry> {
    const entry = parseResearchEntry(entryInput);
    const entryId = researchEntryId(entry.question);
    const current = await this.latest(entryId);
    const latestRevision = current?.revision ?? 0;
    if (current && serialise(current.entry) === serialise(entry)) {
      await this.indexStored(current);
      return current;
    }
    if (expectedRevision !== latestRevision)
      throw new ResearchRevisionConflictError(latestRevision);
    const revision = latestRevision + 1;
    // Revision discovery scans up to MAX_REVISIONS; refuse anything it could not find again.
    if (revision > MAX_REVISIONS) throw new ResearchRevisionLimitError();
    let ref: ArtifactRef;
    try {
      ref = await this.artifacts.write(
        revisionPath(entryId, revision),
        serialise(entry),
      );
    } catch (error) {
      // A concurrent writer committed this revision first.
      if (
        error instanceof ArtifactStoreError &&
        error.code === "immutable-conflict"
      ) {
        throw new ResearchRevisionConflictError(revision);
      }
      throw error;
    }
    const stored = { entryId, revision, artifact: toReference(ref), entry };
    await this.indexStored(stored);
    return stored;
  }

  /** Re-index the latest revision of an entry; safe to repeat. */
  async reindex(entryId: string): Promise<boolean> {
    const current = await this.latest(entryId);
    if (!current) return false;
    await this.indexStored(current);
    return true;
  }

  private async indexStored(stored: StoredResearchEntry): Promise<void> {
    const { entry } = stored;
    const document = {
      corpus: "research",
      entryId: stored.entryId,
      revision: stored.revision,
      question: entry.question,
      statements: entry.addressedClaims.map((c) => c.statement),
      claimIds: entry.addressedClaims.flatMap((c) =>
        c.claimId ? [c.claimId] : [],
      ),
      findings: entry.addressedClaims.map((c) => c.finding),
      evidenceUrls: entry.addressedClaims.flatMap((c) =>
        c.evidence.map((e) => e.url),
      ),
      artifact: stored.artifact,
      createdAt: entry.provenance.createdAt,
    };
    try {
      // The revision is the external version: an overlapping older save or
      // reindex cannot replace a newer indexed revision.
      await this.index.indexDocument(this.indexName, stored.entryId, document, {
        version: stored.revision,
      });
    } catch (error) {
      if ((error as { category?: string }).category === "stale-version") return;
      throw error;
    }
  }

  /**
   * Find research relevant to a topic or claim. Queries only the research
   * index; each hit is re-read from Git at the indexed revision.
   */
  async search(
    query: { text?: string; claimId?: string },
    limit = 10,
  ): Promise<ResearchCandidate[]> {
    const should: unknown[] = [];
    if (query.text?.trim()) {
      should.push({
        multi_match: {
          query: query.text.slice(0, 2000),
          fields: ["question^2", "statements"],
        },
      });
    }
    if (query.claimId)
      should.push({ term: { claimIds: { value: query.claimId, boost: 5 } } });
    if (should.length === 0) return [];
    const hits = await this.index.search(
      this.indexName,
      {
        bool: {
          filter: [{ term: { corpus: "research" } }],
          should,
          minimum_should_match: 1,
        },
      },
      { size: Math.max(1, Math.min(limit, MAX_RESULTS)) },
    );
    const candidates: ResearchCandidate[] = [];
    for (const hit of hits) {
      const indexed = IndexedResearchSchema.safeParse(hit.source);
      if (!indexed.success) continue; // not a research document: never mixed in
      let entry: ResearchEntry;
      try {
        const content = await this.artifacts.read(
          fromReference(indexed.data.artifact),
        );
        entry = parseResearchEntry(JSON.parse(content));
      } catch {
        continue; // index points at something Git cannot vouch for
      }
      const terms = (query.text ?? "")
        .toLowerCase()
        .split(/\W+/)
        .filter((t) => t.length > 2);
      const matches = entry.addressedClaims
        .filter(
          (c) =>
            (query.claimId !== undefined && c.claimId === query.claimId) ||
            terms.some((t) => c.statement.toLowerCase().includes(t)),
        )
        .map((c) => ({
          statement: c.statement,
          ...(c.claimId ? { claimId: c.claimId } : {}),
          finding: c.finding,
          ...(c.unresolvedReason
            ? { unresolvedReason: c.unresolvedReason }
            : {}),
          evidence: c.evidence,
        }));
      candidates.push({
        entryId: indexed.data.entryId,
        revision: indexed.data.revision,
        score: hit.score,
        question: entry.question,
        matches:
          matches.length > 0
            ? matches
            : entry.addressedClaims.map((c) => ({
                statement: c.statement,
                ...(c.claimId ? { claimId: c.claimId } : {}),
                finding: c.finding,
                ...(c.unresolvedReason
                  ? { unresolvedReason: c.unresolvedReason }
                  : {}),
                evidence: c.evidence,
              })),
        explanation: { ...entry.explanation, isEvidence: false },
        limitations: entry.limitations,
        unresolvedGaps: entry.unresolvedGaps,
        artifact: indexed.data.artifact as ArtifactReference,
      });
    }
    return candidates;
  }
}

/** Content hash helper re-exported for callers that pre-compute expectations. */
export const researchContentHash = (entry: ResearchEntry) =>
  `sha256:${sha256(serialise(entry))}`;
