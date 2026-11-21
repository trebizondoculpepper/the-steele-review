import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { NatsController } from "../controllers/nats.js";
import {
  provisionDiscoveryStream,
  provisionDurableConsumer,
} from "../controllers/nats-provision.js";
import { ARTICLE_APPROVED_SUBJECT, PUBLICATION_STREAM } from "../events/article-approved-event.js";
import { CAPTURED_CONTENT_SUBJECT } from "../events/captured-content-event.js";
import { CAPTURE_BRIDGE_MAX_DELIVER } from "../workflow/captured-bridge.js";

async function main(): Promise<number> {
  if (
    process.env.STEELE_FIXTURE_DEPLOYMENT !== "1" ||
    process.env.NATS_URL !== "nats://fixture-nats:4222"
  ) {
    console.error("provision-article-fixture: requires isolated fixture deployment");
    return 2;
  }
  const broker = new NatsController(process.env.NATS_URL);
  try {
    for (const directory of ["/data/archive", "/data/content", "/data/state"]) {
      await mkdir(directory, { recursive: true });
    }
    await new GitArtifactStore({
      repoPath: "/data/archive",
      repository: "fixture-archive",
    }).initialise();
    await new GitArtifactStore({
      repoPath: "/data/content",
      repository: "fixture-content",
    }).initialise();

    for (let i = 0; ; i++) {
      try {
        await broker.connect("steele-fixture-init");
        break;
      } catch (error) {
        if (i === 19) throw error;
        await delay(500);
      }
    }

    const contentStream = "STEELE_CONTENT";
    await provisionDiscoveryStream(broker, {
      name: contentStream,
      subjects: [CAPTURED_CONTENT_SUBJECT],
    });
    await provisionDiscoveryStream(broker, {
      name: PUBLICATION_STREAM,
      subjects: [ARTICLE_APPROVED_SUBJECT],
    });
    await provisionDurableConsumer(broker, {
      stream: contentStream,
      name: "fixture-bridge",
      filterSubject: CAPTURED_CONTENT_SUBJECT,
      newOnly: true,
      maxDeliver: CAPTURE_BRIDGE_MAX_DELIVER,
    });
    for (const name of ["fixture-publisher-a", "fixture-publisher-b"]) {
      await provisionDurableConsumer(broker, {
        stream: PUBLICATION_STREAM,
        name,
        filterSubject: ARTICLE_APPROVED_SUBJECT,
        maxDeliver: 300,
      });
    }
    console.log("article fixture archive and broker provisioned");
    return 0;
  } catch {
    console.error("provision-article-fixture: provisioning failed");
    return 1;
  } finally {
    await broker.close().catch(() => undefined);
  }
}

process.exitCode = await main();
