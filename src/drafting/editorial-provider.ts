import type { ExtractionModelProvider } from "../analysis/extraction.js";
import type { ArtifactReference } from "../content/artifact-reference.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { ModelProviderError } from "../controllers/openrouter.js";
import {
  captureWriterAttempt,
  WriterAttemptError,
  type CapturedWriterAttempt,
} from "./writer-attempts.js";

/** Reuse the existing retained-call controller path, with distinct editorial purpose and artifacts. */
export function durableEditorialProvider(input: {
  content: GitArtifactStore;
  operations: OperationStore;
  provider: ExtractionModelProvider;
  purpose: "assessor" | "judge";
  package: ArtifactRef;
  source: ArtifactReference;
  context: ArtifactReference[];
  promptVersion: string;
  recoveryId?: string;
}): ExtractionModelProvider & { retainedAttempts(): ArtifactReference[] } {
  const retained: ArtifactReference[] = [];
  return {
    retainedAttempts: () => [...retained],
    modelVersion: input.provider.modelVersion,
    async complete(request, signal) {
      let captured: CapturedWriterAttempt;
      try {
        captured = await captureWriterAttempt({
          ...input,
          request,
          kind: "initial",
          number: 1,
          signal,
        });
      } catch (error) {
        if (error instanceof WriterAttemptError && error.artifact)
          retained.push({
            repository: error.artifact.repository,
            commit: error.artifact.commit,
            path: error.artifact.path,
            hash: `sha256:${error.artifact.sha256}`,
          });
        throw error;
      }
      retained.push({
        repository: captured.ref.repository,
        commit: captured.ref.commit,
        path: captured.ref.path,
        hash: `sha256:${captured.ref.sha256}`,
      });
      if (captured.manifest.failure)
        throw new ModelProviderError(
          captured.manifest.failure === "interrupted" ? "unavailable" : captured.manifest.failure,
        );
      if (captured.text === undefined || captured.manifest.completion.stopReason === "length-limit")
        throw new ModelProviderError("bad-response");
      return captured.text;
    },
  };
}
