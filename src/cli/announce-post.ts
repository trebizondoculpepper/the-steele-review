/**
 * Manual command (#178): record, and optionally publish, one post-analysed
 * completion event after theme proposals and claims are saved for a post.
 *
 *   announce-post --post-id <slug> [--claim-result <repository path>] [--publish] [--json]
 *
 * Picks the post's schema-v2 claim-extraction result (or the one given) and
 * the theme-proposal result it links to, validates they describe the same
 * post and source version, and records the event in the analysis state
 * outbox. With --publish the event is then sent to the configured broker;
 * the record is written first, so a broker outage leaves a durable pending
 * event rather than losing the handoff. Re-running is safe: one input
 * version yields one logical completion.
 *
 * Configuration (environment):
 *   STEELE_PUBLICATION_ID
 *   STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY   private content repository (read only)
 *   STEELE_ANALYSIS_STATE_PATH                       analysis outbox (never the collector's state file)
 *   NATS_URL, NATS_TOKEN[_FILE]                      only with --publish
 *
 * Exit: 0 recorded with delivery sent (or pending when --publish was not
 * requested); 1 refused, busy, exhausted, or recorded but not published;
 * 2 usage/config.
 */
import { hostname } from "node:os";
import { z } from "zod";
import { announcePost, publishRecordedEvent } from "../analysis/announce.js";
import { ClaimExtractionRecordSchema } from "../analysis/grounded-claims.js";
import { CredentialError, describeSetupError, natsConnection } from "../config/credentials.js";
import { GitArtifactStore, type ArtifactRef } from "../controllers/artifact-store.js";
import { NatsController } from "../controllers/nats.js";
import { OperationStore } from "../controllers/operation-store.js";

const USAGE =
  "Usage: announce-post --post-id <slug> [--claim-result <repository path>] [--publish] [--json]";
const EnvSchema = z.object({
  STEELE_PUBLICATION_ID: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
  STEELE_ANALYSIS_STATE_PATH: z.string().min(1),
});

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  let postId: string | undefined;
  let claimPath: string | undefined;
  let publish = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === "--publish") publish = true;
    else if (argv[i] === "--json") json = true;
    else if (argv[i] === "--post-id" && v && /^[a-z0-9][a-z0-9-]{0,299}$/.test(v)) {
      postId = v;
      i++;
    } else if (
      argv[i] === "--claim-result" &&
      v &&
      /^claim-extractions\/[A-Za-z0-9/._-]+\.json$/.test(v)
    ) {
      claimPath = v;
      i++;
    } else {
      console.error(USAGE);
      return 2;
    }
  }
  if (!postId) {
    console.error(USAGE);
    return 2;
  }
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`announce-post: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const c = env.data;
  let nats: NatsController | undefined;
  const post = { publicationId: c.STEELE_PUBLICATION_ID, postId };
  const report = (fields: Record<string, unknown>) =>
    console.log(
      json
        ? JSON.stringify({ event: "post-analysed", ...post, ...fields })
        : Object.entries({ ...post, ...fields })
            .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
            .join("\n"),
    );
  const content = new GitArtifactStore({
    repoPath: c.STEELE_CONTENT_PATH,
    repository: c.STEELE_CONTENT_REPOSITORY,
  });
  const operations = new OperationStore({ path: c.STEELE_ANALYSIS_STATE_PATH });
  try {
    // Choose the claim result: the one given, or the post's single v2 result.
    const paths = claimPath
      ? [claimPath]
      : await content.list(`claim-extractions/${post.publicationId}/${post.postId}`, 200);
    const v2: Array<{ ref: ArtifactRef; themeResult: string }> = [];
    for (const path of paths) {
      const ref = await content.lookup(path);
      if (!ref) continue;
      try {
        const record = ClaimExtractionRecordSchema.parse(JSON.parse(await content.read(ref)));
        if (record.schemaVersion === 2 && record.themeResult)
          v2.push({ ref, themeResult: record.themeResult });
      } catch {
        // Unreadable results are skipped here; announcePost re-validates the chosen one.
      }
    }
    if (v2.length !== 1) {
      report({
        outcome: v2.length === 0 ? "no-claim-result" : "ambiguous-claim-result",
        candidates: v2.map((x) => x.ref.path),
      });
      return 1;
    }
    const chosen = v2[0];
    const sep = chosen.themeResult.indexOf(":");
    const themeRef = await content.lookup(chosen.themeResult.slice(sep + 1));
    if (!themeRef || themeRef.commit !== chosen.themeResult.slice(0, sep)) {
      // lookup() returns the commit that introduced the path; theme results are write-once.
      report({ outcome: "theme-result-not-found" });
      return 1;
    }
    // Record first: the durable handoff must survive a broker outage.
    const outcome = await announcePost({
      content,
      operations,
      post,
      themeRef,
      claimRef: chosen.ref,
      owner: `announce-post:${hostname()}:${process.pid}`,
    });
    if (outcome.status === "exhausted") {
      report({ outcome: "exhausted", eventId: outcome.eventId });
      return 1;
    }
    if (outcome.status !== "recorded") {
      report({ outcome: outcome.status === "busy" ? "busy" : outcome.reason });
      return 1;
    }
    let delivery = outcome.delivery;
    let publishFailure: string | undefined;
    if (publish && delivery === "pending") {
      try {
        const conn = natsConnection();
        nats = new NatsController(conn.url, conn.token);
        await nats.connect("steele-announce-post");
        const published = await publishRecordedEvent(operations, outcome.eventId, nats);
        // `missing` cannot occur for the ID just recorded; treat it as pending.
        delivery = published === "sent" ? "sent" : "pending";
        if (published === "missing") publishFailure = "event-missing";
      } catch (error) {
        // The event is already recorded; it stays pending for a later run.
        publishFailure =
          error instanceof CredentialError ? describeSetupError(error) : "broker-unavailable";
        delivery = "pending";
      }
    }
    report({
      outcome: "recorded",
      eventId: outcome.eventId,
      newlyRecorded: outcome.newlyRecorded,
      delivery,
      ...(publishFailure ? { publishFailure } : {}),
      counts: outcome.data.counts,
      themeResult: `${themeRef.commit.slice(0, 12)}:${themeRef.path}`,
      claimResult: `${chosen.ref.commit.slice(0, 12)}:${chosen.ref.path}`,
    });
    return publishFailure ? 1 : 0;
  } catch (error) {
    report({ outcome: "failed", error: error instanceof Error ? error.name : "error" });
    return 1;
  } finally {
    operations.close();
    await nats?.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
