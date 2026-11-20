import { Client, errors } from "@elastic/elasticsearch";
import {
  FULLTEXT_INDEX_V1,
  fulltextIndexRequest,
  type FulltextDocument,
} from "../content/fulltext-document.js";

/**
 * Elasticsearch controller: the only code that talks to the Elasticsearch
 * client. Provides the read-only connectivity probe, idempotent one-document
 * indexing by stable ID, and explicit index provisioning.
 *
 * Indexing never creates or changes an index or mapping. Each logical index
 * name is an alias over a provisioned backing index, and every write sets
 * `require_alias`, so Elasticsearch itself rejects a write when the alias is
 * missing instead of auto-creating an index with a dynamic mapping, even if
 * the index was deleted after earlier successful writes. Provisioning is a
 * separate, explicit call that creates the backing index and alias when
 * absent and leaves existing ones untouched.
 *
 * Failures are reported as categories only; raw client errors, which can
 * contain endpoints or credentials, are never exposed or logged.
 */

export type IndexingFailure =
  | "missing-index"
  | "rejected"
  | "unauthorized"
  | "throttled"
  | "unavailable"
  | "timeout"
  | "stale-version"
  | "failed";

export class IndexingError extends Error {
  constructor(
    readonly category: IndexingFailure,
    readonly retryable: boolean,
  ) {
    super(`Elasticsearch indexing ${category}`);
    this.name = "IndexingError";
  }
}

export interface IndexResult {
  index: string;
  id: string;
  /** "created" on first write; "updated" when the same ID is written again. */
  result: "created" | "updated" | "noop";
  version: number;
}

/** Narrow client surface used here, injectable for tests. */
export interface ElasticsearchClientLike {
  info(
    params?: undefined,
    options?: { requestTimeout?: number; maxRetries?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  index(
    params: {
      index: string;
      id: string;
      document: unknown;
      require_alias: boolean;
      refresh?: boolean | "wait_for";
      version?: number;
      version_type?: "external";
    },
    options: { requestTimeout: number; maxRetries: number },
  ): Promise<{ _index: string; _id: string; result: string; _version: number }>;
  indices: {
    exists(params: { index: string }): Promise<boolean>;
    create(params: {
      index: string;
      mappings: unknown;
      aliases: Record<string, Record<string, never>>;
    }): Promise<unknown>;
    existsAlias(params: { name: string }): Promise<boolean>;
    putMapping(params: { index: string; properties: Record<string, unknown> }): Promise<unknown>;
  };
  search(
    params: {
      index: string;
      query?: unknown;
      knn?: unknown;
      size: number;
      _source: boolean | { excludes: string[] };
    },
    options: { requestTimeout: number; maxRetries: number },
  ): Promise<{ hits: { hits: Array<{ _id: string; _score: number | null; _source?: unknown }> } }>;
  close(): Promise<void>;
  /** Optional for test doubles that never delete. */
  delete?(
    params: { index: string; id: string; refresh?: boolean | "wait_for" },
    options: { requestTimeout: number; maxRetries: number; ignore?: number[] },
  ): Promise<unknown>;
  deleteByQuery?(
    params: { index: string; query: unknown; refresh?: boolean; conflicts?: "proceed" },
    options: { requestTimeout: number; maxRetries: number },
  ): Promise<{ deleted?: number; failures?: unknown[]; timed_out?: boolean }>;
}

export interface SearchHit {
  id: string;
  score: number;
  source: unknown;
}

export const MAX_SEARCH_RESULTS = 50;

/** Map a client error to a sanitised failure category. */
export function classifyIndexingError(error: unknown): IndexingError {
  if (error instanceof IndexingError) return error;
  if (error instanceof errors.TimeoutError) return new IndexingError("timeout", true);
  if (error instanceof errors.ConnectionError || error instanceof errors.NoLivingConnectionsError) {
    return new IndexingError("unavailable", true);
  }
  const status =
    error instanceof errors.ResponseError
      ? error.statusCode
      : (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
  if (status === 404) return new IndexingError("missing-index", false);
  if (status === 401 || status === 403) return new IndexingError("unauthorized", false);
  if (status === 429) return new IndexingError("throttled", true);
  if (status !== undefined && status >= 500) return new IndexingError("unavailable", true);
  if (status === 409) return new IndexingError("stale-version", false);
  if (status !== undefined && status >= 400) return new IndexingError("rejected", false);
  return new IndexingError("failed", true);
}

export interface IndexOptions {
  /** Per-request timeout in ms; bounded to 1 s – 60 s. */
  timeoutMs?: number;
  /** Make the write visible to search before returning (tests, small volumes). */
  refresh?: boolean | "wait_for";
  /**
   * External version (e.g. a revision number). Elasticsearch rejects a write
   * whose version is not higher than the stored one, reported as
   * `stale-version`, so an older write can never replace a newer document.
   */
  version?: number;
}

export class ElasticsearchController {
  private readonly client: ElasticsearchClientLike;

  constructor(node: string, apiKey?: string, client?: ElasticsearchClientLike) {
    this.client =
      client ??
      (new Client({
        node,
        requestTimeout: 5000,
        maxRetries: 0,
        ...(apiKey ? { auth: { apiKey } } : {}),
      }) as unknown as ElasticsearchClientLike);
  }

  /** Read-only connectivity probe; aborts the request when signalled. */
  async check(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("aborted");
    await this.client.info(undefined, {
      requestTimeout: 5_000,
      maxRetries: 0,
      ...(signal ? { signal } : {}),
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * Index one document under a stable ID. Writing the same ID again replaces
   * that one document, so retries never create duplicates. Refuses to write
   * to a missing index rather than letting it be auto-created.
   */
  async indexDocument(
    index: string,
    id: string,
    document: unknown,
    options: IndexOptions = {},
  ): Promise<IndexResult> {
    if (!id || id.length > 512) throw new IndexingError("rejected", false);
    const timeoutMs = Math.min(60_000, Math.max(1_000, options.timeoutMs ?? 10_000));
    try {
      const response = await this.client.index(
        {
          index,
          id,
          document,
          require_alias: true,
          ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
          ...(options.version === undefined
            ? {}
            : { version: options.version, version_type: "external" as const }),
        },
        { requestTimeout: timeoutMs, maxRetries: 0 },
      );
      const result =
        response.result === "created" || response.result === "updated" || response.result === "noop"
          ? response.result
          : undefined;
      if (!result) throw new IndexingError("failed", true);
      return { index: response._index, id: response._id, result, version: response._version };
    } catch (error) {
      throw classifyIndexingError(error);
    }
  }

  /** Remove one document by ID; a missing document is not an error. */
  async deleteDocument(index: string, id: string, options: IndexOptions = {}): Promise<void> {
    if (!this.client.delete) throw new IndexingError("rejected", false);
    if (!id || id.length > 512) throw new IndexingError("rejected", false);
    const timeoutMs = Math.min(60_000, Math.max(1_000, options.timeoutMs ?? 10_000));
    try {
      await this.client.delete(
        { index, id, ...(options.refresh === undefined ? {} : { refresh: options.refresh }) },
        { requestTimeout: timeoutMs, maxRetries: 0, ignore: [404] },
      );
    } catch (error) {
      throw classifyIndexingError(error);
    }
  }

  /** Remove every document matching a query in one logical index. Returns the count removed. */
  async deleteMatching(index: string, query: unknown, options: IndexOptions = {}): Promise<number> {
    if (!this.client.deleteByQuery) throw new IndexingError("rejected", false);
    const timeoutMs = Math.min(60_000, Math.max(1_000, options.timeoutMs ?? 30_000));
    try {
      const response = await this.client.deleteByQuery(
        { index, query, conflicts: "proceed", ...(options.refresh ? { refresh: true } : {}) },
        { requestTimeout: timeoutMs, maxRetries: 0 },
      );
      // A 200 can still be partial; never let the caller treat it as complete.
      if (response.timed_out || (response.failures?.length ?? 0) > 0) {
        throw new IndexingError("failed", true);
      }
      return response.deleted ?? 0;
    } catch (error) {
      throw classifyIndexingError(error);
    }
  }

  /** Validate and index a full-text document under its stable content ID. */
  async indexFulltextDocument(
    doc: FulltextDocument,
    index: string = FULLTEXT_INDEX_V1,
    options?: IndexOptions,
  ): Promise<IndexResult> {
    const request = fulltextIndexRequest(doc, index);
    return this.indexDocument(request.index._index, request.index._id, request.document, options);
  }

  /**
   * Run one bounded query against exactly one logical index (alias). The
   * result count is capped and the per-request timeout bounded; failures are
   * reported as sanitised categories.
   */
  async search(
    index: string,
    query: unknown,
    options: { size?: number; timeoutMs?: number; sort?: unknown } = {},
  ): Promise<SearchHit[]> {
    const size = Math.max(1, Math.min(options.size ?? 10, MAX_SEARCH_RESULTS));
    const timeoutMs = Math.min(60_000, Math.max(1_000, options.timeoutMs ?? 10_000));
    try {
      const response = await this.client.search(
        {
          index,
          query,
          size,
          _source: true,
          ...(options.sort ? { sort: options.sort as never } : {}),
        },
        { requestTimeout: timeoutMs, maxRetries: 0 },
      );
      return response.hits.hits.map((hit) => ({
        id: hit._id,
        score: hit._score ?? 0,
        source: hit._source,
      }));
    } catch (error) {
      throw classifyIndexingError(error);
    }
  }

  /**
   * Approximate k-nearest-neighbour search over one dense-vector field of one
   * logical index, with an optional filter. `k` is capped like `search`;
   * the vector field itself is excluded from returned sources.
   */
  async knnSearch(
    index: string,
    request: {
      field: string;
      queryVector: number[];
      k: number;
      numCandidates?: number;
      filter?: unknown;
      excludeFields?: string[];
    },
    options: { timeoutMs?: number } = {},
  ): Promise<SearchHit[]> {
    const k = Math.max(1, Math.min(request.k, MAX_SEARCH_RESULTS));
    const numCandidates = Math.max(k, Math.min(request.numCandidates ?? k * 10, 1_000));
    const timeoutMs = Math.min(60_000, Math.max(1_000, options.timeoutMs ?? 10_000));
    try {
      const response = await this.client.search(
        {
          index,
          knn: {
            field: request.field,
            query_vector: request.queryVector,
            k,
            num_candidates: numCandidates,
            ...(request.filter === undefined ? {} : { filter: request.filter }),
          },
          size: k,
          _source: { excludes: request.excludeFields ?? [] },
        },
        { requestTimeout: timeoutMs, maxRetries: 0 },
      );
      return response.hits.hits.map((hit) => ({
        id: hit._id,
        score: hit._score ?? 0,
        source: hit._source,
      }));
    } catch (error) {
      throw classifyIndexingError(error);
    }
  }

  /**
   * Explicitly provision a logical index: create the backing index
   * `<alias>-000001` with the mapping and point the alias at it. An existing
   * alias (or backing index) is never modified.
   */
  async provisionIndex(alias: string, mappings: unknown): Promise<"created" | "unchanged"> {
    try {
      if (await this.client.indices.existsAlias({ name: alias })) return "unchanged";
      const backing = `${alias}-000001`;
      if (await this.client.indices.exists({ index: backing })) return "unchanged";
      await this.client.indices.create({ index: backing, mappings, aliases: { [alias]: {} } });
      return "created";
    } catch (error) {
      throw classifyIndexingError(error);
    }
  }

  /**
   * Additively upgrade a provisioned index: add new fields to its mapping.
   * Elasticsearch only accepts compatible additions, so existing fields can
   * never be changed or removed through this call.
   */
  async addMappingFields(alias: string, properties: Record<string, unknown>): Promise<void> {
    try {
      await this.client.indices.putMapping({ index: alias, properties });
    } catch (error) {
      throw classifyIndexingError(error);
    }
  }
}
