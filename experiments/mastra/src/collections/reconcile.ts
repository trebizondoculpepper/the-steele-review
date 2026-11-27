import { createHash } from "node:crypto";

import { ConfigError } from "../common/config/index.js";
import type { CheckpointState, CheckpointStore, CollectionState, LiveIndex, StagingIndex } from "./checkpoint.js";
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
 *      current backing index (the earlier catch-up pattern, #250), together
 *      with every path an earlier unfinished pass may have written.
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
  /** "failed": a build did not complete; readers stay on the previous index. */
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
    const known = state.collections[collection.directory];
    // A renamed alias (another namespace rule) starts afresh.
    let previous: CollectionState =
      known && known.alias === collection.alias ? known : { directory: collection.directory, alias: collection.alias };
    // A pass that stopped after switching the alias but before saving: the
    // staging index is already what readers see, so record it as live rather
    // than ever writing into it as staging again.
    if (previous.staging && (await options.index.aliasTargets(collection.alias)).includes(previous.staging.backing)) {
      const { backing, mappingVersion, rebuild, head: built } = previous.staging;
      previous = { directory: previous.directory, alias: previous.alias, live: { backing, mappingVersion, rebuild, commit: built } };
      state.collections[collection.directory] = previous;
      await options.checkpoint.save(state);
    }
    const save = async (next: CollectionState) => {
      state.collections[collection.directory] = next;
      await options.checkpoint.save(state);
    };
    const rebuildRequested = options.rebuild === "all" || (options.rebuild?.includes(collection.directory) ?? false);
    const live = previous.live;
    let result: CollectionReport;
    try {
      result =
        live && !(await needsBuild(options, collection, declaration, live, previous.staging, head, rebuildRequested))
          ? await update(options, collection, previous, live, head, save)
          : await build(options, collection, declaration, previous, head, save);
    } catch (error) {
      // One collection's technical failure (search cluster, Git) must not stop
      // the others. Its checkpoint state is whatever was durably saved, so the
      // next pass resumes it. Only a category is reported, never the raw error.
      result = {
        directory: collection.directory,
        alias: collection.alias,
        backing: previous.staging?.backing ?? live?.backing ?? "",
        action: "failed",
        indexed: 0,
        deleted: 0,
        failed: [{ path: collection.directory, reason: error instanceof Error && error.name === "GitReadError" ? "unreadable" : "index-failed" }],
      };
    }
    report.collections.push(result);
    if (result.action === "failed" || result.failed.length) report.ok = false;
    if (state.collections[collection.directory]) await save({ ...state.collections[collection.directory]!, completedAt: now().toISOString() });
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
  live: LiveIndex,
  staging: StagingIndex | undefined,
  head: string,
  rebuildRequested: boolean,
): Promise<boolean> {
  if (rebuildRequested || live.mappingVersion !== declaration.mappingVersion) return true;
  // An unfinished build (a requested rebuild that failed or was interrupted)
  // is resumed by every later pass until it is promoted.
  if (staging) return true;
  if (!(await options.index.indexExists(live.backing))) return true;
  if (!(await options.index.aliasTargets(collection.alias)).includes(live.backing)) return true;
  // A rewritten history leaves no reliable diff; rebuild from the current tree.
  return !(await options.repo.isAncestor(live.commit, head));
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

const idOf = (collection: CollectionName, path: string) => documentId(path.slice(collection.directory.length + 1), sha256);

/**
 * Make each path in the index match HEAD: index it when present, delete it when
 * absent. Returns the failures; the report counts what succeeded.
 */
async function applyPaths(
  options: ReconcileOptions,
  collection: CollectionName,
  backing: string,
  head: string,
  paths: Iterable<string>,
  report: CollectionReport,
): Promise<void> {
  const upserts: IndexDocument[] = [];
  const pathOf = new Map<string, string>();
  for (const path of paths) {
    const read = await readDocument(options.repo, head, collection, path);
    if ("failure" in read) report.failed.push(read.failure);
    else if ("document" in read) {
      upserts.push(read.document);
      pathOf.set(read.document.id, path);
    } else {
      try {
        await options.index.deleteDocument(backing, idOf(collection, path));
        report.deleted++;
      } catch {
        report.failed.push({ path, reason: "delete-failed" });
      }
    }
  }
  let failedIds: string[];
  try {
    failedIds = await options.index.indexDocuments(backing, upserts);
  } catch {
    failedIds = upserts.map((d) => d.id);
  }
  for (const id of failedIds) report.failed.push({ path: pathOf.get(id)!, reason: "index-failed" });
  report.indexed += upserts.length - failedIds.length;
}

/** The staging index a build should use: the unfinished one when it can be reused, else a new name. */
async function chooseStaging(
  options: ReconcileOptions,
  collection: CollectionName,
  declaration: CollectionDeclaration,
  previous: CollectionState,
  head: string,
): Promise<{ staging: StagingIndex; created: boolean; stalePaths: string[] }> {
  const prior = previous.staging;
  if (prior && prior.mappingVersion === declaration.mappingVersion && (await options.index.indexExists(prior.backing))) {
    // Documents an earlier attempt indexed that are gone at HEAD must not
    // survive into the new index. They stay in `touched` until promotion, so a
    // failed or interrupted deletion is retried by every later attempt.
    const stale = new Set(prior.touched ?? []);
    if (prior.head === head || (await options.repo.isAncestor(prior.head, head))) {
      if (prior.head !== head)
        for (const c of await options.repo.changes(prior.head, head))
          if (c.change === "delete" && isDocumentPath(collection, c.path)) stale.add(c.path);
      const touched = [...stale].sort();
      return { staging: { ...prior, head, ...(touched.length ? { touched } : {}) }, created: false, stalePaths: touched };
    }
  }
  // Never reuse an index readers use now, or one whose contents are unknown.
  const live = previous.live;
  let rebuild = Math.max(
    live && live.mappingVersion === declaration.mappingVersion ? live.rebuild + 1 : 0,
    prior && prior.mappingVersion === declaration.mappingVersion ? prior.rebuild + 1 : 0,
  );
  while (await options.index.indexExists(backingIndexName(collection.alias, declaration.mappingVersion, rebuild))) rebuild++;
  const backing = backingIndexName(collection.alias, declaration.mappingVersion, rebuild);
  return { staging: { backing, mappingVersion: declaration.mappingVersion, rebuild, head }, created: true, stalePaths: [] };
}

async function build(
  options: ReconcileOptions,
  collection: CollectionName,
  declaration: CollectionDeclaration,
  previous: CollectionState,
  head: string,
  save: (next: CollectionState) => Promise<void>,
): Promise<CollectionReport> {
  const { staging, created, stalePaths } = await chooseStaging(options, collection, declaration, previous, head);
  const report: CollectionReport = {
    directory: collection.directory,
    alias: collection.alias,
    backing: staging.backing,
    action: previous.live ? "rebuilt" : "built",
    indexed: 0,
    deleted: 0,
    failed: [],
  };
  if (created) await options.index.createIndex(staging.backing, declaration.mapping);
  // Recorded before writing, so the next attempt reuses this index rather than making another.
  await save({ ...previous, staging });

  const paths = (await options.repo.files(head, collection.directory)).map((e) => e.path).filter((p) => isDocumentPath(collection, p));
  await applyPaths(options, collection, staging.backing, head, [...paths, ...stalePaths], report);
  // Readers keep the previous index until the new one is complete.
  if (report.failed.length) {
    report.action = "failed";
    return report;
  }
  // Readers switched to the new index must see all of it at once.
  await options.index.refresh(staging.backing);
  await options.index.pointAlias(collection.alias, staging.backing);
  await save({
    directory: collection.directory,
    alias: collection.alias,
    live: { backing: staging.backing, mappingVersion: staging.mappingVersion, rebuild: staging.rebuild, commit: head },
  });
  return report;
}

async function update(
  options: ReconcileOptions,
  collection: CollectionName,
  previous: CollectionState,
  live: LiveIndex,
  head: string,
  save: (next: CollectionState) => Promise<void>,
): Promise<CollectionReport> {
  const report: CollectionReport = {
    directory: collection.directory,
    alias: collection.alias,
    backing: live.backing,
    action: "unchanged",
    indexed: 0,
    deleted: 0,
    failed: [],
  };
  const paths = new Set(live.touched ?? []);
  if (live.commit !== head)
    for (const c of await options.repo.changes(live.commit, head)) if (isDocumentPath(collection, c.path)) paths.add(c.path);
  if (paths.size === 0) {
    await save({ ...previous, live: { ...live, commit: head } });
    return report;
  }
  // Saved before any write and kept until a pass succeeds, so no path this
  // pass may write can be forgotten by a later failure or history rewrite.
  const touched = [...paths].sort();
  await save({ ...previous, live: { ...live, touched } });
  report.action = "updated";
  await applyPaths(options, collection, live.backing, head, touched, report);
  if (report.failed.length) return report;
  await save({ ...previous, live: { backing: live.backing, mappingVersion: live.mappingVersion, rebuild: live.rebuild, commit: head } });
  return report;
}
