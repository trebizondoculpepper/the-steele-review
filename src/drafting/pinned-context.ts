import {
  SourceContextSchema,
  sourceContextFor,
  sourceContextMatches,
  sourceContextVersion,
  type SourceContext,
} from "../content/source-context.js";
import { createHash } from "node:crypto";
import { parseThemeProposalResult } from "../analysis/theme-proposals.js";
import { CollectionRecordSchema } from "../collection/collection-store.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { DraftingBrief } from "./brief.js";

/**
 * Pinned source and theme context for drafting and verification (#164).
 *
 * A fair summary of a whole post cannot be written from its URL and a few
 * selected passages. This loads the exact captured source the brief names
 * (hash-verified through the artifact controller) and an exact saved theme
 * proposal result, checks both describe the same source text version as the
 * brief, and gives drafting and verification the same bounded context. It
 * never browses the post URL or reads a mutable "latest" dossier.
 *
 * The context is untrusted source material: the writer may summarise the
 * post from it, but factual corrections still come only from the brief's
 * research citations. A source statement never confirms itself.
 */

export const DEFAULT_MAX_SOURCE_CHARS = 60_000;

export interface PinnedTheme {
  id: string;
  title: string;
  description?: string;
  /** Canonical theme the librarian mapped this proposal to, when known. */
  canonicalId?: string;
}

export interface PinnedContext {
  source: {
    ref: ArtifactRef;
    sourceVersion: string;
    text: string;
    provenance: SourceContext;
    provenanceRef?: ArtifactRef;
  };
  themes: { ref: ArtifactRef; proposals: PinnedTheme[] };
  /**
   * Stable identity of exactly this context (source and theme result
   * references). Recorded with drafts and verifications so a result made
   * against one context is never reused for another.
   */
  contextRef: string;
}

export type PinnedContextOutcome =
  | { kind: "loaded"; context: PinnedContext }
  | { kind: "source-mismatch" }
  | { kind: "theme-mismatch" }
  | { kind: "source-context-mismatch" }
  | { kind: "source-too-large"; chars: number; maxChars: number }
  /** The capture is marked incomplete (for example, transcription pending). */
  | { kind: "incomplete-source" }
  | { kind: "unreadable"; what: "source" | "themes" };

const refKey = (r: ArtifactRef) => [r.repository, r.commit, r.path, r.sha256];

/**
 * Identity of the exact context: source and theme result references plus any
 * librarian mapping applied, since the mapping changes what the model sees.
 */
export function contextRefFor(
  source: ArtifactRef,
  themes: ArtifactRef,
  mapping: ReadonlyMap<string, string> = new Map(),
  provenanceVersion?: string,
  provenanceRef?: ArtifactRef,
): string {
  const pairs = [...mapping.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        source: refKey(source),
        themes: refKey(themes),
        mapping: pairs,
        ...(provenanceVersion ? { provenanceVersion } : {}),
        ...(provenanceRef ? { provenanceRef: refKey(provenanceRef) } : {}),
      }),
    )
    .digest("hex")}`;
}

export async function loadPinnedContext(input: {
  /** Archive holding the captured source. */
  archive: Pick<GitArtifactStore, "read">;
  /** Content repository holding the theme proposal result. */
  content: Pick<GitArtifactStore, "read">;
  brief: Pick<DraftingBrief, "source">;
  /** Exact saved theme proposal result for this post. */
  themes: ArtifactRef;
  sourceContext?: ArtifactRef;
  /** Optional librarian mapping from proposal ID to canonical theme ID. */
  canonicalMapping?: ReadonlyMap<string, string>;
  maxSourceChars?: number;
}): Promise<PinnedContextOutcome> {
  const a = input.brief.source.artifact;
  const sourceRef: ArtifactRef = {
    repository: a.repository,
    commit: a.commit,
    path: a.path,
    sha256: a.hash.replace(/^sha256:/, ""),
  };
  let text: string;
  let provenance: SourceContext;
  try {
    // read() verifies the commit, path and content hash.
    const record = CollectionRecordSchema.parse(JSON.parse(await input.archive.read(sourceRef)));
    // An incomplete capture is not the whole post; never present it as one.
    if (!record.complete) return { kind: "incomplete-source" };
    text = record.text;
    provenance = input.sourceContext
      ? SourceContextSchema.parse(JSON.parse(await input.content.read(input.sourceContext)))
      : sourceContextFor(record, sourceRef);
    if (
      !sourceContextMatches(provenance, sourceRef, input.brief.source.sourceVersion) ||
      provenance.source.id !== input.brief.source.publicationId ||
      provenance.source.postId !== input.brief.source.postId ||
      provenance.source.url !== record.item.url
    )
      return { kind: "source-context-mismatch" };
  } catch {
    return { kind: "unreadable", what: "source" };
  }
  if (sourceVersionFor(text) !== input.brief.source.sourceVersion)
    return { kind: "source-mismatch" };
  const maxChars = input.maxSourceChars ?? DEFAULT_MAX_SOURCE_CHARS;
  // Never silently truncate and call the summary complete.
  if (text.length > maxChars) return { kind: "source-too-large", chars: text.length, maxChars };

  let proposals: PinnedTheme[];
  try {
    const result = parseThemeProposalResult(JSON.parse(await input.content.read(input.themes)));
    if (
      result.sourceVersion !== input.brief.source.sourceVersion ||
      result.post.publicationId !== input.brief.source.publicationId ||
      result.post.postId !== input.brief.source.postId
    ) {
      return { kind: "theme-mismatch" };
    }
    proposals = result.proposals.map((p) => {
      const canonicalId = input.canonicalMapping?.get(p.id);
      return {
        id: p.id,
        title: p.title,
        ...(p.description ? { description: p.description } : {}),
        ...(canonicalId ? { canonicalId } : {}),
      };
    });
  } catch {
    return { kind: "unreadable", what: "themes" };
  }

  return {
    kind: "loaded",
    context: {
      source: {
        ref: sourceRef,
        sourceVersion: input.brief.source.sourceVersion,
        text,
        provenance,
        ...(input.sourceContext ? { provenanceRef: input.sourceContext } : {}),
      },
      themes: { ref: input.themes, proposals },
      contextRef: contextRefFor(
        sourceRef,
        input.themes,
        new Map(
          proposals
            .filter((p) => p.canonicalId)
            .map((p) => [p.id, p.canonicalId!] as [string, string]),
        ),
        sourceContextVersion(provenance),
        input.sourceContext,
      ),
    },
  };
}

/**
 * True when the context was loaded from exactly the source artifact the brief
 * names. Text-version equality alone is not enough: identical text in two
 * posts or capture revisions shares a version but not an artifact.
 */
export function contextMatchesBrief(
  context: PinnedContext,
  brief: Pick<DraftingBrief, "source">,
): boolean {
  const a = brief.source.artifact;
  const r = context.source.ref;
  return (
    context.source.sourceVersion === brief.source.sourceVersion &&
    r.repository === a.repository &&
    r.commit === a.commit &&
    r.path === a.path &&
    `sha256:${r.sha256}` === a.hash
  );
}

/** The context as the model sees it: fenced data, source separate from research. */
export function contextForModel(context: PinnedContext) {
  return {
    originalPost: {
      note: "The original post's full text. It is the monitored source, not evidence: never use it to confirm its own statements.",
      text: context.source.text,
      sourceContext: context.source.provenance,
    },
    themes: context.themes.proposals.map((t) => ({
      title: t.title,
      ...(t.description ? { description: t.description } : {}),
      ...(t.canonicalId ? { canonicalTheme: t.canonicalId } : {}),
    })),
  };
}
