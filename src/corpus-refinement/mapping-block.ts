import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { BatchError, readBatch, type CorpusRefinementBatch } from "./batch.js";
import { UnderlyingCatalogueSchema, type UnderlyingCatalogue } from "./catalogue.js";
import type { StageRef } from "./contracts.js";

/**
 * The reusable mapping block (#861): pinned references and typed settings
 * in, independently routable mapped and unmapped references out.
 *
 * Input is a saved, versioned batch (#856) and a pinned catalogue snapshot
 * (#852), both read by exact reference and validated. An injected classifier
 * decides each record; its failures (provider errors) are thrown and stay on
 * the execution path for Restate to retry, never turned into "unmapped".
 * Every unique input record gets exactly one disposition: mapped, with the
 * matched catalogue ID and decision metadata, or unmapped, with a reason code.
 * Both outputs are saved, even when empty, each carrying the original record
 * reference. The block keeps no state across runs.
 */

export interface MappingSettings {
  /** Below this confidence a match is treated as unmapped. */
  minConfidence: "low" | "medium" | "high";
}

export type ClassifierDecision =
  | {
      recordId: string;
      decision: "mapped";
      catalogueId: string;
      confidence: "low" | "medium" | "high";
      rationale?: string;
    }
  | { recordId: string; decision: "unmapped"; reason: string };

export interface MappingClassifier {
  /** Identity of the classifier (model and prompt, or fixture), recorded with outputs. */
  version: string;
  classify(
    records: CorpusRefinementBatch["records"],
    catalogue: UnderlyingCatalogue,
    settings: MappingSettings,
  ): Promise<ClassifierDecision[]>;
}

/** Where a record came from: the exact saved batch and its own fields. */
export interface RecordReference {
  batch: StageRef;
  recordId: string;
  post?: string;
}

export interface MappedRecord {
  source: RecordReference;
  catalogueId: string;
  confidence: "low" | "medium" | "high";
  rationale?: string;
}
export interface UnmappedRecord {
  source: RecordReference;
  reason: string;
}

export interface MappingOutput<T> {
  schemaVersion: 1;
  kind: "corpus-mapping-mapped" | "corpus-mapping-unmapped";
  runId: string;
  batch: StageRef;
  catalogue: StageRef;
  classifier: string;
  settings: MappingSettings;
  records: T[];
}

export const mappingPath = (runId: string, output: "mapped" | "unmapped") =>
  `corpus-refinement/${runId}/mapping/${output}.json`;

const RANK = { low: 0, medium: 1, high: 2 } as const;
const SettingsSchema = z.object({ minConfidence: z.enum(["low", "medium", "high"]) }).strict();

/** One disposition per unique input record, in input order. Pure. */
export function dispose(
  records: CorpusRefinementBatch["records"],
  decisions: ClassifierDecision[],
  catalogue: UnderlyingCatalogue,
  settings: MappingSettings,
): {
  mapped: (Omit<MappedRecord, "source"> & { id: string })[];
  unmapped: (Omit<UnmappedRecord, "source"> & { id: string })[];
  order: { id: string; mapped: boolean }[];
} {
  const entries = new Set(catalogue.entries.map((e) => e.id));
  // The first decision for a record counts; later ones for the same record are ignored.
  const first = new Map<string, ClassifierDecision>();
  for (const d of decisions) if (!first.has(d.recordId)) first.set(d.recordId, d);
  const mapped: (Omit<MappedRecord, "source"> & { id: string })[] = [];
  const unmapped: (Omit<UnmappedRecord, "source"> & { id: string })[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    const d = first.get(record.id);
    if (!d) unmapped.push({ id: record.id, reason: "no-decision" });
    else if (d.decision === "unmapped") unmapped.push({ id: record.id, reason: d.reason });
    else if (!entries.has(d.catalogueId))
      unmapped.push({ id: record.id, reason: `unknown-catalogue-id:${d.catalogueId}` });
    else if (RANK[d.confidence] < RANK[settings.minConfidence])
      unmapped.push({ id: record.id, reason: `below-confidence:${d.confidence}` });
    else
      mapped.push({
        id: record.id,
        catalogueId: d.catalogueId,
        confidence: d.confidence,
        ...(d.rationale ? { rationale: d.rationale } : {}),
      });
  }
  const order = [...seen].map((id) => ({ id, mapped: mapped.some((m) => m.id === id) }));
  return { mapped, unmapped, order };
}

const plain = (ref: ArtifactRef): StageRef => ({
  repository: ref.repository,
  commit: ref.commit,
  path: ref.path,
  sha256: ref.sha256,
});

/**
 * Run the block as ordinary Restate steps inside a caller's handler. Returns
 * the exact references of both saved outputs.
 */
export async function runMappingBlock(
  ctx: restate.Context,
  deps: {
    artifacts: Pick<GitArtifactStore, "read" | "write" | "lookup">;
    classifier: MappingClassifier;
  },
  input: { runId: string; batch: StageRef; catalogue: StageRef; settings: MappingSettings },
): Promise<{ mapped: StageRef; unmapped: StageRef }> {
  const settings = SettingsSchema.parse(input.settings);
  const terminal = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof BatchError || error instanceof z.ZodError)
        throw new restate.TerminalError(`corpus-refinement: mapping input is not usable`);
      throw error;
    }
  };
  const batch = await ctx.run("mapping:read-batch", () =>
    terminal(() => readBatch(deps.artifacts, input.batch as ArtifactRef, input.runId)),
  );
  const catalogue = await ctx.run("mapping:read-catalogue", async () => {
    // A storage failure is retried; a pinned version never changes, so
    // malformed JSON or the wrong shape is terminal.
    const text = await deps.artifacts.read(input.catalogue as ArtifactRef);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const parsed = UnderlyingCatalogueSchema.safeParse(raw);
    if (!parsed.success)
      throw new restate.TerminalError("corpus-refinement: the pinned catalogue is not usable");
    return parsed.data;
  });
  // Provider failures throw here and are retried by Restate: never "unmapped".
  // The decisions and the identity of what made them are journaled together,
  // so a replay after a redeploy never credits old decisions to a new classifier.
  const { decisions, classifierVersion } = await ctx.run("mapping:classify", async () => ({
    decisions: await deps.classifier.classify(batch.records, catalogue, settings),
    classifierVersion: deps.classifier.version,
  }));
  const { mapped, unmapped } = dispose(batch.records, decisions, catalogue, settings);
  const post = new Map(batch.records.map((r) => [r.id, r.post]));
  const source = (id: string): RecordReference => ({
    batch: input.batch,
    recordId: id,
    ...(post.get(id) ? { post: post.get(id)! } : {}),
  });
  const header = {
    schemaVersion: 1 as const,
    runId: input.runId,
    batch: input.batch,
    catalogue: input.catalogue,
    classifier: classifierVersion,
    settings,
  };
  // Saved one at a time; each is write-once, so a retry between saves reuses
  // the output already saved and writes only the missing one.
  const save = async (output: "mapped" | "unmapped", value: unknown) => {
    const path = mappingPath(input.runId, output);
    const content = `${JSON.stringify(value, null, 2)}\n`;
    const existing = await deps.artifacts.lookup(path);
    if (existing) {
      if ((await deps.artifacts.read(existing)) !== content)
        throw new restate.TerminalError(
          `corpus-refinement: ${output} output for ${input.runId} differs`,
        );
      return plain(existing);
    }
    return plain(await deps.artifacts.write(path, content));
  };
  const mappedRef = await ctx.run("mapping:save-mapped", () =>
    save("mapped", {
      ...header,
      kind: "corpus-mapping-mapped",
      records: mapped.map(({ id, ...rest }) => ({ source: source(id), ...rest })),
    } satisfies MappingOutput<MappedRecord>),
  );
  const unmappedRef = await ctx.run("mapping:save-unmapped", () =>
    save("unmapped", {
      ...header,
      kind: "corpus-mapping-unmapped",
      records: unmapped.map(({ id, ...rest }) => ({ source: source(id), ...rest })),
    } satisfies MappingOutput<UnmappedRecord>),
  );
  return { mapped: mappedRef, unmapped: unmappedRef };
}
