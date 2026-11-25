import { readFileSync } from "node:fs";
import { Mastra } from "@mastra/core/mastra";
import { SimpleAuth } from "@mastra/core/server";
import { LibSQLStore } from "@mastra/libsql";
import { PinoLogger } from "@mastra/loggers";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { helloWorkflow } from "./workflows/hello.js";

/**
 * Mastra track of the n8n versus Mastra experiment (#911, #918).
 *
 * Configuration comes from the environment, which the private deployment
 * supplies. No values are baked into the image:
 * - STEELE_EXP_MASTRA_DB: LibSQL URL of the persistent store (default: a local
 *   file for development). Workflow snapshots, run history and traces live here.
 * - STEELE_EXP_MASTRA_TOKEN_FILE: path of a read-only mounted file holding the
 *   access token for the API and Studio. If it is unset, the server refuses
 *   to start unless STEELE_EXP_MASTRA_INSECURE_DEV=1 is set for local work.
 */

const insecureDev = process.env.STEELE_EXP_MASTRA_INSECURE_DEV === "1";
const tokenFile = process.env.STEELE_EXP_MASTRA_TOKEN_FILE;
if (!tokenFile && !insecureDev)
  throw new Error("STEELE_EXP_MASTRA_TOKEN_FILE is required (set STEELE_EXP_MASTRA_INSECURE_DEV=1 only for local development)");

const OWNER = { id: "owner", name: "Owner" };

/** The current token, read from the mounted file at every check; undefined (deny) if unreadable or too short. */
function currentToken(): string | undefined {
  try {
    const token = readFileSync(tokenFile!, "utf8").trim();
    return token.length >= 32 ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * SimpleAuth whose token map is read from the mounted file on every lookup,
 * so rotating or removing the token applies to the next request, including
 * existing Studio session cookies, without a restart.
 */
class RotatingTokenAuth extends SimpleAuth<typeof OWNER> {
  constructor() {
    const tokens = new Proxy({} as Record<string, typeof OWNER>, {
      get: (_t, key) => {
        const token = currentToken();
        return token !== undefined && key === token ? OWNER : undefined;
      },
    });
    super({ tokens });
  }
  override async authorizeUser(user: typeof OWNER) {
    return currentToken() !== undefined && user?.id === OWNER.id;
  }
  override async getUser(userId: string) {
    return userId === OWNER.id ? OWNER : null;
  }
}

if (tokenFile && currentToken() === undefined) throw new Error("access token file is unreadable or too short (minimum 32 characters)");
const auth = tokenFile ? new RotatingTokenAuth() : undefined;

export const mastra = new Mastra({
  workflows: { hello: helloWorkflow },
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
    ...(auth ? { auth } : {}),
  },
  ...(auth ? { studio: { auth } } : {}),
});
