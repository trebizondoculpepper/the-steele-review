import type { ArtifactRef } from "../controllers/artifact-store.js";
/** Per-invocation lineage: never mutable state on a shared model client. */
export interface EditorialLineage {
  intent: ArtifactRef;
  parentSummary: ArtifactRef;
}
export const editorialLineageRefs = (lineage?: EditorialLineage): ArtifactRef[] =>
  lineage ? [lineage.intent, lineage.parentSummary] : [];
