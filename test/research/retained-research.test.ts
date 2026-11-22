import * as clients from "@restatedev/restate-sdk-clients";
import { RestateTestEnvironment, RestateContainer } from "@restatedev/restate-sdk-testcontainers";
import {
  articleRunWorkflow,
  researchService,
  type ArticleStages,
} from "../../src/workflow/article-run.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vite-plus/test";
import { GitArtifactStore, type ArtifactRef } from "../../src/controllers/artifact-store.js";
import { OperationStore, OperationStoreError } from "../../src/controllers/operation-store.js";
import { ModelProviderError } from "../../src/controllers/openrouter.js";
import { WebAdapterError } from "../../src/controllers/research-web.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { sourceContextFor, saveSourceContext } from "../../src/content/source-context.js";
import { captureResearchDiscovery, discoveryIdentity } from "../../src/research/discovery.js";
import {
  prepareRetainedResearch,
  validateRetainedArticleResearch,
} from "../../src/research/retained-research-source.js";
import { recoverRetainedResearch } from "../../src/research/retained-research.js";
import { RESEARCH_PROMPT_VERSION, runResearchJob } from "../../src/research/runner.js";
import { researchJobId, finishResearchJob } from "../../src/research/job.js";
import { assessPostCoverage, LexicalShortlister } from "../../src/research/librarian.js";
import { saveWriterPackage } from "../../src/drafting/writer-package.js";
import { librarianFixtures, CLAIMS, TEXT, SHARED } from "./librarian-fixtures.js";
const ref = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});
const TREATY = "The treaty prohibits hostile environmental modification.";
let dir: string, artifacts: GitArtifactStore, operations: OperationStore, clock: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "retained-research-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await artifacts.initialise();
  clock = Date.now();
  operations = new OperationStore({ path: join(dir, "state.sqlite"), now: () => clock });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});
async function seeded() {
  const fx = librarianFixtures(artifacts),
    a = await fx.analysis("post", CLAIMS);
  const theme = JSON.parse(await artifacts.read(a.themeResult));
  const context = await saveSourceContext(
    artifacts,
    sourceContextFor(
      {
        item: {
          publicationId: "pub",
          postId: "post",
          url: "https://pub.example/p/post",
          title: "A post",
        },
        ingestionReason: "backfill",
        text: TEXT,
        complete: true,
        supplied: { transcriptDocument: "spoken" },
        provenance: {
          sourceUrl: "https://pub.example/p/post",
          acquiredAt: "2026-01-01T00:00:00Z",
          method: "supplied-transcript",
          originalMedium: "video",
        },
      },
      { ...theme.artifact, sha256: theme.artifact.hash.slice(7) },
      {
        status: "resolved",
        author: "Configured Person",
        observedByline: "Publication account",
        basis: "source-configured",
        sourceMetadataVersion: "source-fixture-v1",
      },
    ),
  );
  const themes = await artifacts.write(
    "fixtures/themes.json",
    JSON.stringify({ ...theme, sourceContext: ref(context) }),
  );
  const claims = await artifacts.write(
    "fixtures/claims.json",
    JSON.stringify({
      ...JSON.parse(await artifacts.read(a.claimResult)),
      themeResult: `${themes.commit}:${themes.path}`,
      sourceContext: ref(context),
    }),
  );
  let request: any;
  await assessPostCoverage({
    artifacts,
    themeResult: themes,
    claimResult: claims,
    shortlister: new LexicalShortlister(),
    commission: async (r) => {
      request = r;
      return { jobId: "planning", status: "busy" };
    },
  });
  const processor = {
    version: "research-discovery-v1" as const,
    model: "fixture/research",
    promptVersion: RESEARCH_PROMPT_VERSION,
    parameters: {},
  };
  const body = JSON.stringify({
    model: processor.model,
    choices: [
      {
        message: {
          content:
            "The treaty prohibits hostile environmental modification. The remainder of this report was cut short.",
          annotations: [
            { url_citation: { url: SHARED } },
            { url_citation: { url: "https://unavailable.example/source" } },
          ],
        },
        finish_reason: "length",
      },
    ],
    usage: { completion_tokens: 4000, cost: 0.2 },
  });
  const sonar = {
    model: processor.model,
    research: vi.fn(async (_prompt: any, _signal: any, capture: any) => {
      await capture({
        representation: "provider-json",
        encoding: "base64",
        transport: "complete",
        body: Buffer.from(body).toString("base64"),
      });
      throw new ModelProviderError("bad-response");
    }),
  };
  const failed = await runResearchJob({
    artifacts,
    operations,
    request,
    owner: "original",
    sonar,
    fetcher: {
      fetch: async () => {
        throw new Error("must not retrieve invalid discovery");
      },
    },
  });
  expect(failed).toMatchObject({ result: { outcome: "failed", failure: "invalid-report" } });
  const identity = discoveryIdentity(request, processor),
    discovery = (await artifacts.lookup(
      `research-discovery/${identity.requestId}/${identity.discoveryId}/result.json`,
    ))!,
    failedResult = (await artifacts.lookup(`research-jobs/${researchJobId(request)}/result.json`))!;
  return { request, processor, body, sonar, discovery, failedResult, themes, claims, context };
}
function deps() {
  return {
    artifacts,
    operations,
    owner: "rescue",
    fetcher: {
      fetch: vi.fn(async (url: string) => {
        if (url !== SHARED) throw new WebAdapterError("not-found");
        return { url, title: "Treaty", text: TREATY };
      }),
    },
    judge: {
      judge: vi.fn(async () => ({
        passages: [
          { findingId: "claim-treaty", passage: TREATY },
          { findingId: "claim-payment", passage: "A fabricated sentence." },
        ],
        sourceType: "treaty",
        rationale: "Primary public text.",
      })),
    },
  };
}
describe("retained incomplete research composition", { timeout: 60000 }, () => {
  it("retrieves and independently checks retained annotations, then normal research/curation builds supported-only package with zero discovery calls", async () => {
    const f = await seeded(),
      d = deps(),
      old = await artifacts.read(f.failedResult);
    f.sonar.research.mockImplementation(async () => {
      throw new Error("new discovery forbidden");
    });
    f.sonar.research.mockClear();
    const recovered = await recoverRetainedResearch({
      ...d,
      discovery: f.discovery,
      failedResult: f.failedResult,
    });
    expect(recovered.status).toBe("recovered");
    if (recovered.status !== "recovered") throw new Error();
    expect(recovered.binding.jobId).not.toBe(researchJobId(f.request));
    expect(recovered.result.outcome).toBe("complete-with-gaps");
    expect(d.fetcher.fetch).toHaveBeenCalledTimes(2);
    expect(d.judge.judge).toHaveBeenCalledTimes(1);
    const coverage = await assessPostCoverage({
      artifacts,
      themeResult: f.themes,
      claimResult: f.claims,
      shortlister: new LexicalShortlister(),
      commission: async (request) => {
        const out = await runResearchJob({ ...d, request, sonar: f.sonar });
        if (out.status !== "finished") throw new Error();
        return {
          jobId: out.jobId,
          status: "finished",
          result: out.result,
          resultRef: (await artifacts.lookup(`research-jobs/${out.jobId}/result.json`))!,
        };
      },
    });
    expect(coverage.record.claims.find((c) => c.claimRecordId === "claim-treaty")?.status).toBe(
      "evidence-found",
    );
    expect(
      coverage.record.claims.find((c) => c.claimRecordId === "claim-payment")?.status,
    ).not.toBe("evidence-found");
    const pkg = await saveWriterPackage({ content: artifacts, coverage: coverage.ref });
    expect(pkg.package.status).toBe("ready");
    expect(pkg.package.source.context).toEqual(ref(f.context));
    expect(f.sonar.research).not.toHaveBeenCalled();
    expect(await artifacts.read(f.failedResult)).toBe(old);
    const context = JSON.parse(await artifacts.read(f.context));
    const selection = {
      artifacts,
      operations,
      jobIds: [researchJobId(f.request)],
      capture: {
        ...f.request.post.sourceArtifact,
        sha256: f.request.post.sourceArtifact.hash.slice(7),
      },
      sourceContext: context,
    };
    await expect(validateRetainedArticleResearch(selection)).resolves.toBeUndefined();
    await expect(
      validateRetainedArticleResearch({
        ...selection,
        sourceContext: {
          ...context,
          author: { ...context.author, author: "Different configured person" },
        },
      }),
    ).rejects.toThrow("context-mismatch");
    await expect(
      validateRetainedArticleResearch({
        ...selection,
        capture: { ...selection.capture, sha256: "c".repeat(64) },
      }),
    ).rejects.toThrow("capture-mismatch");
    operations.close();
    operations = new OperationStore({ path: join(dir, "state.sqlite"), now: () => clock });
    const replay = await recoverRetainedResearch({
      ...d,
      operations,
      discovery: f.discovery,
      failedResult: f.failedResult,
    });
    expect(replay).toMatchObject({ status: "recovered", reused: true });
    expect(d.fetcher.fetch).toHaveBeenCalledTimes(2);
    expect(d.judge.judge).toHaveBeenCalledTimes(1);
    const changed = {
      ...f.request,
      post: {
        ...f.request.post,
        sourceContext: { ...f.request.post.sourceContext, hash: `sha256:${"c".repeat(64)}` },
      },
    };
    expect(researchJobId(changed)).toBe(researchJobId(f.request));
    await expect(
      runResearchJob({ ...d, operations, request: changed, sonar: f.sonar }),
    ).rejects.toThrow("binding-mismatch");
    expect(f.sonar.research).not.toHaveBeenCalled();
  });
  it("uses a new durable generation through real Restate after its original research failure was cached, without another discovery", async () => {
    const f = await seeded(),
      d = deps();
    f.sonar.research.mockClear();
    let researchCalls = 0,
      draftCalls = 0;
    const stages: ArticleStages = {
      themes: async () => f.themes,
      claims: async () => f.claims,
      planResearch: async () => [f.request],
      research: async (request) => {
        researchCalls++;
        const out = await runResearchJob({ ...d, request, sonar: f.sonar });
        if (out.status !== "finished") throw new Error();
        return {
          jobId: out.jobId,
          status: "finished",
          result: out.result,
          resultRef: (await artifacts.lookup(`research-jobs/${out.jobId}/result.json`))!,
        };
      },
      coverage: async (_themes, _claims, pinned) =>
        (
          await assessPostCoverage({
            artifacts,
            themeResult: f.themes,
            claimResult: f.claims,
            shortlister: new LexicalShortlister(),
            commission: async () => {
              const p = pinned[0];
              if (p.outcome !== "finished") throw new Error();
              return p.job;
            },
          })
        ).ref,
      package: async (coverage) => {
        const out = await saveWriterPackage({ content: artifacts, coverage });
        return { ref: out.ref, status: out.package.status };
      },
      draft: async () => {
        draftCalls++;
        return { failure: "synthetic-stop-after-ready-package" };
      },
      verify: async () => {
        throw new Error("no writer/verifier call in recovery test");
      },
      approve: async () => {
        throw new Error("no approval in recovery test");
      },
    };
    const Workflow = articleRunWorkflow(stages);
    const env = await RestateTestEnvironment.start(
      { services: [Workflow, researchService(stages)], serviceEndpointAccess: "docker-host" },
      () => new RestateContainer("1.8.1"),
    );
    try {
      const ingress = clients.connect({ url: env.baseUrl() });
      const base = {
        publicationId: "pub",
        postId: "post",
        sourceVersion: sourceVersionFor(TEXT),
        sourceUrl: "https://pub.example/p/post",
        researchDeadlineMs: 30_000,
        researchRequestLimit: 1,
      };
      const submit = async (key: string, extra: object = {}) => {
        const w = ingress.workflowClient(Workflow, key);
        await w.workflowSubmit({ ...base, ...extra });
        return w.workflowAttach();
      };
      expect((await submit("fixture-original")).outcome).toBe("evidence-gap");
      expect(researchCalls).toBe(1);
      expect(
        (
          await recoverRetainedResearch({
            ...d,
            discovery: f.discovery,
            failedResult: f.failedResult,
          })
        ).status,
      ).toBe("recovered");
      // Same service idempotency key still returns its journaled original failure.
      expect((await submit("fixture-old-key")).outcome).toBe("evidence-gap");
      expect(researchCalls).toBe(1);
      const recovered = await submit("fixture-recovered", {
        operatorRequestId: "owner-recovery",
        recoveryGeneration: 1,
        retainedResearchJobIds: [researchJobId(f.request)],
      });
      expect(recovered).toMatchObject({
        outcome: "failed",
        reason: "synthetic-stop-after-ready-package",
      });
      expect(researchCalls).toBe(2);
      expect(draftCalls).toBe(1);
      const pkg = JSON.parse(await artifacts.read(recovered.package!));
      expect(pkg.status).toBe("ready");
      expect(pkg.source.context).toEqual(ref(f.context));
      const changed = await submit("fixture-changed-plan", {
        operatorRequestId: "changed-plan",
        recoveryGeneration: 1,
        retainedResearchJobIds: [`research-${"f".repeat(32)}`],
      });
      expect(changed).toMatchObject({
        outcome: "evidence-gap",
        reason: "retained-research-plan-mismatch",
      });
      expect(researchCalls).toBe(2);
      expect(f.sonar.research).not.toHaveBeenCalled();
    } finally {
      await env.stop();
    }
  }, 240_000);
  it("replays a saved completed child after acceptance-storage failure without fetching or judging again", async () => {
    const f = await seeded(),
      d = deps();
    const complete = operations.completeResearchRecovery.bind(operations);
    vi.spyOn(operations, "completeResearchRecovery")
      .mockImplementationOnce(() => {
        throw new OperationStoreError("busy");
      })
      .mockImplementation(complete);
    await expect(
      recoverRetainedResearch({ ...d, discovery: f.discovery, failedResult: f.failedResult }),
    ).rejects.toMatchObject({ code: "busy" });
    expect(operations.researchRecovery(researchJobId(f.request))).toBeUndefined();
    expect(
      (
        await recoverRetainedResearch({
          ...d,
          discovery: f.discovery,
          failedResult: f.failedResult,
        })
      ).status,
    ).toBe("recovered");
    expect(d.judge.judge).toHaveBeenCalledTimes(1);
    expect(d.fetcher.fetch).toHaveBeenCalledTimes(2);
    expect(f.sonar.research).toHaveBeenCalledTimes(1);
  });
  it("retains output but refuses activation after the recovery owner expires", async () => {
    const f = await seeded(),
      d = deps();
    d.judge.judge.mockImplementation(async () => {
      clock += 1001;
      return {
        passages: [{ findingId: "claim-treaty", passage: TREATY }],
        sourceType: "treaty",
        rationale: "Primary public text.",
      };
    });
    await expect(
      recoverRetainedResearch({
        ...d,
        discovery: f.discovery,
        failedResult: f.failedResult,
        leaseMs: 1000,
      }),
    ).rejects.toMatchObject({ code: "not-owner" });
    expect(operations.researchRecovery(researchJobId(f.request))).toBeUndefined();
    expect(f.sonar.research).toHaveBeenCalledTimes(1);
  });
  it("binds distinct original discovery versions to distinct child identities", async () => {
    const f = await seeded();
    const processor = { ...f.processor, parameters: { maxOutputTokens: 8000 } };
    await expect(
      captureResearchDiscovery({
        artifacts,
        operations,
        request: f.request,
        processor,
        owner: "second",
        invoke: async (capture) => {
          await capture(f.body);
          throw new ModelProviderError("bad-response");
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-report" });
    const identity = discoveryIdentity(f.request, processor),
      other = (await artifacts.lookup(
        `research-discovery/${identity.requestId}/${identity.discoveryId}/result.json`,
      ))!;
    const a = await prepareRetainedResearch({
        ...deps(),
        discovery: f.discovery,
        failedResult: f.failedResult,
      }),
      b = await prepareRetainedResearch({
        ...deps(),
        discovery: other,
        failedResult: f.failedResult,
      });
    expect(researchJobId(a.request)).not.toBe(researchJobId(b.request));
    expect(researchJobId(a.request)).toBe(
      researchJobId(
        (
          await prepareRetainedResearch({
            ...deps(),
            discovery: f.discovery,
            failedResult: f.failedResult,
          })
        ).request,
      ),
    );
  });
  it("refuses a copied failed-result record outside its original job path", async () => {
    const f = await seeded(),
      d = deps();
    const copied = await artifacts.write(
      "fixtures/copied-failed.json",
      await artifacts.read(f.failedResult),
    );
    await expect(
      recoverRetainedResearch({ ...d, discovery: f.discovery, failedResult: copied }),
    ).rejects.toThrow();
    expect(d.fetcher.fetch).not.toHaveBeenCalled();
    expect(d.judge.judge).not.toHaveBeenCalled();
  });
  it.each(["invalid-json", "invalid-schema", "incomplete", "resource-limit", "quarantined"])(
    "blocks %s retained candidates before retrieval/support",
    async (mode) => {
      const request = {
          schemaVersion: 1,
          origin: "manual",
          subject: mode,
          pass: 1,
          claims: [],
          corpusRefs: [],
        },
        processor = {
          version: "research-discovery-v1" as const,
          model: "fixture/research",
          promptVersion: RESEARCH_PROMPT_VERSION,
          parameters: {},
        };
      const body =
        mode === "invalid-json"
          ? "{broken"
          : JSON.stringify({
              choices: [
                {
                  message: {
                    content: mode === "invalid-schema" ? {} : "A retained partial report.",
                  },
                  finish_reason: "length",
                },
              ],
            });
      await expect(
        captureResearchDiscovery({
          artifacts,
          operations,
          request,
          processor,
          owner: "original",
          leaseMs: 1000,
          now: () => new Date(clock),
          invoke: async (capture) => {
            if (mode === "quarantined") clock += 1001;
            await capture({
              representation: "provider-json",
              encoding: "base64",
              body: Buffer.from(body).toString("base64"),
              transport:
                mode === "incomplete"
                  ? "incomplete"
                  : mode === "resource-limit"
                    ? "resource-limit"
                    : "complete",
            });
            throw new ModelProviderError("bad-response");
          },
        }),
      ).rejects.toThrow();
      const identity = discoveryIdentity(request, processor),
        discovery = (await artifacts.lookup(
          `research-discovery/${identity.requestId}/${identity.discoveryId}/result.json`,
        ))!;
      const failed = await finishResearchJob({
        artifacts,
        operations,
        jobId: researchJobId(request),
        outcome: "failed",
        failure: "invalid-report",
      });
      const d = deps();
      await expect(
        recoverRetainedResearch({ ...d, discovery, failedResult: failed.resultRef }),
      ).rejects.toThrow();
      expect(d.fetcher.fetch).not.toHaveBeenCalled();
      expect(d.judge.judge).not.toHaveBeenCalled();
    },
  );
});
