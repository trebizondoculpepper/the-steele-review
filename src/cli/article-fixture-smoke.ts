import { readPublicationPayload } from "../drafting/publication-payload.js";
import { setTimeout as delay } from "node:timers/promises";
import { connect, HttpCallError, rpc } from "@restatedev/restate-sdk-clients";
import { z } from "zod";
import { collectionArtifactPath, CollectionRecordSchema } from "../collection/collection-store.js";
import { natsConnection } from "../config/credentials.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { NatsController } from "../controllers/nats.js";
import { PackageVerificationReportSchema, approvalValidFor } from "../drafting/package-verify.js";
import {
  CAPTURED_CONTENT_SUBJECT,
  createCapturedContentEvent,
  substackCapturedContent,
} from "../events/captured-content-event.js";
import { approvedArticleEventId, readDummyDeliveryProof } from "../publishing/approved-article.js";
import { FIXTURE_HOST, FIXTURE_PUBLICATION, FIXTURE_TEXT } from "../workflow/article-fixture.js";
import { articleRunKey, articleRunResult, type ArticleRunApi } from "../workflow/article-run.js";

const Env = z.object({
  STEELE_FIXTURE_DEPLOYMENT: z.literal("1"),
  STEELE_ARCHIVE_PATH: z.string().min(1),
  STEELE_ARCHIVE_REPOSITORY: z.literal("fixture-archive"),
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.literal("fixture-content"),
  STEELE_CONTENT_STREAM: z.string().min(1),
  RESTATE_INGRESS_URL: z.url({ protocol: /^https?$/ }),
  STEELE_FIXTURE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
});

async function main(): Promise<number> {
  const config = Env.safeParse(process.env);
  const [postId] = process.argv.slice(2);
  if (!config.success || process.argv.length !== 3 || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(postId)) {
    console.error(
      "Usage: article-fixture-smoke <synthetic-post-id> with fixture deployment configuration",
    );
    return 2;
  }

  const c = config.data;
  const post = { publicationId: FIXTURE_PUBLICATION, postId };
  const archive = new GitArtifactStore({
    repoPath: c.STEELE_ARCHIVE_PATH,
    repository: c.STEELE_ARCHIVE_REPOSITORY,
  });
  const content = new GitArtifactStore({
    repoPath: c.STEELE_CONTENT_PATH,
    repository: c.STEELE_CONTENT_REPOSITORY,
  });
  const signal = AbortSignal.timeout(c.STEELE_FIXTURE_TIMEOUT_MS);
  let stage = "load-fixture";
  let nats: NatsController | undefined;
  try {
    const url = `https://${FIXTURE_HOST}/p/${postId}`;
    const path = collectionArtifactPath(post);
    const ref =
      (await archive.lookup(path)) ??
      (await archive.write(
        path,
        JSON.stringify({
          item: { ...post, url, title: "Synthetic fixture" },
          ingestionReason: "live",
          text: FIXTURE_TEXT,
          complete: true,
          supplied: {},
          provenance: {
            sourceUrl: url,
            acquiredAt: new Date().toISOString(),
            method: "article-html",
          },
        }),
      ));
    const record = CollectionRecordSchema.parse(JSON.parse(await archive.read(ref)));
    if (
      record.item.publicationId !== post.publicationId ||
      record.item.postId !== post.postId ||
      record.item.url !== url ||
      record.text !== FIXTURE_TEXT ||
      !record.complete ||
      record.ingestionReason !== "live"
    )
      throw new Error("invalid fixture");

    const sourceVersion = sourceVersionFor(record.text);
    const key = articleRunKey({ ...post, sourceVersion });
    const workflow = connect({ url: c.RESTATE_INGRESS_URL }).workflowClient<ArticleRunApi>(
      { name: "ArticleRun" },
      key,
    );
    const event = createCapturedContentEvent(
      substackCapturedContent({
        artifact: {
          repository: ref.repository,
          commit: ref.commit,
          path: ref.path,
          hash: `sha256:${ref.sha256}`,
        },
        record,
        sourceVersion,
      }),
    );

    stage = "require-fresh-fixture";
    try {
      await workflow.workflowOutput(rpc.opts({ signal }));
      throw new Error("fixture workflow already exists");
    } catch (error) {
      if (!(error instanceof HttpCallError) || error.status !== 404) throw error;
    }

    stage = "publish-capture";
    const credentials = natsConnection();
    nats = new NatsController(credentials.url, credentials.token);
    await nats.connect("steele-article-fixture-smoke");
    const encoder = new TextEncoder();
    await nats.publish(CAPTURED_CONTENT_SUBJECT, encoder.encode(JSON.stringify(event.toJSON())), {
      msgId: event.id,
      expectStream: c.STEELE_CONTENT_STREAM,
      signal,
    });

    stage = "await-verified-workflow";
    // The broker ack precedes bridge submission. Retry a missing invocation only.
    const attach = async () => {
      for (;;) {
        try {
          return await articleRunResult(
            () => Promise.resolve(workflow.workflowAttach(rpc.opts({ signal }))),
            () => Promise.resolve(workflow.final(rpc.opts({ signal }))),
          );
        } catch (error) {
          if (!(error instanceof HttpCallError) || error.status !== 404) throw error;
          await delay(500, undefined, { signal });
        }
      }
    };
    const result = await attach();
    if (
      result.outcome !== "verified" ||
      !result.draft ||
      !result.verification ||
      !result.approvalEvent
    )
      throw new Error("workflow did not produce a verified draft with approval");

    stage = "validate-approval";
    const report = PackageVerificationReportSchema.parse(
      JSON.parse(await content.read(result.verification)),
    );
    const draftHash = `sha256:${result.draft.sha256}`;
    if (
      report.draft.hash !== draftHash ||
      result.approvalEvent !== approvedArticleEventId(result.draft, result.verification) ||
      !approvalValidFor(
        report,
        await content.read(result.draft),
        report.schemaVersion === 2
          ? {
              ref: report.publication,
              ...(await readPublicationPayload(content, report.publication)),
            }
          : undefined,
      )
    )
      throw new Error("approval mismatch");

    stage = "await-dummy-receipts";
    const approved = {
      ...post,
      draft: report.draft,
      approval: {
        repository: result.verification.repository,
        commit: result.verification.commit,
        path: result.verification.path,
        hash: `sha256:${result.verification.sha256}`,
      },
      package: report.package,
      approvedAt: report.verifiedAt,
    };
    for (;;) {
      signal.throwIfAborted();
      const receipts = await readDummyDeliveryProof(content, approved);
      if (receipts) {
        console.log(
          JSON.stringify({
            event: "article-fixture-smoke",
            outcome: "passed",
            captureEvent: event.id,
            workflowKey: key,
            approvalEvent: result.approvalEvent,
            draftHash,
            receipts: { a: receipts.a.sha256, b: receipts.b.sha256 },
          }),
        );
        return 0;
      }
      await delay(1_000, undefined, { signal });
    }
  } catch {
    console.error(
      JSON.stringify({
        event: "article-fixture-smoke",
        outcome: signal.aborted ? "timed-out" : "failed",
        stage,
      }),
    );
    return 1;
  } finally {
    await nats?.close().catch(() => undefined);
  }
}

process.exitCode = await main();
