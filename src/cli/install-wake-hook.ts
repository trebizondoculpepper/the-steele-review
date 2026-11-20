/**
 * Install the Git wake hook for the research index worker (#251).
 *
 *   install-wake-hook
 *
 * Adds a `reference-transaction` hook to the content repository that, on a
 * committed update to the configured branch only, touches a wake file the
 * worker watches. The worker's periodic reconciliation remains the fallback,
 * so a missed or coalesced signal loses nothing. An existing hook that is not
 * ours is left untouched and reported.
 *
 * Configuration (environment): STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY
 */
import { z } from "zod";
import { GitArtifactStore } from "../controllers/artifact-store.js";

const Env = z.object({
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
});

async function main(): Promise<number> {
  if (process.argv.slice(2).some((a) => a !== "--help")) {
    console.error("Usage: install-wake-hook");
    return 2;
  }
  if (process.argv.includes("--help")) {
    console.log("Usage: install-wake-hook");
    return 0;
  }
  const env = Env.safeParse(process.env);
  if (!env.success) {
    console.error(
      "install-wake-hook: STEELE_CONTENT_PATH and STEELE_CONTENT_REPOSITORY are required",
    );
    return 2;
  }
  const store = new GitArtifactStore({
    repoPath: env.data.STEELE_CONTENT_PATH,
    repository: env.data.STEELE_CONTENT_REPOSITORY,
  });
  let outcome;
  try {
    outcome = await store.installWakeHook();
  } catch {
    // Never echo Git or filesystem errors: they can carry private paths.
    console.error(JSON.stringify({ event: "install-wake-hook", outcome: "failed" }));
    return 1;
  }
  console.log(JSON.stringify({ event: "install-wake-hook", outcome }));
  return outcome === "foreign-hook" ? 1 : 0;
}

process.exitCode = await main();
