import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { PinoLogger } from "@mastra/loggers";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { helloWorkflow } from "./workflows/hello.js";
import { feedStatusWorkflow, pollFeedWorkflow, selectFeedItemWorkflow } from "./workflows/feed.js";
import {
  captureSourceWorkflow,
  capturePendingWorkflow,
  exportVersionWorkflow,
  importVersionWorkflow,
  listSourcesWorkflow,
  listVersionsWorkflow,
  readVersionWorkflow,
} from "./workflows/capture.js";

/**
 * Mastra track of the n8n versus Mastra experiment (#911, #918).
 *
 * Access: by owner decision (#930), Studio and the API need no login. The
 * only access control is the deployment's network boundary: the server is
 * published on the private network interface only (deploy/compose.yaml).
 * Never publish this port on a LAN, public or tunnelled interface.
 *
 * Configuration comes from the environment, which the private deployment
 * supplies. No values are baked into the image:
 * - STEELE_EXP_MASTRA_DB: LibSQL URL of the persistent store (default: a local
 *   file for development). Workflow snapshots, run history and traces live here.
 */

export const mastra = new Mastra({
  workflows: {
    hello: helloWorkflow,
    "poll-feed": pollFeedWorkflow,
    "select-feed-item": selectFeedItemWorkflow,
    "feed-status": feedStatusWorkflow,
    "capture-source": captureSourceWorkflow,
    "capture-pending": capturePendingWorkflow,
    "list-sources": listSourcesWorkflow,
    "list-versions": listVersionsWorkflow,
    "read-version": readVersionWorkflow,
    "export-version": exportVersionWorkflow,
    "import-version": importVersionWorkflow,
  },
  storage: new LibSQLStore({
    id: "steele-exp-mastra",
    url: process.env.STEELE_EXP_MASTRA_DB ?? "file:./.data/mastra.db",
  }),
  logger: new PinoLogger({ name: "steele-exp-mastra", level: "info" }),
  observability: new Observability({
    configs: {
      default: { serviceName: "steele-exp-mastra", exporters: [new MastraStorageExporter()] },
    },
  }),
  server: {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 4111),
  },
});
