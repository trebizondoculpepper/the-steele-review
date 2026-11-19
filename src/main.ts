import { createServer } from "node:http";
import {
  describeSetupError,
  elasticsearchConnection,
  natsConnection,
  type ElasticsearchConnection,
  type NatsConnection,
} from "./config/credentials.js";
import { ElasticsearchController } from "./controllers/elasticsearch.js";
import { NatsController } from "./controllers/nats.js";

let esConn: ElasticsearchConnection;
let natsConn: NatsConnection;
try {
  esConn = elasticsearchConnection();
  natsConn = natsConnection();
} catch (error) {
  console.error(`connectivity: ${describeSetupError(error)}`);
  process.exit(1);
}

const elasticsearch = new ElasticsearchController(esConn.url, esConn.apiKey);
const nats = new NatsController(natsConn.url, natsConn.token);
let report = { ready: false, elasticsearch: "pending", nats: "pending" };
let checking = false;

async function check(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const results = await Promise.allSettled([elasticsearch.check(), nats.check()]);
    report = {
      ready: results.every((result) => result.status === "fulfilled"),
      elasticsearch: results[0].status === "fulfilled" ? "connected" : "failed",
      nats: results[1].status === "fulfilled" ? "connected" : "failed",
    };
    // Never log client errors: they may contain credentials or private endpoints.
    console.log(JSON.stringify({ event: "connectivity", ...report }));
  } finally {
    checking = false;
  }
}

const server = createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(report.ready ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify(report));
});
server.listen(3000, "0.0.0.0");
void check();
const timer = setInterval(() => void check(), 30000);

async function shutdown(): Promise<void> {
  clearInterval(timer);
  server.close();
  await elasticsearch.close();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
