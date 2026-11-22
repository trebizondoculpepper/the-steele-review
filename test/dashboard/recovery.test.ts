import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { articleRecovery } from "../../src/dashboard/recovery-view.js";
import { recordArticleAttempt } from "../../src/workflow/article-attempt.js";
import { prepareArticleInput } from "../../src/dashboard/trigger.js";
import { restateSubmitter } from "../../src/dashboard/adapters.js";
import { articleViews, renderTrace } from "../../src/dashboard/article-views.js";
import { traceArticle } from "../../src/dashboard/articles.js";
import {
  RECOVERY_RUN_SUFFIX,
  recoveryIdentities,
  recoveryOperationKey,
  recoveryWorkflowKey,
} from "../../src/dashboard/recovery.js";
import type { RunState } from "../../src/dashboard/articles.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";

let dir: string;
let archive: GitArtifactStore;
let operations: OperationStore;
const TEXT = "The council raised fees by 3% last spring.";
const version = sourceVersionFor(TEXT);
const post = { publicationId: "pub", postId: "p1" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-recovery-"));
  const archiveDir = join(dir, "archive");
  await mkdir(archiveDir);
  archive = new GitArtifactStore({ repoPath: archiveDir, repository: "archive" });
  await archive.initialise();
  await archive.write(
    "substack/pub/p1/collected.json",
    `${JSON.stringify({
      item: {
        publicationId: "pub",
        postId: "p1",
        url: "https://example.test/p/p1",
        title: "A post",
      },
      ingestionReason: "backfill",
      text: TEXT,
      complete: true,
      supplied: {},
      provenance: {
        sourceUrl: "https://example.test/p/p1",
        acquiredAt: "2026-01-01T00:00:00Z",
        method: "supplied-transcript",
      },
    })}\n`,
  );
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

const selection = () =>
  new URLSearchParams({
    publication: "pub",
    post: "p1",
    revision: version,
    confirm: "yes",
  });

const creditBlocked: RunState = {
  state: "finished",
  result: {
    outcome: "failed",
    reason: "coverage: credit-exhausted",
    research: [],
  } as never,
};

function wiring(state: RunState) {
  const submitted: Array<{
    workflowKey?: string;
    publicationId: string;
    recoveryGeneration?: number;
    operatorRequestId?: string;
  }> = [];
  const recovery = articleRecovery({
    archive,
    researchDeadlineMs: 60_000,
    researchRequestLimit: 3,
    submitter: {
      async submit(input, workflowKey) {
        submitted.push({
          ...(workflowKey ? { workflowKey } : {}),
          publicationId: input.publicationId,
          ...(input.operatorRequestId ? { operatorRequestId: input.operatorRequestId } : {}),
          ...(input.recoveryGeneration === undefined
            ? {}
            : { recoveryGeneration: input.recoveryGeneration }),
        });
      },
    },
    runs: { status: async () => state },
    identities: recoveryIdentities(operations, { now: () => new Date("2026-01-01T00:00:00Z") }),
  });
  return { recovery, submitted };
}

it("recovers the selected operator attempt separately from an already recovered base and rejects changed input", async () => {
  const input = (await prepareArticleInput(
    { archive, researchDeadlineMs: 60_000, researchRequestLimit: 3 },
    { publication: "pub", post: "p1", revision: version },
  ))!;
  const attempt = recordArticleAttempt(operations, input, "later-operator");
  const ids = recoveryIdentities(operations);
  const base = await ids.ensure(`${post.publicationId}/${post.postId}@${version.slice(7, 39)}`);
  const state = {
    ...creditBlocked,
    workflowKey: attempt.identity.workflowKey,
    attempts: operations.articleAttempts("pub", "p1", version),
  } as RunState;
  const { recovery, submitted } = wiring(state);
  expect(await recovery.submit(selection())).toMatchObject({ status: 303 });
  expect(submitted[0]!.workflowKey).toBe(recoveryWorkflowKey(attempt.identity.workflowKey));
  expect(submitted[0]!.workflowKey).not.toBe(base.identity.workflowKey);
  expect(submitted[0]).toMatchObject({
    operatorRequestId: "later-operator",
    recoveryGeneration: 1,
  });
  expect(await recovery.submit(selection())).toMatchObject({ status: 303 });
  expect(submitted[1]!.workflowKey).toBe(submitted[0]!.workflowKey);
  const changed = articleRecovery({
    archive,
    researchDeadlineMs: 60_000,
    researchRequestLimit: 1,
    submitter: {
      submit: async () => {
        throw new Error("must not submit");
      },
    },
    runs: { status: async () => state },
    identities: ids,
  });
  expect(await changed.submit(selection())).toEqual({ status: 409 });
});

describe("recovery identities (#480)", () => {
  it("records one workflow identity per run and reuses it", async () => {
    const ids = recoveryIdentities(operations);
    const first = await ids.ensure("pub/p1@abc");
    expect(first).toMatchObject({
      created: true,
      identity: { workflowKey: `pub/p1@abc${RECOVERY_RUN_SUFFIX}` },
    });
    const second = await ids.ensure("pub/p1@abc");
    expect(second).toMatchObject({ created: false, identity: first.identity });
    expect(second.identity).toEqual(first.identity);
    expect(operations.operationStatus(recoveryOperationKey("pub/p1@abc"))?.status).toBe(
      "completed",
    );
  });

  it("lets a concurrent creator win instead of minting a second identity", async () => {
    const other = new OperationStore({ path: join(dir, "state.sqlite") });
    try {
      const a = await recoveryIdentities(operations).ensure("run-1");
      const b = await recoveryIdentities(other).ensure("run-1");
      expect(b).toMatchObject({ created: false, identity: a.identity });
    } finally {
      other.close();
    }
  });

  it("derives the recovery key from the normal workflow key", () => {
    expect(recoveryWorkflowKey("pub/p1@abc")).toBe(`pub/p1@abc${RECOVERY_RUN_SUFFIX}`);
  });
});

describe("recover stopped run action (#480)", () => {
  it("submits one recovery under the recorded identity", async () => {
    const { recovery, submitted } = wiring(creditBlocked);
    const result = await recovery.submit(selection());
    expect(result).toMatchObject({ status: 303 });
    expect(submitted).toHaveLength(1);
    // The recovery marks the generation so a blocked research response is not reused.
    expect(submitted[0]!.recoveryGeneration).toBe(1);
    expect(submitted[0]!.workflowKey).toBe(
      recoveryWorkflowKey(`${post.publicationId}/${post.postId}@${version.slice(7, 39)}`),
    );
    // Repeating the action reuses the same recovery identity.
    const again = await recovery.submit(selection());
    expect(again).toMatchObject({ status: 303 });
    expect(submitted[1]!.workflowKey).toBe(submitted[0]!.workflowKey);
  });

  it("submits through the production adapter under the recovery key", async () => {
    const seen: string[] = [];
    const fakeConnect = ((_config: { url: string }) => ({
      workflowClient: (_service: unknown, key: string) => ({
        async workflowSubmit() {
          seen.push(key);
        },
      }),
    })) as never;
    const submitter = restateSubmitter("http://ingress.invalid", fakeConnect);
    const input = {
      publicationId: "pub",
      postId: "p1",
      sourceVersion: version,
      sourceUrl: "https://example.test/p/p1",
      researchDeadlineMs: 60_000,
      recoveryGeneration: 1,
    };
    await submitter.submit(input);
    await submitter.submit(input, "pub/p1@abc~recovered");
    expect(seen[0]).toBe(`pub/p1@${version.slice(7, 39)}`);
    expect(seen[1]).toBe("pub/p1@abc~recovered");
  });

  it("refuses recovery of a run that is not stopped on credit", async () => {
    const { recovery, submitted } = wiring({
      state: "finished",
      result: { outcome: "verified", themes: {} as never, claims: {} as never, research: [] },
    });
    expect(await recovery.submit(selection())).toEqual({ status: 409 });
    expect(submitted).toHaveLength(0);
  });

  it("requires confirmation and does nothing without it", async () => {
    const { recovery, submitted } = wiring(creditBlocked);
    const form = selection();
    form.delete("confirm");
    expect(await recovery.submit(form)).toEqual({ status: 400 });
    expect(submitted).toHaveLength(0);
  });

  it("refuses a changed or missing captured revision", async () => {
    const { recovery, submitted } = wiring(creditBlocked);
    const changed = selection();
    changed.set("revision", `sha256:${"a".repeat(64)}`);
    expect(await recovery.submit(changed)).toEqual({ status: 409 });
    expect(submitted).toHaveLength(0);
  });

  it("offers recovery only for a credit-stopped run", async () => {
    const eligible = await wiring(creditBlocked).recovery.view.render(
      new URL(`http://x/articles/recover?publication=pub&post=p1&revision=${version}`),
    );
    expect(eligible).toContain("Confirm recovery");
    const ineligible = await wiring({ state: "not-started" }).recovery.view.render(
      new URL(`http://x/articles/recover?publication=pub&post=p1&revision=${version}`),
    );
    expect(ineligible).not.toContain("Confirm recovery");
    expect(ineligible).toContain("not stopped on a recoverable");
  });
});

describe("recovery link (#480)", () => {
  it("uses the configured canonical origin so aliases can confirm recovery", async () => {
    const [, detail] = articleViews({
      canRecover: true,
      actionOrigin: "https://console.example",
      articles: {
        recent: async () => [],
        find: async () => ({ ...post, sourceVersion: version }),
      },
      runs: { status: async () => creditBlocked },
    });
    const html = await detail!.render(
      new URL("http://alias.local/articles/trace?publication=pub&post=p1"),
    );
    expect(html).toContain(
      `href="https://console.example/articles/recover?publication=pub&amp;post=p1&amp;revision=${encodeURIComponent(version)}"`,
    );
  });
});

describe("recovery artifacts (#480)", () => {
  it("shows the recovery's own draft, verification and receipts", async () => {
    const ref = {
      repository: "content",
      commit: "a".repeat(40),
      path: "articles/pub/p1/draft.md",
      sha256: "c".repeat(64),
    };
    const trace = await traceArticle({
      post,
      articles: {
        recent: async () => [],
        find: async () => ({ ...post, sourceVersion: version }),
      },
      runs: {
        status: async () => ({
          state: "finished",
          result: creditBlocked.result,
          recovery: {
            state: "finished",
            result: {
              outcome: "verified",
              themes: ref,
              claims: ref,
              draft: ref,
              verification: ref,
              research: [],
              approvalEvent: "evt-recovered",
            } as never,
          },
        }),
      },
      content: {
        draft: async () => "# Recovered draft\n\nA claim.",
        verification: async () => ({ outcome: "approved", draftHash: `sha256:${ref.sha256}` }),
      },
      receipts: {
        receiptsFor: async () => ({
          receipts: [
            {
              destination: "dummy-a",
              action: "draft",
              simulated: true,
              deliveredAt: "2026-01-02T00:00:00Z",
            },
          ],
          truncated: false,
        }),
      },
    });
    const html = renderTrace(trace);
    // Original failure stays visible and the recovery is shown separately.
    expect(html).toContain("Recovery");
    expect(html).toContain("Recovered draft");
    expect(html).toContain("binds to the recovery draft");
    expect(html).toContain("Recovery delivery receipts");
    expect(html).toContain("~recovered");
  });
});
