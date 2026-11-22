import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { exportPipelineLog } from "../../src/controllers/sentry-logs.js";
import { reportPartialResearch } from "../../src/observability/research-warning.js";
import { outputLimitWarning, type ResearchResult } from "../../src/research/job.js";
vi.mock("../../src/controllers/sentry-logs.js", () => ({ exportPipelineLog: vi.fn() }));
let dir: string;
let store: OperationStore;
const ref = {
  repository: "content",
  commit: "1".repeat(40),
  path: "synthetic/result.json",
  hash: `sha256:${"2".repeat(64)}`,
};
const result: ResearchResult = {
  schemaVersion: 1,
  jobId: `research-${"a".repeat(32)}`,
  outcome: "complete-with-gaps",
  manifest: ref,
  warnings: [outputLimitWarning(ref)],
  finishedAt: "2026-01-01T00:00:00Z",
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "research-warning-"));
  store = new OperationStore({ path: join(dir, "state.sqlite") });
  vi.mocked(exportPipelineLog).mockReset();
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});
it("emits one allowlisted warning across replay, process restart and recovered job aliases", () => {
  reportPartialResearch(store, result);
  reportPartialResearch(store, result);
  store.close();
  store = new OperationStore({ path: join(dir, "state.sqlite") });
  reportPartialResearch(store, { ...result, jobId: `research-${"b".repeat(32)}` });
  expect(exportPipelineLog).toHaveBeenCalledExactlyOnceWith(
    {
      correlation_id: result.jobId,
      stage: "research",
      outcome: "partial-report-output-limit",
      revision: ref.hash,
    },
    "warn",
  );
  expect(JSON.stringify(vi.mocked(exportPipelineLog).mock.calls)).not.toContain(ref.path);
  expect(JSON.stringify(vi.mocked(exportPipelineLog).mock.calls)).not.toContain(ref.repository);
});
it("Sentry and dedup storage failures never block the usable result", () => {
  vi.mocked(exportPipelineLog).mockImplementation(() => {
    throw new Error("private endpoint sentinel");
  });
  expect(() => reportPartialResearch(store, result)).not.toThrow();
  expect(() => reportPartialResearch(store, result)).not.toThrow();
  expect(exportPipelineLog).toHaveBeenCalledTimes(1);
  const broken = {
    markResearchPartialWarning: () => {
      throw new Error("private storage sentinel");
    },
  };
  expect(() => reportPartialResearch(broken, result)).not.toThrow();
});
it("rejects unknown warning payloads and does not warn for ordinary completed research", () => {
  reportPartialResearch(store, { ...result, warnings: undefined, outcome: "complete" });
  reportPartialResearch(store, {
    ...result,
    warnings: [{ ...result.warnings![0]!, privateField: "sensitive sentinel" }],
  } as ResearchResult);
  expect(exportPipelineLog).not.toHaveBeenCalled();
  expect(store.markResearchPartialWarning({ jobId: result.jobId, discoveryHash: ref.hash })).toBe(
    true,
  );
});
