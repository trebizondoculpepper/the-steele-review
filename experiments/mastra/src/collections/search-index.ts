import type { Client } from "@elastic/elasticsearch";

/**
 * The search-index operations the collection indexer needs (#942), and an
 * Elasticsearch implementation confined to one namespace.
 *
 * Every index and alias name is checked against the namespace before any
 * request is made, so reconciliation can never create, write, delete from or
 * re-point an index outside it. Existing indexes are never deleted: a rebuild
 * leaves the previous backing index in place for rollback and inspection.
 *
 * Errors are reported as categories only; raw client errors can contain
 * endpoints or credentials.
 */

export interface IndexDocument {
  id: string;
  body: Record<string, unknown>;
}

export interface SearchIndexPort {
  indexExists(index: string): Promise<boolean>;
  /** Creates the index with the mapping; fails if it already exists. */
  createIndex(index: string, mapping: Record<string, unknown>): Promise<void>;
  /** Backing indexes the alias currently points at. */
  aliasTargets(alias: string): Promise<string[]>;
  /** Atomically points the alias at `index` alone. */
  pointAlias(alias: string, index: string): Promise<void>;
  /** Indexes documents by ID; returns the IDs that failed. */
  indexDocuments(index: string, documents: readonly IndexDocument[]): Promise<string[]>;
  /** Deletes a document; a missing document is not an error. */
  deleteDocument(index: string, id: string): Promise<void>;
}

export class SearchIndexError extends Error {
  constructor(readonly category: "outside-namespace" | "request-failed") {
    super(`search index: ${category}`);
    this.name = "SearchIndexError";
  }
}

/** Refuses any name outside `<namespace>-`. */
export function guardNamespace(namespace: string, name: string): string {
  if (!name.startsWith(`${namespace}-`)) throw new SearchIndexError("outside-namespace");
  return name;
}

const BULK_BATCH = 500;

/** Elasticsearch 8 implementation of the port, limited to one namespace. */
export class ElasticsearchIndex implements SearchIndexPort {
  constructor(
    private readonly client: Client,
    readonly namespace: string,
  ) {}

  private name(name: string) {
    return guardNamespace(this.namespace, name);
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SearchIndexError) throw error;
      throw new SearchIndexError("request-failed");
    }
  }

  indexExists(index: string) {
    return this.call(() => this.client.indices.exists({ index: this.name(index) }));
  }

  async createIndex(index: string, mapping: Record<string, unknown>) {
    await this.call(() => this.client.indices.create({ index: this.name(index), mappings: mapping as never }));
  }

  aliasTargets(alias: string) {
    return this.call(async () => {
      const name = this.name(alias);
      if (!(await this.client.indices.existsAlias({ name }))) return [];
      return Object.keys(await this.client.indices.getAlias({ name })).filter((index) => index.startsWith(`${this.namespace}-`));
    });
  }

  async pointAlias(alias: string, index: string) {
    const name = this.name(alias);
    const target = this.name(index);
    const current = await this.aliasTargets(name);
    await this.call(() =>
      this.client.indices.updateAliases({
        actions: [
          ...current.filter((i) => i !== target).map((i) => ({ remove: { index: this.name(i), alias: name } })),
          { add: { index: target, alias: name } },
        ],
      }),
    );
  }

  async indexDocuments(index: string, documents: readonly IndexDocument[]) {
    const target = this.name(index);
    const failed: string[] = [];
    for (let i = 0; i < documents.length; i += BULK_BATCH) {
      const batch = documents.slice(i, i + BULK_BATCH);
      const response = await this.call(() =>
        this.client.bulk({ operations: batch.flatMap((d) => [{ index: { _index: target, _id: d.id } }, d.body]) }),
      );
      if (response.errors)
        response.items.forEach((item, n) => {
          if (item.index?.error) failed.push(batch[n]!.id);
        });
    }
    return failed;
  }

  async deleteDocument(index: string, id: string) {
    const target = this.name(index);
    await this.call(async () => {
      try {
        await this.client.delete({ index: target, id });
      } catch (error) {
        if ((error as { meta?: { statusCode?: number } }).meta?.statusCode !== 404) throw error;
      }
    });
  }
}
