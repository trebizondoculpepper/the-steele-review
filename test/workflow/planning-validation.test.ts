import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { GitArtifactStore, ArtifactStoreError } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { proposeThemes } from "../../src/analysis/theme-proposals.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import {
  LexicalShortlister,
  retainedOrdering,
  analysedBefore,
} from "../../src/research/librarian.js";
import { articleStages } from "../../src/workflow/stages.js";
import { researchJobId } from "../../src/research/job.js";
let dir: string, content: GitArtifactStore, operations: OperationStore;
const post = { publicationId: "synthetic", postId: "planning" };
const text = "Independent synthetic subjects.";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "planning-validation-"));
  content = new GitArtifactStore({ repoPath: join(dir, "content"), repository: "content" });
  await mkdir(join(dir, "content"));
  await content.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations?.close();
  await rm(dir, { recursive: true, force: true });
});
async function seed() {
  const output = await proposeThemes({
    artifacts: content,
    post,
    source: {
      text,
      sourceVersion: sourceVersionFor(text),
      artifact: {
        repository: "archive",
        commit: "a".repeat(40),
        path: "collected.json",
        hash: `sha256:${"b".repeat(64)}`,
      },
    },
    provider: {
      modelVersion: "synthetic/seed",
      complete: async () =>
        JSON.stringify({
          themes: ["Alpha", "Beta", "Gamma"].map((title) => ({
            title,
            description: `Independent ${title} issue`,
          })),
        }),
    },
  });
  if (output.status !== "proposed") throw new Error("seed failed");
  const proposals = JSON.parse(await content.read(output.ref)).proposals as {
    id: string;
    title: string;
  }[];
  const record = {
    schemaVersion: 2,
    post,
    sourceVersion: sourceVersionFor(text),
    themeIds: proposals.map((p) => p.id),
    themeResult: `${output.ref.commit}:${output.ref.path}`,
    claims: proposals.flatMap((p, i) =>
      Array.from({ length: i + 1 }, (_, n) => ({
        claim: { statement: `A distinct ${p.title} claim ${n}.` },
        occurrence: {},
        kind: "assertion",
        themeIds: [p.id],
        classification: "themed",
        claimRecordId: `claim-${p.title}-${n}`,
      })),
    ),
    candidates: [],
    rejected: [],
    extraction: {
      modelVersion: "synthetic/seed",
      promptVersion: "synthetic",
      extractedAt: "2026-01-01T00:00:00Z",
    },
  };
  const claims = await content.write(
    "claim-extractions/synthetic/planning/claims.json",
    JSON.stringify(record),
  );
  return { themes: output.ref, claims, record };
}
function composed(store = content) {
  const call = vi.fn(async (): Promise<never> => {
    throw new Error("no provider permitted");
  });
  return {
    call,
    stages: articleStages({
      archive: content,
      content: store,
      operations,
      models: {
        themes: { modelVersion: "synthetic/forbidden", complete: call },
        claims: { modelVersion: "synthetic/forbidden", complete: call },
        writer: { modelVersion: "synthetic/forbidden", complete: call },
      },
      shortlister: new LexicalShortlister(),
      research: {
        sonar: { model: "synthetic/forbidden", research: call },
        fetcher: { fetch: call },
      },
      owner: "synthetic-planner",
    }),
  };
}
it("ranks a fresh later larger gap first and keeps it on replay", async () => {
  const s = await seed(),
    { stages, call } = composed();
  const first = await stages.planResearch(s.themes, s.claims);
  expect(first.map((r) => r.claims.length)).toEqual([3, 2, 1]);
  expect((await stages.planResearch(s.themes, s.claims)).map(researchJobId)).toEqual(
    first.map(researchJobId),
  );
  expect(call).not.toHaveBeenCalled();
});
function selectionWinner(
  mutate: (record: { candidates: { rank: number; jobId: string }[] }) => void,
) {
  return new Proxy(content, {
    get(target, key) {
      if (key === "write")
        return async (path: string, body: string) => {
          if (path.startsWith("librarian/research-selection/")) {
            const record = JSON.parse(body);
            mutate(record);
            return target.write(path, JSON.stringify(record));
          }
          return target.write(path, body);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
it("uses the persisted selection winner when its order differs from the proposal", async () => {
  const s = await seed(),
    { stages, call } = composed(
      selectionWinner((record) =>
        record.candidates.reverse().forEach((c, i) => {
          c.rank = i + 1;
        }),
      ),
    );
  const first = await stages.planResearch(s.themes, s.claims);
  expect(first.map((r) => r.claims.length)).toEqual([1, 2, 3]);
  expect((await stages.planResearch(s.themes, s.claims)).map(researchJobId)).toEqual(
    first.map(researchJobId),
  );
  expect(call).not.toHaveBeenCalled();
});
it.each(["malformed", "different-post", "different-theme", "different-version"])(
  "rejects %s analysis before recording a decision",
  async (kind) => {
    const s = await seed();
    let themes = s.themes,
      claims = s.claims;
    if (kind === "malformed")
      themes = await content.write("invalid-theme.json", JSON.stringify({ post }));
    else {
      const record = structuredClone(s.record);
      if (kind === "different-post") record.post = { ...post, postId: "other" };
      if (kind === "different-theme") record.themeResult = `${"c".repeat(40)}:other.json`;
      if (kind === "different-version") record.sourceVersion = `sha256:${"d".repeat(64)}`;
      claims = await content.write("invalid-claims.json", JSON.stringify(record));
    }
    const { stages, call } = composed();
    await expect(stages.planResearch(themes, claims)).rejects.toThrow();
    expect(await content.list("librarian/research-ordering", 10)).toEqual([]);
    expect(await content.list("librarian/research-selection", 10)).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  },
);
it("keeps the fresh decision after a coverage commit loses its acknowledgment", async () => {
  const s = await seed();
  let interrupted = false;
  const store = new Proxy(content, {
    get(target, key) {
      if (key === "write")
        return async (path: string, body: string) => {
          const ref = await target.write(path, body);
          if (!interrupted && path.startsWith("librarian/coverage/")) {
            interrupted = true;
            throw new ArtifactStoreError("git-failed", "synthetic lost acknowledgment");
          }
          return ref;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { stages, call } = composed(store);
  await expect(stages.planResearch(s.themes, s.claims)).rejects.toThrow();
  expect(interrupted).toBe(true);
  expect((await stages.planResearch(s.themes, s.claims)).map((r) => r.claims.length)).toEqual([
    3, 2, 1,
  ]);
  expect(call).not.toHaveBeenCalled();
});
it("preserves an existing original-order prefix instead of applying fresh ranking", async () => {
  const s = await seed();
  await retainedOrdering(content, post, s.themes, s.claims, async () => "original");
  const { stages, call } = composed();
  const first = await stages.planResearch(s.themes, s.claims);
  expect(first.map((r) => r.claims.length)).toEqual([1, 2, 3]);
  expect((await stages.planResearch(s.themes, s.claims)).slice(0, 2).map(researchJobId)).toEqual(
    first.slice(0, 2).map(researchJobId),
  );
  expect(call).not.toHaveBeenCalled();
});

it("does not confuse a matching path/commit with another repository or hash, and reports incomplete scans", async () => {
  const s = await seed();
  await composed().stages.planResearch(s.themes, s.claims);
  expect(await analysedBefore(content, post, { ...s.themes, repository: "other" }, s.claims)).toBe(
    false,
  );
  expect(
    await analysedBefore(content, post, { ...s.themes, sha256: "f".repeat(64) }, s.claims),
  ).toBe(false);
  const list = vi.fn(async () => Array.from({ length: 1000 }, (_, n) => `synthetic-${n}`));
  const bounded = new Proxy(content, {
    get(target, key) {
      if (key === "lookup") return async () => undefined;
      if (key === "list") return list;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(analysedBefore(bounded, post, s.themes, s.claims)).rejects.toThrow("incomplete");
  expect(list).toHaveBeenCalledTimes(10);
});
it("refuses duplicate saved candidate IDs instead of returning a new computed selection", async () => {
  const s = await seed(),
    { stages, call } = composed(
      selectionWinner((record) => {
        record.candidates[1].jobId = record.candidates[0].jobId;
      }),
    );
  await expect(stages.planResearch(s.themes, s.claims)).rejects.toThrow(
    "selection binding mismatch",
  );
  expect(call).not.toHaveBeenCalled();
});
