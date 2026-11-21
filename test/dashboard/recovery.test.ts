import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { articleRecovery } from "../../src/dashboard/recovery-view.js";
import { restateSubmitter } from "../../src/dashboard/adapters.js";
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
