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
  info(): Promise<unknown>;
  index(
    params: {
      index: string;
      id: string;
      document: unknown;
      require_alias: boolean;
      refresh?: boolean | "wait_for";
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
  };
  search(
    params: { index: string; query: unknown; size: number; _source: boolean },
    options: { requestTimeout: number; maxRetries: number },
  ): Promise<{ hits: { hits: Array<{ _id: string; _score: number | null; _source?: unknown }> } }>;
  close(): Promise<void>;
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
  if (status !== undefined && status >= 400) return new IndexingError("rejected", false);
  return new IndexingError("failed", true);
}

export interface IndexOptions {
  /** Per-request timeout in ms; bounded to 1 s – 60 s. */
  timeoutMs?: number;
  /** Make the write visible to search before returning (tests, small volumes). */
  refresh?: boolean | "wait_for";
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

  async check(): Promise<void> {
    await this.client.info();
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
    options: { size?: number; timeoutMs?: number } = {},
  ): Promise<SearchHit[]> {
    const size = Math.max(1, Math.min(options.size ?? 10, MAX_SEARCH_RESULTS));
    const timeoutMs = Math.min(60_000, Math.max(1_000, options.timeoutMs ?? 10_000));
    try {
      const response = await this.client.search(
        { index, query, size, _source: true },
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
}
