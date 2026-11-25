import { parseThemeProposalResult } from "../analysis/theme-proposals.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ClaimExtractionRecordSchema } from "../analysis/grounded-claims.js";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { canonicalNeed, canonicalNeedId, CanonicalNeedSchema } from "./canonical-need.js";
import { writeOnce } from "./job.js";

const Ref = ArtifactReferenceSchema;
export const ResearchNeedBindingsSchema = z
  .object({
    version: z.literal("research-need-bindings-v1"),
    source: Ref,
    themeResult: Ref,
    claimResult: Ref,
    entries: z
      .array(
        z
          .object({
            themeId: z.string().min(1).max(100),
            claimRecordId: z.string().min(1).max(200),
            index: z.number().int().min(0),
            needId: z.string().regex(/^need-[0-9a-f]{40}$/),
            need: CanonicalNeedSchema,
          })
          .strict(),
      )
      .max(10000),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const entry of value.entries) {
      const key = `${entry.themeId}:${entry.index}`;
      if (
        seen.has(key) ||
        entry.needId !== canonicalNeedId(entry.need) ||
        entry.themeId !== entry.need.themeId
      )
        ctx.addIssue({ code: "custom", message: "research need binding is inconsistent" });
      seen.add(key);
    }
  });
export type ResearchNeedBindings = z.infer<typeof ResearchNeedBindingsSchema>;
const toRef = (ref: ArtifactRef) => ({
  repository: ref.repository,
  commit: ref.commit,
  path: ref.path,
  hash: `sha256:${ref.sha256}`,
});

/** Recompute from exact accepted analysis; externally supplied need scopes are never trusted. */
export function researchNeedBindings(input: {
  record: unknown;
  source: z.infer<typeof Ref>;
  themeResult: ArtifactRef;
  claimResult: ArtifactRef;
  mappings: ReadonlyMap<string, string>;
}): ResearchNeedBindings {
  const record = ClaimExtractionRecordSchema.parse(input.record);
  const source = Ref.parse(input.source);
  if (
    record.themeResult &&
    record.themeResult !== `${input.themeResult.commit}:${input.themeResult.path}`
  )
    throw new Error("research-need-analysis-mismatch");
  const entries: ResearchNeedBindings["entries"] = [];
  record.claims.forEach((claim, index) => {
    if (!claim.claimRecordId) return;
    const themes = [
      ...new Set(
        claim.themeIds.map((id) => input.mappings.get(id)).filter((id): id is string => !!id),
      ),
    ];
    for (const themeId of themes) {
      const need = canonicalNeed({
        themeId,
        claimRecordId: claim.claimRecordId,
        kind: claim.kind,
        claim: claim.claim,
        occurrence: claim.occurrence,
        binding: {
          schemaVersion: record.schemaVersion,
          ...record.post,
          sourceVersion: record.sourceVersion,
          source,
          analysis: toRef(input.claimResult),
          index,
        },
      });
      entries.push({
        themeId,
        claimRecordId: claim.claimRecordId,
        index,
        needId: canonicalNeedId(need),
        need,
      });
    }
  });
  return ResearchNeedBindingsSchema.parse({
    version: "research-need-bindings-v1",
    source,
    themeResult: toRef(input.themeResult),
    claimResult: toRef(input.claimResult),
    entries,
  });
}

/** Save before dispatch and verify the immutable winner against recomputed current bindings. */
export async function retainResearchNeedBindings(
  artifacts: GitArtifactStore,
  bindings: ResearchNeedBindings,
): Promise<ArtifactRef> {
  const parsed = ResearchNeedBindingsSchema.parse(bindings);
  const bytes = JSON.stringify(parsed);
  const key = createHash("sha256").update(bytes).digest("hex");
  const ref = await writeOnce(artifacts, `librarian/need-bindings/${key}.json`, parsed);
  const saved = ResearchNeedBindingsSchema.parse(JSON.parse(await artifacts.read(ref)));
  if (JSON.stringify(saved) !== bytes) throw new Error("research-need-binding-conflict");
  return ref;
}

/** Re-read and recompute every saved descriptor; a stored scope is not an authority. */
export async function readResearchNeedBindings(
  artifacts: Pick<GitArtifactStore, "read">,
  ref: ArtifactRef,
): Promise<ResearchNeedBindings> {
  const binding = ResearchNeedBindingsSchema.parse(JSON.parse(await artifacts.read(ref)));
  const record = ClaimExtractionRecordSchema.parse(
    JSON.parse(
      await artifacts.read({
        repository: binding.claimResult.repository,
        commit: binding.claimResult.commit,
        path: binding.claimResult.path,
        sha256: binding.claimResult.hash.slice(7),
      }),
    ),
  );
  const themes = parseThemeProposalResult(
    JSON.parse(
      await artifacts.read({
        repository: binding.themeResult.repository,
        commit: binding.themeResult.commit,
        path: binding.themeResult.path,
        sha256: binding.themeResult.hash.slice(7),
      }),
    ),
  );
  if (
    themes.post.publicationId !== record.post.publicationId ||
    themes.post.postId !== record.post.postId ||
    themes.sourceVersion !== record.sourceVersion ||
    JSON.stringify(themes.artifact) !== JSON.stringify(binding.source)
  )
    throw new Error("research-need-source-mismatch");
  if (
    record.themeResult &&
    record.themeResult !== `${binding.themeResult.commit}:${binding.themeResult.path}`
  )
    throw new Error("research-need-analysis-mismatch");
  for (const entry of binding.entries) {
    const claim = record.claims[entry.index];
    if (
      !claim ||
      claim.claimRecordId !== entry.claimRecordId ||
      claim.themeIds.length === 0 ||
      claim.themeIds.some((id) => !themes.proposals.some((p) => p.id === id))
    )
      throw new Error("research-need-occurrence-mismatch");
    const expected = canonicalNeed({
      themeId: entry.themeId,
      claimRecordId: entry.claimRecordId,
      kind: claim.kind,
      claim: claim.claim,
      occurrence: claim.occurrence,
      binding: {
        schemaVersion: record.schemaVersion,
        ...record.post,
        sourceVersion: record.sourceVersion,
        source: binding.source,
        analysis: binding.claimResult,
        index: entry.index,
      },
    });
    if (JSON.stringify(expected) !== JSON.stringify(entry.need))
      throw new Error("research-need-descriptor-mismatch");
  }
  return binding;
}
