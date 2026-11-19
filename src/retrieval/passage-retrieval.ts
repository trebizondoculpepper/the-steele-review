import { z } from "zod";
import type { ArtifactReference } from "../content/artifact-reference.js";
import { FULLTEXT_INDEX_V1, FulltextDocumentSchema } from "../content/fulltext-document.js";
import {
  DEFAULT_CHUNKING,
  PASSAGE_VECTOR_FIELD,
  PassageVectorDocumentSchema,
  passageVectorIndexName,
  type ChunkingConfig,
} from "../content/passage-vectors.js";
import { splitPassages } from "../content/passages.js";
import type { EmbeddingModel } from "../controllers/embedding.js";
import type { SearchHit } from "../controllers/elasticsearch.js";

/**
 * Keyword and semantic passage retrieval.
 *
 * Keyword candidates come from the full-text index (BM25 over title and
 * text). Each matching post is split with the same deterministic splitter
 * and chunking as the vector index, and the passage containing the most
 * query terms is returned with its exact span, so keyword and semantic hits
 * for the same passage share a passage ID.
 *
 * Semantic candidates come from approximate kNN over the passage-vector index
 * of the configured embedding model, when an embedder is available. If it is
 * not, or embedding fails, retrieval falls back to keyword only and says so.
 *
 * Ranking is Reciprocal Rank Fusion: each candidate scores
 * sum(1 / (60 + rank)) over the lists it appears in, so passages found by
 * both methods rank higher without comparing incompatible raw scores.
 *
 * Scores are retrieval signals only. They are not truth, confidence or
 * evidence of agreement or contradiction.
 */

export const RRF_K = 60;
export const MAX_RESULTS = 20;

export interface RetrievalQuery {
  text: string;
  publicationId?: string;
  /** Inclusive publication-date bounds (ISO 8601). */
  from?: string;
  to?: string;
  /** Exclusive upper bound: only posts published strictly before this time. */
  before?: string;
  /** Posts to leave out entirely, e.g. the source post of a claim. */
  excludePostIds?: string[];
  /** Only posts without a publication date (ignores date bounds). */
  undatedOnly?: boolean;
  limit?: number;
}

export interface RetrievedPassage {
  passageId: string;
  sourceId: string;
  publicationId: string;
  postId: string;
  url?: string;
  title?: string;
  publishedAt?: string;
  text: string;
  start: number;
  end: number;
  artifact: ArtifactReference;
  signals: {
    keywordRank?: number;
    semanticRank?: number;
    /** Reciprocal Rank Fusion score; a ranking signal, not a truth or confidence measure. */
    fused: number;
  };
}

export interface RetrievalResult {
  mode: "hybrid" | "keyword-only";
  /** Why semantic retrieval was not used, when it was not. */
  semanticUnavailable?: "no-embedder" | "embedding-failed" | "vector-search-failed";
  passages: RetrievedPassage[];
}

export interface RetrievalIndexPort {
  search(index: string, query: unknown, options?: { size?: number }): Promise<SearchHit[]>;
  knnSearch(
    index: string,
    request: {
      field: string;
      queryVector: number[];
      k: number;
      filter?: unknown;
      excludeFields?: string[];
    },
  ): Promise<SearchHit[]>;
}

export interface PassageRetrieverConfig {
  index: RetrievalIndexPort;
  fulltextIndex?: string;
  chunking?: ChunkingConfig;
  /** Embedding model and query embedder; omit for keyword-only retrieval. */
  semantic?: { model: EmbeddingModel; embedQuery: (text: string) => Promise<number[]> };
}

const QuerySchema = z.object({
  text: z.string().trim().min(1).max(2000),
  publicationId: z.string().min(1).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  excludePostIds: z.array(z.string().min(1)).max(50).optional(),
  undatedOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
});

/**
 * Query terms for passage selection. Short identifiers such as "AI", "UK" or
 * "5G" are kept; single characters are dropped unless they are all there is.
 */
const tokenize = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const terms = (text: string) => {
  const all = [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    ),
  ];
  const meaningful = all.filter((t) => t.length >= 2);
  return meaningful.length > 0 ? meaningful : all;
};

export class PassageRetriever {
  private readonly fulltextIndex: string;
  private readonly chunking: ChunkingConfig;

  constructor(private readonly config: PassageRetrieverConfig) {
    this.fulltextIndex = config.fulltextIndex ?? FULLTEXT_INDEX_V1;
    this.chunking = config.chunking ?? DEFAULT_CHUNKING;
  }

  async retrieve(input: RetrievalQuery): Promise<RetrievalResult> {
    const query = QuerySchema.parse(input);
    const limit = query.limit ?? 10;
    const pool = Math.min(limit * 3, 50);

    const keyword = await this.keywordCandidates(query, pool);

    let semantic: RetrievedPassage[] = [];
    let semanticUnavailable: RetrievalResult["semanticUnavailable"];
    if (!this.config.semantic) {
      semanticUnavailable = "no-embedder";
    } else {
      let vector: number[] | undefined;
      try {
        vector = await this.config.semantic.embedQuery(query.text);
      } catch {
        semanticUnavailable = "embedding-failed";
      }
      if (vector) {
        try {
          semantic = await this.semanticCandidates(query, vector, pool);
        } catch {
          semanticUnavailable = "vector-search-failed";
        }
      }
    }

    // Reciprocal Rank Fusion, deduplicating by passage ID.
    const fused = new Map<string, RetrievedPassage>();
    const add = (list: RetrievedPassage[], key: "keywordRank" | "semanticRank") => {
      list.forEach((candidate, i) => {
        const rank = i + 1;
        const existing = fused.get(candidate.passageId) ?? { ...candidate, signals: { fused: 0 } };
        existing.signals[key] = rank;
        existing.signals.fused += 1 / (RRF_K + rank);
        fused.set(candidate.passageId, existing);
      });
    };
    add(keyword, "keywordRank");
    add(semantic, "semanticRank");
    const passages = [...fused.values()]
      .sort((a, b) => b.signals.fused - a.signals.fused || a.passageId.localeCompare(b.passageId))
      .slice(0, limit);
    await this.enrichFromFulltext(passages);
    return {
      mode: semanticUnavailable ? "keyword-only" : "hybrid",
      ...(semanticUnavailable ? { semanticUnavailable } : {}),
      passages,
    };
  }

  /**
   * Semantic-only results come from vector documents, which do not carry the
   * post's canonical URL or title: fill them from the full-text document for
   * the same post. Best effort; a lookup failure leaves them absent.
   */
  private async enrichFromFulltext(passages: RetrievedPassage[]): Promise<void> {
    const missing = passages.filter((p) => p.url === undefined);
    if (missing.length === 0) return;
    const ids = [...new Set(missing.map((p) => `substack:${p.publicationId}:${p.postId}`))];
    let hits: SearchHit[];
    try {
      hits = await this.config.index.search(
        this.fulltextIndex,
        { ids: { values: ids } },
        { size: ids.length },
      );
    } catch {
      return;
    }
    const byPost = new Map<string, { url: string; title: string; publishedAt?: string }>();
    for (const hit of hits) {
      const doc = FulltextDocumentSchema.safeParse(hit.source);
      if (doc.success) {
        byPost.set(`${doc.data.publicationId}/${doc.data.postId}`, {
          url: doc.data.url,
          title: doc.data.title,
          ...(doc.data.publishedAt ? { publishedAt: doc.data.publishedAt } : {}),
        });
      }
    }
    for (const p of missing) {
      const meta = byPost.get(`${p.publicationId}/${p.postId}`);
      if (!meta) continue;
      p.url = meta.url;
      p.title = meta.title;
      if (p.publishedAt === undefined && meta.publishedAt) p.publishedAt = meta.publishedAt;
    }
  }

  private filters(query: z.infer<typeof QuerySchema>, dateField: string, publicationField: string) {
    const filter: unknown[] = [];
    if (query.publicationId) filter.push({ term: { [publicationField]: query.publicationId } });
    if (query.undatedOnly) {
      filter.push({ bool: { must_not: [{ exists: { field: dateField } }] } });
      return filter;
    }
    if (query.from || query.to || query.before) {
      filter.push({
        range: {
          [dateField]: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
            ...(query.before ? { lt: query.before } : {}),
          },
        },
      });
    }
    return filter;
  }

  private async keywordCandidates(
    query: z.infer<typeof QuerySchema>,
    size: number,
  ): Promise<RetrievedPassage[]> {
    const hits = await this.config.index.search(
      this.fulltextIndex,
      {
        bool: {
          must: [{ multi_match: { query: query.text, fields: ["title^2", "text"] } }],
          filter: this.filters(query, "publishedAt", "publicationId"),
          ...(query.excludePostIds?.length
            ? { must_not: [{ terms: { postId: query.excludePostIds } }] }
            : {}),
        },
      },
      { size },
    );
    const queryTerms = terms(query.text);
    const out: RetrievedPassage[] = [];
    for (const hit of hits) {
      const doc = FulltextDocumentSchema.safeParse(hit.source);
      if (!doc.success) continue;
      const d = doc.data;
      const sourceId = `substack/${d.publicationId}/${d.postId}`;
      const passages = splitPassages(
        {
          sourceId,
          text: d.text,
          sourceVersion: d.sourceVersion,
          ...(d.publishedAt ? { publishedAt: d.publishedAt } : {}),
        },
        {
          maxChars: this.chunking.maxChars,
          overlapChars: this.chunking.overlapChars,
          minChars: this.chunking.minChars,
        },
      ).passages;
      let best = passages[0];
      let bestScore = -1;
      for (const p of passages) {
        // Whole-token matches only: "AI" must not match inside "said".
        const tokens = new Set(tokenize(p.text));
        const score = queryTerms.filter((t) => tokens.has(t)).length;
        if (score > bestScore) {
          best = p;
          bestScore = score;
        }
      }
      if (!best) continue;
      out.push({
        passageId: best.id,
        sourceId,
        publicationId: d.publicationId,
        postId: d.postId,
        url: d.url,
        title: d.title,
        ...(d.publishedAt ? { publishedAt: d.publishedAt } : {}),
        text: best.text,
        start: best.start,
        end: best.end,
        artifact: d.artifact,
        signals: { fused: 0 },
      });
    }
    return out;
  }

  private async semanticCandidates(
    query: z.infer<typeof QuerySchema>,
    vector: number[],
    k: number,
  ): Promise<RetrievedPassage[]> {
    const model = this.config.semantic!.model;
    if (vector.length !== model.dimensions || !vector.every(Number.isFinite)) {
      throw new Error("query vector does not match the model");
    }
    const filter: unknown[] = this.filters(query, "publishedAt", "sourceId");
    // Vector documents carry sourceId "substack/<publication>/<post>"; filter by prefix.
    if (query.publicationId) {
      filter.splice(0, 1, { prefix: { sourceId: `substack/${query.publicationId}/` } });
    }
    const hits = await this.config.index.knnSearch(passageVectorIndexName(model, this.chunking), {
      field: PASSAGE_VECTOR_FIELD,
      queryVector: vector,
      k,
      ...(filter.length || query.excludePostIds?.length
        ? {
            filter: {
              bool: {
                filter,
                ...(query.excludePostIds?.length
                  ? {
                      // With a publication, exclude the exact source IDs; without one,
                      // exclude the post in any publication.
                      must_not: query.excludePostIds.map((id) =>
                        query.publicationId
                          ? { term: { sourceId: `substack/${query.publicationId}/${id}` } }
                          : { wildcard: { sourceId: { value: `substack/*/${id}` } } },
                      ),
                    }
                  : {}),
              },
            },
          }
        : {}),
      excludeFields: [PASSAGE_VECTOR_FIELD],
    });
    const out: RetrievedPassage[] = [];
    for (const hit of hits) {
      const doc = PassageVectorDocumentSchema.omit({ [PASSAGE_VECTOR_FIELD]: true }).safeParse(
        hit.source,
      );
      if (!doc.success) continue;
      const d = doc.data;
      const [, publicationId = "", postId = ""] = d.sourceId.split("/");
      out.push({
        passageId: d.passageId,
        sourceId: d.sourceId,
        publicationId,
        postId,
        ...(d.publishedAt ? { publishedAt: d.publishedAt } : {}),
        text: d.text,
        start: d.start,
        end: d.end,
        artifact: d.artifact,
        signals: { fused: 0 },
      });
    }
    return out;
  }
}
