import { serve } from "@restatedev/restate-sdk";
import { z } from "zod";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { OperationStore } from "../controllers/operation-store.js";
import {
  FIXTURE_HOST,
  FIXTURE_PUBLICATION,
  fixtureProviders,
} from "../workflow/article-fixture.js";
import { articleRunWorkflow, researchService, StageError } from "../workflow/article-run.js";
import { articleStages } from "../workflow/stages.js";

const Env = z.object({
  STEELE_FIXTURE_DEPLOYMENT: z.literal("1"),
  STEELE_ARCHIVE_PATH: z.string().min(1),
  STEELE_ARCHIVE_REPOSITORY: z.literal("fixture-archive"),
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.literal("fixture-content"),
  STEELE_STATE_PATH: z.string().min(1),
  STEELE_ARTICLE_WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(9080),
});

function main(): number {
  const config = Env.safeParse(process.env);
  if (!config.success || process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY_FILE) {
    console.error("article-fixture-worker: requires isolated fixture configuration");
    return 2;
  }
  const c = config.data;
  const stages = articleStages({
    archive: new GitArtifactStore({
      repoPath: c.STEELE_ARCHIVE_PATH,
      repository: c.STEELE_ARCHIVE_REPOSITORY,
    }),
    content: new GitArtifactStore({
      repoPath: c.STEELE_CONTENT_PATH,
      repository: c.STEELE_CONTENT_REPOSITORY,
    }),
    operations: new OperationStore({ path: c.STEELE_STATE_PATH }),
    ...fixtureProviders(),
    owner: "article-fixture-worker",
  });
  serve({
    port: c.STEELE_ARTICLE_WORKER_PORT,
    services: [
      articleRunWorkflow({
        ...stages,
        themes: (input) => {
          if (
            input.publicationId !== FIXTURE_PUBLICATION ||
            input.source?.namespace !== `substack/${FIXTURE_PUBLICATION}` ||
            input.source.artifact.repository !== c.STEELE_ARCHIVE_REPOSITORY ||
            new URL(input.sourceUrl).hostname !== FIXTURE_HOST
          )
            throw new StageError("source", "not-fixture");
          return stages.themes(input);
        },
      }),
      researchService(stages),
    ],
  });
  return 0;
}

process.exitCode = main();
