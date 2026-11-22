import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { WebAdapterError } from "../controllers/research-web.js";
import type { DiscoveryData } from "./discovery-data.js";
import type { PageFetcher } from "./gap-research.js";
import { writeOnce } from "./job.js";

/**
 * Citation inventory and independent per-URL retrieval (#591, under #210).
 *
 * Two named, deterministic stages after durable discovery (#590):
 *
 * 1. **Inventory.** URLs are taken from the exact saved discovery data:
 *    provider citations, annotation URLs, search-result URLs, and URLs
 *    extracted from the report text, each with its origin. Every distinct
 *    original URL keeps its own identity (anchors and fragments included);
 *    retrieval is keyed separately by a normalised fetch key (fragment
 *    removed), so one download can serve several citations without any cited
 *    section being lost or a source silently replaced.
 * 2. **Retrieval.** Each distinct fetch key is fetched through the existing
 *    public-page controller (public-host/DNS pinning, redirect policy, time
 *    and size bounds stay there) and gets its own saved outcome. A snapshot
 *    is saved before its outcome; one URL's failure never loses another's
 *    download. Transient failures retry a bounded number of times and are
 *    reported as retryable, not recorded as permanent; permanent outcomes are
 *    recorded once. Entries beyond the configured limit are recorded as not
 *    attempted. A resume reads the saved inventory, never a rebuilt list.
 */

export const CITATION_INVENTORY_VERSION = "citation-inventory-v1";
const Ref = ArtifactReferenceSchema;

export const CitationOriginSchema = z
  .object({
    kind: z.enum(["provider-citation", "annotation", "search-result", "report-text"]),
    /** Position within that origin's list (report-text: order of appearance). */
    index: z.number().int().min(0),
  })
  .strict();

export const CitationEntrySchema = z
  .object({
    /** Stable identity of the original cited URL (exact string). */
    id: z.string().regex(/^cite-[0-9a-f]{24}$/),
    originalUrl: z.string().max(4000),
    origins: z.array(CitationOriginSchema).min(1).max(100),
    /** Normalised fetch key, or absent when the URL is not a fetchable public https/http URL. */
    retrievalKey: z.string().max(4000).optional(),
    retrievalId: z
      .string()
      .regex(/^fetch-[0-9a-f]{24}$/)
      .optional(),
    invalidReason: z.enum(["not-a-url", "unsupported-scheme", "credentials-in-url"]).optional(),
  })
  .strict();
export type CitationEntry = z.infer<typeof CitationEntrySchema>;

export const CitationInventorySchema = z
  .object({
    schemaVersion: z.literal(1),
    extractor: z.literal(CITATION_INVENTORY_VERSION),
    discovery: Ref,
    entries: z.array(CitationEntrySchema).max(20_000),
  })
  .strict();
export type CitationInventory = z.infer<typeof CitationInventorySchema>;

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

/** URLs written in the report text, in order, with trailing punctuation trimmed. */
export function urlsInReport(report: string): string[] {
  const found = report.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? [];
  return found.map((u) => u.replace(/[.,;:!?]+$/, ""));
}

/** The fetch key for an original URL: the same resource without its fragment. */
export function retrievalKeyFor(
  url: string,
): { key: string } | { invalid: NonNullable<CitationEntry["invalidReason"]> } {
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
  return { key: parsed.toString() };
}

/** Build the deduplicated inventory deterministically from saved discovery data. */
export function buildCitationInventory(data: DiscoveryData): CitationEntry[] {
  const byUrl = new Map<string, CitationEntry>();
  const add = (url: string, kind: z.infer<typeof CitationOriginSchema>["kind"], index: number) => {
    const existing = byUrl.get(url);
    if (existing) {
      if (existing.origins.length < 100) existing.origins.push({ kind, index });
      return;
    }
    const key = retrievalKeyFor(url);
    byUrl.set(url, {
      id: `cite-${sha(url).slice(0, 24)}`,
      originalUrl: url.slice(0, 4000),
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
  return [...byUrl.values()];
}

/** Save (or reuse) the inventory for one exact saved discovery result. */
export async function saveCitationInventory(input: {
  artifacts: GitArtifactStore;
  /** The discovery `result.json` reference the data was read from. */
  discovery: ArtifactRef;
  data: DiscoveryData;
}): Promise<{ ref: ArtifactRef; inventory: CitationInventory }> {
  const dir = input.discovery.path.replace(/\/result\.json$/, "");
  const path = `${dir}/citations/inventory.json`;
  const saved = await input.artifacts.lookup(path);
  if (saved) {
    const inventory = CitationInventorySchema.parse(JSON.parse(await input.artifacts.read(saved)));
    return { ref: saved, inventory };
  }
  const inventory = CitationInventorySchema.parse({
    schemaVersion: 1,
    extractor: CITATION_INVENTORY_VERSION,
    discovery: toRef(input.discovery),
    entries: buildCitationInventory(input.data),
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
}

export interface RetrievalSummary {
  outcomes: RetrievalOutcome[];
  /** Fetch keys whose transient failures used up their attempts: retry later. */
  retryable: { retrievalId: string; reason: string }[];
}

const PERMANENT_UNSUPPORTED = new Set(["redirected", "unsupported-content"]);

/**
 * Retrieve every fetch key of a saved inventory, each independently. Reads
 * the inventory from its saved reference: a resume never rebuilds it.
 */
export async function retrieveCitations(input: {
  artifacts: GitArtifactStore;
  inventory: ArtifactRef;
  fetcher: PageFetcher;
  limits: RetrievalLimits;
}): Promise<RetrievalSummary> {
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
    // A snapshot saved before a crash is the retrieval: never fetch again.
    const snapshotPath = `${dir}/snapshots/${id}.json`;
    const savedSnapshot = await input.artifacts.lookup(snapshotPath);
    if (savedSnapshot) {
      await record({ ...base, status: "archived", attempts: 0, snapshot: toRef(savedSnapshot) });
      continue;
    }
    let attempts = 0;
    let last: WebAdapterError | undefined;
    for (; attempts < input.limits.maxAttempts;) {
      attempts++;
      try {
        const signal = AbortSignal.timeout(input.limits.timeoutMs);
        const page = await input.fetcher.fetch(key, signal);
        const text = page.text.slice(0, input.limits.maxSourceChars);
        const snapshot = await writeOnce(input.artifacts, snapshotPath, {
          schemaVersion: 1,
          retrievalKey: key,
          url: page.url,
          title: page.title,
          ...(page.publisher ? { publisher: page.publisher } : {}),
          ...(page.publishedAt ? { publishedAt: page.publishedAt } : {}),
          truncated: page.text.length > text.length,
          text,
        });
        await record({ ...base, status: "archived", attempts, snapshot: toRef(snapshot) });
        last = undefined;
        break;
      } catch (error) {
        last =
          error instanceof WebAdapterError
            ? error
            : error instanceof Error && error.name === "TimeoutError"
              ? new WebAdapterError("timeout")
              : new WebAdapterError("unavailable");
        if (last.code === "credit-exhausted") throw last; // not a verdict on the source
        if (!last.retryable) break;
      }
    }
    if (outcomes.at(-1)?.retrievalId === id) continue; // archived above
    if (!last) continue;
    if (last.retryable) {
      // Transient: report it, never record it as a permanent outcome.
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

/** Read a saved snapshot by its exact reference. */
export async function readCitationSnapshot(
  artifacts: Pick<GitArtifactStore, "read">,
  snapshot: z.infer<typeof Ref>,
) {
  return JSON.parse(await artifacts.read(fromRef(snapshot))) as {
    retrievalKey: string;
    url: string;
    title: string;
    text: string;
    truncated: boolean;
  };
}
