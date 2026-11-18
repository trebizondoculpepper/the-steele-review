import { createServer } from "node:http";
import { ElasticsearchController } from "./controllers/elasticsearch.js";
import { NatsController } from "./controllers/nats.js";

const elasticsearchUrl = process.env.ELASTICSEARCH_URL;
const natsUrl = process.env.NATS_URL;
if (!elasticsearchUrl || !natsUrl) {
  console.error("ELASTICSEARCH_URL and NATS_URL are required");
  process.exit(1);
}

const elasticsearch = new ElasticsearchController(
  elasticsearchUrl,
  process.env.ELASTICSEARCH_API_KEY,
);
const nats = new NatsController(natsUrl, process.env.NATS_TOKEN);
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
