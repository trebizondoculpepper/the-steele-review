/**
 * LAN-only operator dashboard (#375).
 *
 *   dashboard
 *
 * Serves the dashboard shell over HTTP. No login, by owner decision: restrict
 * exposure with the Compose port binding (STEELE_DASHBOARD_BIND), which is
 * configured privately for the home LAN.
 *
 * Configuration (environment):
 *   STEELE_DASHBOARD_PORT?   listen port inside the container (default 8090)
 */
import { z } from "zod";
import { createDashboardServer } from "../dashboard/server.js";

const env = z
  .object({ STEELE_DASHBOARD_PORT: z.coerce.number().int().min(1).max(65_535).default(8090) })
  .safeParse(process.env);
if (!env.success) {
  console.error("dashboard: invalid STEELE_DASHBOARD_PORT");
  process.exit(2);
}

const server = createDashboardServer();
server.listen(env.data.STEELE_DASHBOARD_PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "dashboard", state: "serving" }));
});
const stop = () => server.close(() => process.exit(0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
