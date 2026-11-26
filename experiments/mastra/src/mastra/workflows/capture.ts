import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { feedConfigFromEnv } from "../../feed/poll.js";
import { FeedStore } from "../../feed/store.js";
import { capturePost } from "../../capture/substack.js";
import { VersionStore } from "../../capture/store.js";

/**
 * Retained source versions (#920), as native Mastra workflows. These are the
 * contract's retained-version operations: capture, listItems, listVersions,
 * readVersion, exportVersion and importVersion.
 *
 * Capture is the only step that fetches from the source. Every other
 * operation reads storage only, so an older version can be read and later
 * pinned for writing (#921) without refetching or substituting the latest.
 */

export const versions = new VersionStore(process.env.STEELE_EXP_MASTRA_SOURCES_DB ?? "file:./.data/sources.db");
const feed = new FeedStore(process.env.STEELE_EXP_MASTRA_FEED_DB ?? "file:./.data/feed.db");

const Captured = z.object({
  url: z.string(),
  outcome: z.enum(["captured", "failed"]),
  version: z.string().nullable(),
  created: z.boolean(),
  textSource: z.string().nullable(),
  textChars: z.number(),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
});
type Captured = z.infer<typeof Captured>;

async function captureOne(url: string): Promise<Captured> {
  const now = new Date().toISOString();
  try {
    const r = await capturePost(url, { publicationHost: feedConfigFromEnv().publicationHost });
    const saved = await versions.save(
      r.bundle,
      { rawPost: r.rawPost, rawTranscript: r.rawTranscript, warnings: r.warnings, captureMeta: { capturedAt: now, method: r.bundle.textSource, source: url } },
      now,
    );
    return { url, outcome: "captured", version: saved.version, created: saved.created, textSource: r.bundle.textSource, textChars: r.bundle.text.length, warnings: r.warnings, error: null };
  } catch (e) {
    // A fetch failure is a technical outcome, not evidence about the source's content.
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "capture-failed";
    return { url, outcome: "failed", version: null, created: false, textSource: null, textChars: 0, warnings: [], error: code };
  }
}

export const captureSourceWorkflow = createWorkflow({
  id: "capture-source",
  description: "Capture one public post and save it as an immutable source version (#920).",
  inputSchema: z.object({ url: z.string().max(500) }),
  outputSchema: Captured,
})
  .then(
    createStep({
      id: "capture",
      inputSchema: z.object({ url: z.string().max(500) }),
      outputSchema: Captured,
      execute: async ({ inputData }) => {
        const r = await captureOne(inputData.url);
        if (r.outcome === "failed") throw new Error(`capture failed: ${r.error}`);
        return r;
      },
    }),
  )
  .commit();

export const capturePendingWorkflow = createWorkflow({
  id: "capture-pending",
  description: "Capture items discovery marked as needing capture (new, edited or selected), bounded per run (#920).",
  inputSchema: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
  outputSchema: z.object({ results: z.array(Captured) }),
})
  .then(
    createStep({
      id: "capture-pending",
      inputSchema: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
      outputSchema: z.object({ results: z.array(Captured) }),
      execute: async ({ inputData }) => {
        const results: Captured[] = [];
        for (const item of await feed.pendingCapture(inputData.limit)) {
          const r = await captureOne(item.canonicalUrl);
          // Clear the durable flag only at the fingerprint that was captured.
          if (r.outcome === "captured") await feed.markCaptured(item.canonicalUrl, item.fingerprint);
          results.push(r);
        }
        return { results };
      },
    }),
  )
  .commit();

/** A single-step workflow; its zod schemas validate input and output at runtime. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = z.ZodObject<any>;
const readOnly = (id: string, description: string, input: AnyObject, output: AnyObject, run: (i: never) => Promise<unknown>) =>
  createWorkflow({ id, description, inputSchema: input, outputSchema: output })
    .then(
      createStep({
        id,
        inputSchema: input,
        outputSchema: output,
        execute: async ({ inputData }) => (await run(inputData as never)) as Record<string, unknown>,
      }),
    )
    .commit();

export const listSourcesWorkflow = readOnly(
  "list-sources",
  "Read-only: source items with retained versions, newest first (#920).",
  z.object({ limit: z.number().int().min(1).max(50).default(20) }),
  z.object({ items: z.array(z.object({ item: z.string(), latestVersion: z.string(), latestCapturedAt: z.string(), versions: z.number() })) }),
  async (i: any) => ({ items: await versions.listItems(i.limit) }),
);

const Summary = z.object({
  version: z.string(),
  item: z.string(),
  sha256: z.string(),
  capturedAt: z.string(),
  lastObservedAt: z.string(),
  observations: z.number(),
  textSource: z.string(),
  textChars: z.number(),
  warnings: z.array(z.string()),
});

export const listVersionsWorkflow = readOnly(
  "list-versions",
  "Read-only: every retained version of one source item (#920).",
  z.object({ item: z.string().max(100) }),
  z.object({ versions: z.array(Summary) }),
  async (i: any) => ({ versions: await versions.listVersions(i.item) }),
);

export const readVersionWorkflow = readOnly(
  "read-version",
  "Read-only: one retained version's metadata and usable text, from storage (#920).",
  z.object({ version: z.string().max(200) }),
  Summary.extend({ bundle: z.record(z.string(), z.unknown()) }),
  async (i: any) => {
    const v = await versions.read(i.version);
    const { bundleBytes: _b, rawPost: _p, rawTranscript: _t, captureMeta: _m, ...rest } = v;
    return { ...rest, bundle: v.bundle as unknown as Record<string, unknown> };
  },
);

export const exportVersionWorkflow = readOnly(
  "export-version",
  "Export one retained version (canonical bytes plus capture metadata) for import elsewhere (#920).",
  z.object({ version: z.string().max(200) }),
  z.object({ export: z.record(z.string(), z.unknown()) }),
  async (i: any) => ({ export: (await versions.export(i.version)) as unknown as Record<string, unknown> }),
);

export const importVersionWorkflow = readOnly(
  "import-version",
  "Import an exported version; rejected unless its recomputed hash matches (#920).",
  z.object({ export: z.record(z.string(), z.unknown()) }),
  z.object({ version: z.string(), created: z.boolean() }),
  async (i: any) => versions.import(i.export, new Date().toISOString()),
);
