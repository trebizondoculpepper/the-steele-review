import type { ExtractionModelProvider } from "../analysis/extraction.js";
import type { ArtifactReference } from "../content/artifact-reference.js";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import { OperationStoreError, type OperationStore } from "../controllers/operation-store.js";
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
}): ExtractionModelProvider & {
  retainedAttempts(): ArtifactReference[];
  retainedAttemptReuses(): Array<boolean | null>;
} {
  const retained: ArtifactReference[] = [];
  const reuses: Array<boolean | null> = [];
  return {
    retainedAttempts: () => [...retained],
    retainedAttemptReuses: () => [...reuses],
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
        if (error instanceof WriterAttemptError && error.artifact) {
          reuses.push(error.reused ?? null);
          retained.push({
            repository: error.artifact.repository,
            commit: error.artifact.commit,
            path: error.artifact.path,
            hash: `sha256:${error.artifact.sha256}`,
          });
        }
        throw error;
      }
      reuses.push(captured.reused);
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

/** Storage/control failures are retryable workflow work, never provider findings. */
export function rethrowEditorialStorageError(error: unknown): void {
  if (
    (error instanceof WriterAttemptError &&
      (error.code === "archive-failed" || error.code === "busy")) ||
    error instanceof ArtifactStoreError ||
    error instanceof OperationStoreError
  )
    throw error;
}
