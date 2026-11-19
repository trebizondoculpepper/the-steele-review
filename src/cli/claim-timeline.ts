/**
 * Claim timeline report: query the claim-occurrence index and print the
 * observed timeline and speaker frequency for one claim, grouping or theme.
 * Composition only; logic lives in analysis/claim-timeline.ts.
 *
 * Usage:
 *   claim-timeline (--statement TEXT | --grouping-key KEY | --claim-id ID | --theme T)
 *                  [--publication ID] [--speaker NAME] [--speaker-kind KIND]
 *                  [--from ISO] [--to ISO] [--bucket month|year] [--limit N] [--json]
 *
 * Configuration (environment):
 *   ELASTICSEARCH_URL, ELASTICSEARCH_API_KEY?
 *   STEELE_CLAIM_OCCURRENCE_INDEX?    logical index (alias); defaults to steele-claim-occurrences-v1
 */
import { describeSetupError, elasticsearchConnection } from "../config/credentials.js";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  queryClaimTimeline,
  renderTimelineReport,
  TimelineFilterSchema,
} from "../analysis/claim-timeline.js";
import { CLAIM_OCCURRENCE_INDEX_V1 } from "../analysis/claim-occurrence.js";
import { ElasticsearchController } from "../controllers/elasticsearch.js";

export async function main(argv: string[]): Promise<number> {
  let filter;
  let json = false;
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        statement: { type: "string" },
        "grouping-key": { type: "string" },
        "claim-id": { type: "string" },
        theme: { type: "string" },
        publication: { type: "string" },
        speaker: { type: "string" },
        "speaker-kind": { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        bucket: { type: "string" },
        limit: { type: "string" },
        json: { type: "boolean" },
      },
    });
    json = values.json ?? false;
    filter = TimelineFilterSchema.parse({
      ...(values.statement ? { statement: values.statement } : {}),
      ...(values["grouping-key"] ? { groupingKey: values["grouping-key"] } : {}),
      ...(values["claim-id"] ? { claimId: values["claim-id"] } : {}),
      ...(values.theme ? { theme: values.theme } : {}),
      ...(values.publication ? { publicationId: values.publication } : {}),
      ...(values.speaker ? { speakerName: values.speaker } : {}),
      ...(values["speaker-kind"] ? { speakerKind: values["speaker-kind"] } : {}),
      ...(values.from ? { from: values.from } : {}),
      ...(values.to ? { to: values.to } : {}),
      ...(values.bucket ? { bucket: values.bucket } : {}),
      ...(values.limit ? { limit: Number(values.limit) } : {}),
    });
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues.map((i) => i.message).join("; ") : String(error);
    console.error(`claim-timeline: ${message}`);
    return 2;
  }
  let esConn;
  try {
    esConn = elasticsearchConnection();
  } catch (error) {
    console.error(`claim-timeline: ${describeSetupError(error)}`);
    return 2;
  }

  let es: ElasticsearchController;
  try {
    es = new ElasticsearchController(esConn.url, esConn.apiKey);
  } catch {
    // Never echo the configured URL: it may carry credentials.
    console.error("claim-timeline: ELASTICSEARCH_URL is not a valid URL");
    return 2;
  }
  try {
    const timeline = await queryClaimTimeline(
      es,
      filter,
      process.env.STEELE_CLAIM_OCCURRENCE_INDEX || CLAIM_OCCURRENCE_INDEX_V1,
    );
    console.log(json ? JSON.stringify(timeline, null, 2) : renderTimelineReport(timeline));
    return 0;
  } catch {
    console.error("claim-timeline: query failed");
    return 1;
  } finally {
    await es.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
