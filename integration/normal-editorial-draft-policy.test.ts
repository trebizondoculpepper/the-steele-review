/** Isolated Restate/NATS/Git integration; every model and destination transport is synthetic. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vite-plus/test";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { GitArtifactStore } from "../src/controllers/artifact-store.js";
import { OperationStore } from "../src/controllers/operation-store.js";
import { NatsController } from "../src/controllers/nats.js";
import {
  provisionDiscoveryStream,
  provisionDurableConsumer,
} from "../src/controllers/nats-provision.js";
import { articleStages } from "../src/workflow/stages.js";
import {
  articleRunWorkflow,
  researchService,
  type ArticleRunResult,
} from "../src/workflow/article-run.js";
import { liveEditorialInput, recordArticleAttempt } from "../src/workflow/article-attempt.js";
import { artifactRef } from "../src/drafting/publication-payload.js";
import {
  continuationParentFixture,
  REVISE,
} from "../test/workflow/editorial-continuation-fixtures.js";
import { WRITER } from "../test/publishing/approval-fixtures.js";
import { LexicalShortlister } from "../src/research/librarian.js";
import { ARTICLE_APPROVED_SUBJECT } from "../src/events/article-approved-event.js";
import { dispatchApprovedArticles } from "../src/publishing/approval-dispatch.js";
import {
  SimulatedDestination,
  readDummyDeliveryProof,
} from "../src/publishing/approved-article.js";
import {
  runPublisherService,
  type SelectedPublisherResult,
} from "../src/publishing/publisher-service.js";
import { runSelectedPublisher } from "../src/publishing/selected-publisher.js";
import { localDraftDestination } from "../test/publishing/draft-destination-fixture.js";
import { substackDraftOriginIdentity } from "../src/publishing/substack/client.js";
import { draftDeliveryConfiguration } from "../src/publishing/draft-delivery-configuration.js";
it(
  "keeps legacy journals distinct and recovers a normal one-revision draft authorization through real NATS",
  { timeout: 300000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "normal-editorial-policy-"));
    const content = new GitArtifactStore({ repoPath: dir, repository: "content" });
    await content.initialise();
    const operations = new OperationStore({ path: join(dir, "state.sqlite") });
    let env: RestateTestEnvironment | undefined,
      server: StartedTestContainer | undefined,
      nats: NatsController | undefined;
    try {
      const parent = await continuationParentFixture(content, operations, 0, { modern: true });
      for (const [key, value] of Object.entries({
        STEELE_EDITORIAL_MAX_REVISIONS: "1",
        STEELE_EDITORIAL_DEADLINE_MS: "120000",
        STEELE_EDITORIAL_EXHAUSTION_ACTION: "create-unpublished-draft",
        STEELE_SUBSTACK_ORIGIN: "https://publication.example",
        STEELE_SUBSTACK_BYLINE_ID: "",
        STEELE_DRAFT_SUBSTACK_DESTINATION: "substack",
        STEELE_CONFIG_PATH: "",
      }))
        vi.stubEnv(key, value);
      let interrupted = false;
      const state = new Proxy(operations, {
        get(target, key) {
          if (key === "completeOwnerDraftAuthorization")
            return (...args: Parameters<OperationStore["completeOwnerDraftAuthorization"]>) => {
              target.completeOwnerDraftAuthorization(...args);
              if (!interrupted) {
                interrupted = true;
                throw new Error("synthetic lost completion acknowledgment");
              }
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const calls = { writer: 0, assessor: 0, judge: 0, research: 0 };
      const assessor = {
        modelVersion: "synthetic/normal-assessor",
        complete: async () => {
          calls.assessor++;
          return "No faults found.\nEND OF ASSESSMENT";
        },
      };
      const writer = {
        modelVersion: "synthetic/normal-writer",
        complete: async () => {
          calls.writer++;
          return WRITER;
        },
      };
      const realStages = articleStages({
        content,
        archive: parent.archive as GitArtifactStore,
        operations: state,
        owner: "synthetic-worker",
        shortlister: new LexicalShortlister(),
        models: {
          themes: {
            modelVersion: "synthetic/unused",
            complete: async () => {
              throw new Error("no extraction dispatch");
            },
          },
          claims: {
            modelVersion: "synthetic/unused",
            complete: async () => {
              throw new Error("no extraction dispatch");
            },
          },
          writer,
          verifier: {
            modelVersion: "synthetic/normal-judge",
            complete: async () => {
              calls.judge++;
              return REVISE;
            },
          },
          assessor,
        },
        research: {
          sonar: {
            research: async () => {
              calls.research++;
              throw new Error("no discovery dispatch");
            },
          } as any,
          fetcher: {
            fetch: async () => {
              throw new Error("no retrieval dispatch");
            },
          } as any,
          judge: {
            judge: async () => {
              throw new Error("no support dispatch");
            },
          } as any,
        },
      });
      const pkg = parent.pkg;
      const stages = {
        ...realStages,
        themes: async () => artifactRef(pkg.themeResult),
        claims: async () => artifactRef(pkg.claimResult),
        liveEditorial: (...args: Parameters<NonNullable<typeof realStages.liveEditorial>>) => {
          const port = realStages.liveEditorial!(...args);
          return args[0].operatorRequestId === "live-policy-expired"
            ? { ...port, now: () => Date.now() + 600000 }
            : port;
        },
        planResearch: async () => [],
        coverage: async () => artifactRef(pkg.coverage),
        package: async () => ({ ref: parent.pkgRef, status: "ready" as const }),
      };
      const workflow = articleRunWorkflow(stages);
      env = await RestateTestEnvironment.start(
        { services: [workflow, researchService(stages)], serviceEndpointAccess: "docker-host" },
        () => new RestateContainer("1.8.1"),
      );
      const ingress = clients.connect({ url: env.baseUrl() });
      const legacyInput = {
        ...parent.summary.input,
        editorial: { version: "assess-judge-v1" as const, maxRevisions: 0, deadlineMs: 120000 },
      };
      const legacy = await ingress
        .workflowClient(workflow, "legacy-policy-fixture")
        .run(legacyInput);
      expect(legacy.outcome).toBe("rejected");
      expect(legacy.editorial?.policyObservations).toBeUndefined();
      expect(legacy.draftAuthorizationEvent).toBeUndefined();
      const before = { ...calls };
      const normal = recordArticleAttempt(
        operations,
        liveEditorialInput(parent.summary.input),
        "normal-live-policy-once",
      );
      const result = (await ingress
        .workflowClient(workflow, normal.identity.workflowKey)
        .run(normal.input)) as ArticleRunResult;
      expect(result.outcome).toBe("drafted-unverified");
      expect(result.authorizationOutcome).toBe("owner-authorized-draft");
      expect(result.editorial?.terminal).toBe("unresolved");
      expect(result.editorial?.revisions).toHaveLength(1);
      expect(result.editorial?.revisionAttempts).toBe(1);
      // Initial exact-input captures are reusable across the legacy and new attempt.
      // Both new review records exist, but only the changed revision needs new model work.
      expect(result.editorial?.assessments).toHaveLength(2);
      expect(result.editorial?.judgments).toHaveLength(2);
      expect(calls.assessor - before.assessor).toBe(1);
      expect(calls.judge - before.judge).toBe(1);
      expect(calls.research).toBe(0);
      expect(interrupted).toBe(true);
      const after = { ...calls };
      vi.stubEnv("STEELE_EDITORIAL_MAX_REVISIONS", "0");
      vi.stubEnv("STEELE_EDITORIAL_EXHAUSTION_ACTION", "stop");
      expect(
        await ingress.workflowClient(workflow, normal.identity.workflowKey).workflowAttach(),
      ).toEqual(result);
      expect(calls).toEqual(after);
      const eventId = result.draftAuthorizationEvent!;
      const pending = operations.pendingEvent(eventId)!;
      expect(JSON.parse(pending.payload).type).toBe("org.steele.article.draft-authorized.v2");
      vi.stubEnv("STEELE_EDITORIAL_EXHAUSTION_ACTION", "create-unpublished-draft");
      const deliveryControl = draftDeliveryConfiguration().control;
      server = await new GenericContainer("nats:2.10.22")
        .withCommand(["-js"])
        .withExposedPorts(4222)
        .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
        .start();
      nats = new NatsController(`nats://${server.getHost()}:${server.getMappedPort(4222)}`);
      await nats.connect("normal-policy-integration");
      const stream = "NORMAL_POLICY_TEST";
      await provisionDiscoveryStream(nats, { name: stream, subjects: [ARTICLE_APPROVED_SUBJECT] });
      expect(
        await dispatchApprovedArticles({
          operations: {
            duePendingEvents: () => [operations.pendingEvent(eventId)!],
            markEventSent: operations.markEventSent.bind(operations),
            markEventRetry: operations.markEventRetry.bind(operations),
          },
          publisher: nats,
        }),
      ).toMatchObject({ sent: 1 });
      const sequence = (await nats.manager()).streams
        .info(stream)
        .then((info) => info.state.last_seq);
      const seq = await sequence;
      for (const name of ["dummy-a", "dummy-b"]) {
        await provisionDurableConsumer(nats, {
          stream,
          name,
          filterSubject: ARTICLE_APPROVED_SUBJECT,
          startSequence: seq,
          maxAckPending: 1,
        });
        let delivery: SelectedPublisherResult | undefined;
        await runPublisherService({
          nats,
          stream,
          consumer: name,
          content,
          operations,
          deliveryControl,
          destination: new SimulatedDestination(name, "draft"),
          owner: name,
          delayMs: 0,
          retryDelayMs: 1,
          log: () => {},
          signal: AbortSignal.timeout(15000),
          selection: {
            eventId,
            sequence: seq,
            payload: pending.payload,
            onResult: (value) => {
              delivery = value;
            },
          },
        });
        expect(delivery?.status).toBe("delivered");
      }
      expect(
        await readDummyDeliveryProof(content, JSON.parse(pending.payload).data, operations),
      ).toBeDefined();
      const real = localDraftDestination();
      real.client.draftTargetIdentity = substackDraftOriginIdentity("https://publication.example");
      real.policy.currentRealIdentity = real.destination.draftTarget!.identity;
      expect(
        (
          await runSelectedPublisher({
            selection: { eventId, sequence: seq, waitMs: 15000 },
            nats,
            stream,
            content,
            operations,
            destination: real.destination,
            deliveryControl,
            owner: "selected-fixture",
          })
        ).status,
      ).toBe("delivered");
      expect(real.calls.create).toBe(1);
      expect(real.records[0]?.is_published).toBe(false);
      expect(real.records[0]?.email_sent_at).toBeNull();
      // A real atomic settings-file edit governs the next decision of a running invocation.
      const policyFile = join(dir, "public-settings.json");
      for (const key of [
        "STEELE_EDITORIAL_MAX_REVISIONS",
        "STEELE_EDITORIAL_EXHAUSTION_ACTION",
        "STEELE_EDITORIAL_DEADLINE_MS",
      ])
        vi.stubEnv(key, "");
      vi.stubEnv("STEELE_CONFIG_PATH", policyFile);
      await writeFile(
        policyFile,
        JSON.stringify({
          STEELE_EDITORIAL_MAX_REVISIONS: "3",
          STEELE_EDITORIAL_EXHAUSTION_ACTION: "stop",
          STEELE_EDITORIAL_DEADLINE_MS: "120000",
        }),
      );
      // This separate attempt uses a fresh synthetic generation. A cached historical
      // canonical generation must not be rolled back over the first attempt's revision.
      writer.modelVersion = "synthetic/file-edit-writer";
      const originalJudge = stages.editorial!.judge;
      stages.editorial!.judge = async (...args) => {
        const judged = await originalJudge(...args);
        await writeFile(
          policyFile + ".next",
          JSON.stringify({
            STEELE_EDITORIAL_MAX_REVISIONS: "0",
            STEELE_EDITORIAL_EXHAUSTION_ACTION: "create-unpublished-draft",
            STEELE_EDITORIAL_DEADLINE_MS: "120000",
          }),
        );
        await (await import("node:fs/promises")).rename(policyFile + ".next", policyFile);
        return judged;
      };
      const changed = recordArticleAttempt(
        operations,
        liveEditorialInput(parent.summary.input),
        "live-policy-file-edit",
      );
      const changedResult = await ingress
        .workflowClient(workflow, changed.identity.workflowKey)
        .run(changed.input);
      expect(changedResult.editorial?.revisions).toHaveLength(0);
      expect(changedResult.editorial?.terminal).toBe("unresolved");
      expect(changedResult.authorizationOutcome).toBe("owner-authorized-draft");
      expect(changedResult.editorial?.policyObservations?.at(-1)?.policy).toMatchObject({
        maxRevisions: 0,
        onExhausted: "create-unpublished-draft",
      });
      stages.editorial!.judge = originalJudge;
      await writeFile(
        policyFile,
        JSON.stringify({
          STEELE_EDITORIAL_MAX_REVISIONS: "1",
          STEELE_EDITORIAL_EXHAUSTION_ACTION: "create-unpublished-draft",
          STEELE_EDITORIAL_DEADLINE_MS: "120000",
        }),
      );
      assessor.modelVersion = "synthetic/fresh-expiry-assessor";
      const beforeExpiry = { ...calls };
      const expired = recordArticleAttempt(
        operations,
        liveEditorialInput(parent.summary.input),
        "live-policy-expired",
      );
      const expiredResult = await ingress
        .workflowClient(workflow, expired.identity.workflowKey)
        .run(expired.input);
      expect(expiredResult.outcome).toBe("failed");
      expect(expiredResult.reason).toBe("live-policy-deadline");
      expect(expiredResult.editorial?.assessments).toHaveLength(0);
      expect(expiredResult.draftAuthorizationEvent).toBeUndefined();
      expect(calls).toEqual(beforeExpiry);
    } finally {
      await nats?.close();
      await server?.stop();
      await env?.stop();
      operations.close();
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
