import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { WebAdapterError } from "../controllers/research-web.js";
import type { DiscoveryData } from "./discovery-data.js";
import { readResearchDiscovery } from "./discovery.js";
import type { PageFetcher } from "./gap-research.js";
import { writeOnce } from "./job.js";

/**
 * Citation inventory and independent per-URL retrieval (#591, under #210).
 *
 * Two named, deterministic stages after durable discovery (#590):
 *
 * 1. **Inventory.** URLs come only from the exact, accepted saved discovery,
 *    read through #590's typed reader (never caller-supplied data): provider
 *    citations, annotation URLs, search-result URLs and URLs in the report
 *    text, each with its origin. Every distinct original URL keeps its own
 *    identity (anchors included); retrieval is keyed separately by a
 *    normalised fetch key (fragment removed), so one download can serve
 *    several citations without a cited section being lost or a source
 *    silently replaced. Oversized URLs and entries beyond the bound are
 *    recorded, never a reason for the stage to fail.
 * 2. **Retrieval.** Each fetch key is fetched through the existing
 *    public-page controller and gets its own saved, schema-validated
 *    outcome. Snapshots are validated on write and on adoption and must
 *    match their key. Transient failures, including this stage's own
 *    deadline, retry a bounded number of times and are reported as
 *    retryable, never recorded as permanent. Storage failures are not
 *    mistaken for fetch failures. A resume reads the saved inventory.
 */

export const CITATION_INVENTORY_VERSION = "citation-inventory-v2";
const Ref = ArtifactReferenceSchema;
/** Bound on one URL as stored and fetched. */
export const MAX_URL_CHARS = 4000;
/** Bound on inventory entries; anything beyond is counted, not stored. */
export const MAX_INVENTORY_ENTRIES = 20_000;

export const CitationOriginSchema = z
  .object({
    kind: z.enum(["provider-citation", "annotation", "search-result", "report-text"]),
    index: z.number().int().min(0),
  })
  .strict();

export const CitationEntrySchema = z
  .object({
    /** Stable identity of the full original cited URL string. */
    id: z.string().regex(/^cite-[0-9a-f]{24}$/),
    /** The original URL; truncated (and flagged) only when it exceeds the bound. */
    originalUrl: z.string().max(MAX_URL_CHARS),
    originalUrlTruncated: z.literal(true).optional(),
    origins: z.array(CitationOriginSchema).min(1).max(100),
    retrievalKey: z.string().max(MAX_URL_CHARS).optional(),
    retrievalId: z
      .string()
      .regex(/^fetch-[0-9a-f]{24}$/)
      .optional(),
    invalidReason: z
      .enum(["not-a-url", "unsupported-scheme", "credentials-in-url", "too-long"])
      .optional(),
  })
  .strict();
export type CitationEntry = z.infer<typeof CitationEntrySchema>;

export const CitationInventorySchema = z
  .object({
    schemaVersion: z.literal(1),
    extractor: z.literal(CITATION_INVENTORY_VERSION),
    discovery: Ref,
    entries: z.array(CitationEntrySchema).max(MAX_INVENTORY_ENTRIES),
    /** Distinct URLs beyond the entry bound: recorded as a count, never dropped silently. */
    omittedEntries: z.number().int().min(0),
  })
  .strict();
export type CitationInventory = z.infer<typeof CitationInventorySchema>;

export const CitationSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    retrievalKey: z.string().max(MAX_URL_CHARS),
    url: z.string().max(MAX_URL_CHARS * 2),
    title: z.string().max(2000),
    publisher: z.string().max(500).optional(),
    publishedAt: z.string().max(100).optional(),
    truncated: z.boolean(),
    text: z.string().max(2_000_000),
  })
  .strict();
export type CitationSnapshot = z.infer<typeof CitationSnapshotSchema>;

export const RetrievalOutcomeSchema = z
  .object({
    schemaVersion: z.literal(1),
    retrievalId: z.string(),
    retrievalKey: z.string(),
    inventory: Ref,
    status: z.enum(["archived", "unavailable", "unsupported", "not-attempted"]),
    reason: z.string().max(100).optional(),
    attempts: z.number().int().min(0),
    snapshot: Ref.optional(),
    httpStatus: z.number().int().optional(),
  })
  .strict();
export type RetrievalOutcome = z.infer<typeof RetrievalOutcomeSchema>;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const toRef = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});
const fromRef = (r: z.infer<typeof Ref>): ArtifactRef => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  sha256: r.hash.replace(/^sha256:/, ""),
});
const sameRef = (a: z.infer<typeof Ref>, b: z.infer<typeof Ref>) =>
  a.repository === b.repository && a.commit === b.commit && a.path === b.path && a.hash === b.hash;

/**
 * URLs written in the report text, in order. Trailing prose punctuation and
 * unbalanced closing brackets are trimmed; balanced parentheses inside a URL
 * (for example `Mercury_(planet)`) are kept.
 */
export function urlsInReport(report: string): string[] {
  const found = report.match(/https?:\/\/[^\s<>"'`]+/g) ?? [];
  return found.map((raw) => {
    // Count brackets once, then update while trimming: linear in the match.
    const count = { "(": 0, ")": 0, "[": 0, "]": 0 } as Record<string, number>;
    for (const ch of raw) if (ch in count) count[ch]!++;
    let end = raw.length;
    while (end > 0) {
      const last = raw[end - 1]!;
      if (".,;:!?".includes(last)) {
        end--;
        continue;
      }
      if (last === ")" || last === "]") {
        const open = last === ")" ? "(" : "[";
        if (count[last]! > count[open]!) {
          count[last]!--;
          end--;
          continue;
        }
      }
      break;
    }
    return raw.slice(0, end);
  });
}

/** The fetch key for an original URL: the same resource without its fragment. */
export function retrievalKeyFor(
  url: string,
): { key: string } | { invalid: NonNullable<CitationEntry["invalidReason"]> } {
  if (url.length > MAX_URL_CHARS) return { invalid: "too-long" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { invalid: "not-a-url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { invalid: "unsupported-scheme" };
  }
  if (parsed.username || parsed.password) return { invalid: "credentials-in-url" };
  parsed.hash = "";
  const key = parsed.toString();
  // Normalisation can lengthen a URL (percent-encoding): still bounded.
  return key.length > MAX_URL_CHARS ? { invalid: "too-long" } : { key };
}

/** Build the deduplicated inventory deterministically from accepted discovery data. */
export function buildCitationInventory(data: DiscoveryData): {
  entries: CitationEntry[];
  omittedEntries: number;
} {
  const byUrl = new Map<string, CitationEntry>();
  let omittedEntries = 0;
  const add = (url: string, kind: z.infer<typeof CitationOriginSchema>["kind"], index: number) => {
    const existing = byUrl.get(url);
    if (existing) {
      if (existing.origins.length < 100) existing.origins.push({ kind, index });
      return;
    }
    if (byUrl.size >= MAX_INVENTORY_ENTRIES) {
      omittedEntries++;
      return;
    }
    const key = retrievalKeyFor(url);
    byUrl.set(url, {
      id: `cite-${sha(url).slice(0, 24)}`,
      originalUrl: url.slice(0, MAX_URL_CHARS),
      ...(url.length > MAX_URL_CHARS ? { originalUrlTruncated: true as const } : {}),
      origins: [{ kind, index }],
      ...("key" in key
        ? { retrievalKey: key.key, retrievalId: `fetch-${sha(key.key).slice(0, 24)}` }
        : { invalidReason: key.invalid }),
    });
  };
  data.citations.forEach((u, i) => add(u, "provider-citation", i));
  data.annotationUrls.forEach((u, i) => add(u, "annotation", i));
  data.searchResultUrls.forEach((u, i) => add(u, "search-result", i));
  urlsInReport(data.report).forEach((u, i) => add(u, "report-text", i));
  return { entries: [...byUrl.values()], omittedEntries };
}

/** Reads accepted discovery data for an exact saved result; throws on rejection. */
export type DiscoveryReader = (result: ArtifactRef) => Promise<DiscoveryData>;

/** The production reader: #590's typed, acceptance-checked boundary. */
export function acceptedDiscoveryReader(
  artifacts: GitArtifactStore,
  operations: Pick<OperationStore, "researchDiscoveryAccepted">,
): DiscoveryReader {
  return async (result) => (await readResearchDiscovery(artifacts, result, operations)).data;
}

export class CitationInventoryError extends Error {
  constructor(readonly code: "discovery-rejected" | "inventory-mismatch") {
    super(`citation inventory: ${code}`);
    this.name = "CitationInventoryError";
  }
}

/**
 * Save (or reuse) the inventory for one exact saved discovery result. The
 * URLs come only from that accepted discovery; a rejected, quarantined or
 * unreadable discovery stops here with no provider call.
 */
export async function saveCitationInventory(input: {
  artifacts: GitArtifactStore;
  /** The discovery `result.json` reference. */
  discovery: ArtifactRef;
  readDiscovery: DiscoveryReader;
}): Promise<{ ref: ArtifactRef; inventory: CitationInventory }> {
  const dir = input.discovery.path.replace(/\/result\.json$/, "");
  const path = `${dir}/citations/inventory.json`;
  const saved = await input.artifacts.lookup(path);
  if (saved) {
    const inventory = CitationInventorySchema.parse(JSON.parse(await input.artifacts.read(saved)));
    // A reused inventory must belong to exactly this discovery result.
    if (!sameRef(inventory.discovery, toRef(input.discovery))) {
      throw new CitationInventoryError("inventory-mismatch");
    }
    return { ref: saved, inventory };
  }
  let data: DiscoveryData;
  try {
    data = await input.readDiscovery(input.discovery);
  } catch {
    throw new CitationInventoryError("discovery-rejected");
  }
  const built = buildCitationInventory(data);
  const inventory = CitationInventorySchema.parse({
    schemaVersion: 1,
    extractor: CITATION_INVENTORY_VERSION,
    discovery: toRef(input.discovery),
    entries: built.entries,
    omittedEntries: built.omittedEntries,
  });
  const ref = await writeOnce(input.artifacts, path, inventory);
  return {
    ref,
    inventory: CitationInventorySchema.parse(JSON.parse(await input.artifacts.read(ref))),
  };
}

export interface RetrievalLimits {
  /** Distinct fetch keys attempted, in inventory order; the rest are not attempted. */
  maxSources: number;
  maxAttempts: number;
  timeoutMs: number;
  maxSourceChars: number;
  /** First retry delay; doubles per attempt with jitter, capped (defaults 1 s, 30 s). */
  backoffMs?: number;
  maxBackoffMs?: number;
}

export interface RetrievalSummary {
  outcomes: RetrievalOutcome[];
  /** Fetch keys whose transient failures used up their attempts: retry later. */
  retryable: { retrievalId: string; reason: string }[];
}

const PERMANENT_UNSUPPORTED = new Set(["redirected", "unsupported-content"]);

/** Fetch one key with this stage's own deadline, which is always a retryable timeout. */
async function fetchOnce(fetcher: PageFetcher, key: string, timeoutMs: number) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    return { page: await fetcher.fetch(key, deadline.signal) };
  } catch (error) {
    if (deadline.signal.aborted) return { error: new WebAdapterError("timeout") };
    if (error instanceof WebAdapterError) return { error };
    // Only fetch failures reach here: storage happens outside this call.
    return { error: new WebAdapterError("unavailable") };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retrieve every fetch key of a saved inventory, each independently. Reads
 * the inventory from its saved reference: a resume never rebuilds it.
 */
export async function retrieveCitations(input: {
  artifacts: GitArtifactStore;
  inventory: ArtifactRef;
  fetcher: PageFetcher;
  limits: RetrievalLimits;
  /** Injectable for tests; real delays between retryable attempts otherwise. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): Promise<RetrievalSummary> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = input.random ?? Math.random;
  // Capped exponential backoff with jitter between retryable attempts
  // (doc/architecture/12-failure-handling.md): never an immediate retry.
  const backoff = (attempt: number) => {
    const base = input.limits.backoffMs ?? 1_000;
    const cap = input.limits.maxBackoffMs ?? 30_000;
    const exp = Math.min(cap, base * 2 ** (attempt - 1));
    return Math.round(exp / 2 + random() * (exp / 2));
  };
  const inventory = CitationInventorySchema.parse(
    JSON.parse(await input.artifacts.read(input.inventory)),
  );
  const dir = input.inventory.path.replace(/\/inventory\.json$/, "");
  const keys: { id: string; key: string }[] = [];
  const seen = new Set<string>();
  for (const e of inventory.entries) {
    if (!e.retrievalId || !e.retrievalKey || seen.has(e.retrievalId)) continue;
    seen.add(e.retrievalId);
    keys.push({ id: e.retrievalId, key: e.retrievalKey });
  }
  const outcomes: RetrievalOutcome[] = [];
  const retryable: RetrievalSummary["retryable"] = [];
  for (const [index, { id, key }] of keys.entries()) {
    const outcomePath = `${dir}/retrievals/${id}.json`;
    const existing = await input.artifacts.lookup(outcomePath);
    if (existing) {
      outcomes.push(RetrievalOutcomeSchema.parse(JSON.parse(await input.artifacts.read(existing))));
      continue;
    }
    const base = {
      schemaVersion: 1 as const,
      retrievalId: id,
      retrievalKey: key,
      inventory: toRef(input.inventory),
    };
    const record = async (outcome: RetrievalOutcome) => {
      const ref = await writeOnce(
        input.artifacts,
        outcomePath,
        RetrievalOutcomeSchema.parse(outcome),
      );
      outcomes.push(RetrievalOutcomeSchema.parse(JSON.parse(await input.artifacts.read(ref))));
    };
    if (index >= input.limits.maxSources) {
      await record({ ...base, status: "not-attempted", reason: "source-limit", attempts: 0 });
      continue;
    }
    // A snapshot retained before a crash is adopted only if it is a valid
    // snapshot of exactly this key; otherwise it is kept for diagnosis and
    // never presented as archived evidence.
    const snapshotPath = `${dir}/snapshots/${id}.json`;
    const savedSnapshot = await input.artifacts.lookup(snapshotPath);
    if (savedSnapshot) {
      // Storage errors propagate (retryable); only the content is judged here.
      const retained = await input.artifacts.read(savedSnapshot);
      let valid = false;
      try {
        valid = CitationSnapshotSchema.parse(JSON.parse(retained)).retrievalKey === key;
      } catch {
        valid = false;
      }
      await record(
        valid
          ? { ...base, status: "archived", attempts: 0, snapshot: toRef(savedSnapshot) }
          : { ...base, status: "unavailable", reason: "invalid-retained-snapshot", attempts: 0 },
      );
      continue;
    }
    let attempts = 0;
    let page: Awaited<ReturnType<PageFetcher["fetch"]>> | undefined;
    let last: WebAdapterError | undefined;
    while (attempts < input.limits.maxAttempts) {
      attempts++;
      const out = await fetchOnce(input.fetcher, key, input.limits.timeoutMs);
      if ("page" in out) {
        page = out.page;
        last = undefined;
        break;
      }
      last = out.error;
      if (last.code === "credit-exhausted") throw last; // not a verdict on the source
      if (!last.retryable) break;
      if (attempts < input.limits.maxAttempts) await sleep(backoff(attempts));
    }
    // Storage happens outside the fetch: its failures propagate, never retried as fetches.
    if (page) {
      const text = page.text.slice(0, input.limits.maxSourceChars);
      const snapshot = await writeOnce(
        input.artifacts,
        snapshotPath,
        CitationSnapshotSchema.parse({
          schemaVersion: 1,
          retrievalKey: key,
          url: page.url,
          title: page.title.slice(0, 2000),
          ...(page.publisher ? { publisher: page.publisher.slice(0, 500) } : {}),
          ...(page.publishedAt ? { publishedAt: page.publishedAt.slice(0, 100) } : {}),
          truncated: page.text.length > text.length,
          text,
        }),
      );
      await record({ ...base, status: "archived", attempts, snapshot: toRef(snapshot) });
      continue;
    }
    if (!last) continue;
    if (last.retryable) {
      retryable.push({ retrievalId: id, reason: last.code });
      continue;
    }
    await record({
      ...base,
      status: PERMANENT_UNSUPPORTED.has(last.code) ? "unsupported" : "unavailable",
      reason: last.code,
      attempts,
      ...(last.status ? { httpStatus: last.status } : {}),
    });
  }
  return { outcomes, retryable };
}

/** Read a saved snapshot by its exact reference, validated. */
export async function readCitationSnapshot(
  artifacts: Pick<GitArtifactStore, "read">,
  snapshot: z.infer<typeof Ref>,
): Promise<CitationSnapshot> {
  return CitationSnapshotSchema.parse(JSON.parse(await artifacts.read(fromRef(snapshot))));
}
