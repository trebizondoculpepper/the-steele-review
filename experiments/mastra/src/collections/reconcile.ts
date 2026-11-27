import { createHash } from "node:crypto";

import { ConfigError } from "../common/config/index.js";
import type { CheckpointState, CheckpointStore, CollectionState } from "./checkpoint.js";
import { DECLARATION_FILE, parseDeclaration, type CollectionDeclaration } from "./declaration.js";
import type { GitRepository, PathChange } from "./git.js";
import { backingIndexName, documentId, nameCollections, validateNamespace, type CollectionName, type NameRejection } from "./names.js";
import type { IndexDocument, SearchIndexPort } from "./search-index.js";

/**
 * Index every Git-backed collection in its own Elasticsearch index (#942).
 *
 * The collections root is a Git repository; each immediate child directory is
 * a collection (nested directories belong to their parent). A pass:
 *
 * 1. reads the commit visible to the indexer (HEAD) and discovers the
 *    collections committed there, so a new collection directory is picked up
 *    by the next pass without a deployment;
 * 2. validates and normalises names, rejecting invalid names and collisions
 *    before any index is touched;
 * 3. for each collection, either
 *    - builds a new backing index with the declared mapping, indexes every
 *      committed document into it and only then points the alias at it (first
 *      build, a new mapping version, an explicit rebuild, a missing index or
 *      alias, or a checkpoint commit no longer in history); or
 *    - applies the changes between the checkpoint commit and HEAD to the
 *      current backing index (the earlier catch-up pattern, #250).
 *
 * Documents are the committed `*.json` files under the collection (except its
 * declaration). A document's ID is its path inside the collection, so it is
 * stable across commits and rebuilds; its provenance names the exact revision
 * and blob it was read from.
 *
 * Passes are idempotent and safe to repeat. A notification after a commit
 * simply runs a pass; a missed notification costs nothing, because the next
 * pass applies everything since the checkpoint. Run passes one at a time.
 *
 * Nothing outside the namespace is touched (the search port enforces it), and
 * nothing is deleted: a rebuild leaves the previous backing index in place,
 * and a collection removed from Git keeps its index and is only reported.
 */

export interface ReconcileOptions {
  repo: GitRepository;
  index: SearchIndexPort;
  checkpoint: CheckpointStore;
  namespace: string;
  /** Collection directories to rebuild from scratch, or "all". */
  rebuild?: readonly string[] | "all";
  now?: () => Date;
}

export interface CollectionFailure {
  path: string;
  reason: "unreadable" | "not-json-object" | "reserved-field" | "index-failed" | "delete-failed";
}

export interface CollectionReport {
  directory: string;
  alias: string;
  backing: string;
  action: "built" | "rebuilt" | "updated" | "unchanged" | "failed";
  indexed: number;
  deleted: number;
  failed: CollectionFailure[];
}

export interface ReconcileReport {
  ok: boolean;
  head?: string;
  collections: CollectionReport[];
  rejected: Array<NameRejection | { directory: string; reason: "missing-declaration" | "invalid-declaration" }>;
  /** Collections in the checkpoint that are no longer in Git; their indexes are kept. */
  removed: string[];
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function reconcileCollections(options: ReconcileOptions): Promise<ReconcileReport> {
  const namespace = validateNamespace(options.namespace);
  const now = options.now ?? (() => new Date());
  const report: ReconcileReport = { ok: true, collections: [], rejected: [], removed: [] };

  const loaded = await options.checkpoint.load();
  if (loaded && loaded.namespace !== namespace) throw new Error("the indexing checkpoint belongs to a different namespace");
  const state: CheckpointState = loaded ?? { schemaVersion: 1, namespace, collections: {} };

  const head = await options.repo.head();
  if (!head) return report;
  report.head = head;

  const discovered = nameCollections(namespace, await options.repo.topLevelDirectories(head));
  report.rejected.push(...discovered.rejected);
  const present = new Set(discovered.collections.map((c) => c.directory));
  report.removed = Object.keys(state.collections).filter((d) => !present.has(d));

  for (const collection of discovered.collections) {
    const declaration = await readDeclaration(options.repo, head, collection.directory);
    if ("reason" in declaration) {
      report.rejected.push({ directory: collection.directory, reason: declaration.reason });
      continue;
    }
    const previous = state.collections[collection.directory];
    const rebuildRequested = options.rebuild === "all" || (options.rebuild?.includes(collection.directory) ?? false);
    const result = (await needsBuild(options, collection, declaration, previous, head, rebuildRequested))
      ? await build(options, collection, declaration, previous, head)
      : await update(options, collection, previous!, head, state);
    report.collections.push(result.report);
    if (result.state) state.collections[collection.directory] = { ...result.state, completedAt: now().toISOString() };
    if (result.report.action === "failed" || result.report.failed.length) report.ok = false;
    await options.checkpoint.save(state);
  }
  if (report.rejected.length) report.ok = false;
  return report;
}

async function readDeclaration(
  repo: GitRepository,
  head: string,
  directory: string,
): Promise<CollectionDeclaration | { reason: "missing-declaration" | "invalid-declaration" }> {
  const file = await repo.read(head, `${directory}/${DECLARATION_FILE}`);
  if (!file) return { reason: "missing-declaration" };
  try {
    return parseDeclaration(directory, file.text);
  } catch (error) {
    if (error instanceof ConfigError) return { reason: "invalid-declaration" };
    throw error;
  }
}

async function needsBuild(
  options: ReconcileOptions,
  collection: CollectionName,
  declaration: CollectionDeclaration,
  previous: CollectionState | undefined,
  head: string,
  rebuildRequested: boolean,
): Promise<boolean> {
  if (!previous?.commit || rebuildRequested) return true;
  if (previous.alias !== collection.alias || previous.mappingVersion !== declaration.mappingVersion) return true;
  if (!(await options.index.indexExists(previous.backing))) return true;
  if (!(await options.index.aliasTargets(collection.alias)).includes(previous.backing)) return true;
  // A rewritten history leaves no reliable diff; rebuild from the current tree.
  return !(await options.repo.isAncestor(previous.commit, head));
}

/** Read one committed document as the body to index, or the reason it cannot be. */
async function readDocument(
  repo: GitRepository,
  head: string,
  collection: CollectionName,
  path: string,
): Promise<{ document: IndexDocument } | { absent: true } | { failure: CollectionFailure }> {
  let file;
  try {
    file = await repo.read(head, path);
  } catch {
    return { failure: { path, reason: "unreadable" } };
  }
  if (!file) return { absent: true };
  let body: unknown;
  try {
    body = JSON.parse(file.text);
  } catch {
    return { failure: { path, reason: "not-json-object" } };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { failure: { path, reason: "not-json-object" } };
  if ("provenance" in body) return { failure: { path, reason: "reserved-field" } };
  const relative = path.slice(collection.directory.length + 1);
  return {
    document: {
      id: documentId(relative, sha256),
      body: { ...body, provenance: { collection: collection.directory, path: relative, revision: head, blob: file.blob } },
    },
  };
}

const isDocumentPath = (collection: CollectionName, path: string) =>
  path.startsWith(`${collection.directory}/`) && path.endsWith(".json") && path !== `${collection.directory}/${DECLARATION_FILE}`;

async function build(
  options: ReconcileOptions,
  collection: CollectionName,
  declaration: CollectionDeclaration,
  previous: CollectionState | undefined,
  head: string,
): Promise<{ report: CollectionReport; state?: CollectionState }> {
  // Never reuse an existing backing index: it may be the one readers use now,
  // or a leftover from an interrupted build.
  let rebuild = previous && previous.mappingVersion === declaration.mappingVersion && previous.alias === collection.alias ? previous.rebuild + 1 : 0;
  while (await options.index.indexExists(backingIndexName(collection.alias, declaration.mappingVersion, rebuild))) rebuild++;
  const backing = backingIndexName(collection.alias, declaration.mappingVersion, rebuild);
  const report: CollectionReport = {
    directory: collection.directory,
    alias: collection.alias,
    backing,
    action: previous ? "rebuilt" : "built",
    indexed: 0,
    deleted: 0,
    failed: [],
  };
  await options.index.createIndex(backing, declaration.mapping);

  const documents: IndexDocument[] = [];
  for (const entry of await options.repo.files(head, collection.directory)) {
    if (!isDocumentPath(collection, entry.path)) continue;
    const read = await readDocument(options.repo, head, collection, entry.path);
    if ("document" in read) documents.push(read.document);
    else if ("failure" in read) report.failed.push(read.failure);
  }
  const failedIds = new Set(await options.index.indexDocuments(backing, documents));
  for (const document of documents) {
    if (failedIds.has(document.id)) report.failed.push({ path: `${collection.directory}/${(document.body.provenance as { path: string }).path}`, reason: "index-failed" });
    else report.indexed++;
  }
  // Readers keep the previous index until the new one is complete.
  if (report.failed.length) {
    report.action = "failed";
    return { report };
  }
  await options.index.pointAlias(collection.alias, backing);
  return {
    report,
    state: { directory: collection.directory, alias: collection.alias, backing, mappingVersion: declaration.mappingVersion, rebuild, commit: head },
  };
}

async function update(
  options: ReconcileOptions,
  collection: CollectionName,
  previous: CollectionState,
  head: string,
  state: CheckpointState,
): Promise<{ report: CollectionReport; state?: CollectionState }> {
  const report: CollectionReport = {
    directory: collection.directory,
    alias: collection.alias,
    backing: previous.backing,
    action: "unchanged",
    indexed: 0,
    deleted: 0,
    failed: [],
  };
  if (previous.commit === head && !previous.pending) return { report, state: previous };

  const inCollection = (c: PathChange) => isDocumentPath(collection, c.path);
  const changes = (await options.repo.changes(previous.commit!, head)).filter(inCollection);
  // A pass that stopped part-way may have written documents at its own head
  // that later commits removed or reverted: reconcile those paths too.
  if (previous.pending && previous.pending !== head && (await options.repo.isAncestor(previous.pending, head))) {
    const seen = new Set(changes.map((c) => c.path));
    for (const c of (await options.repo.changes(previous.pending, head)).filter(inCollection))
      if (!seen.has(c.path)) changes.push({ path: c.path, change: "upsert" });
  }
  if (changes.length === 0) return { report, state: { ...previous, commit: head, pending: undefined } };

  // Recorded before any write, so an interrupted pass is never trusted.
  state.collections[collection.directory] = { ...previous, pending: head };
  await options.checkpoint.save(state);
  report.action = "updated";

  const upserts: IndexDocument[] = [];
  const paths = new Map<string, string>();
  for (const { path, change } of changes) {
    const relative = path.slice(collection.directory.length + 1);
    const id = documentId(relative, sha256);
    const read = change === "delete" ? ({ absent: true } as const) : await readDocument(options.repo, head, collection, path);
    if ("failure" in read) report.failed.push(read.failure);
    else if ("document" in read) {
      upserts.push(read.document);
      paths.set(read.document.id, path);
    } else {
      try {
        await options.index.deleteDocument(previous.backing, id);
        report.deleted++;
      } catch {
        report.failed.push({ path, reason: "delete-failed" });
      }
    }
  }
  for (const id of await options.index.indexDocuments(previous.backing, upserts)) report.failed.push({ path: paths.get(id)!, reason: "index-failed" });
  report.indexed = upserts.length - report.failed.filter((f) => f.reason === "index-failed").length;

  if (report.failed.length) return { report, state: { ...previous, pending: head } };
  return { report, state: { ...previous, commit: head, pending: undefined } };
}
