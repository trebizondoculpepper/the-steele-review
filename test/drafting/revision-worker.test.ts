import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import type { DeliveredMessage } from "../../src/controllers/nats.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  BRIEF_READY_SUBJECT,
  saveDraftingBrief,
  type BriefInput,
} from "../../src/drafting/brief.js";
import {
  REVISION_DECIDED_SUBJECT,
  parseRevisionDecidedEvent,
} from "../../src/drafting/revision-attempts.js";
import { DEFAULT_DRAFT_PROMPT } from "../../src/drafting/draft.js";
import { RevisionWorker } from "../../src/drafting/revision-worker.js";
import type { ApplicabilityResult } from "../../src/research/applicability.js";

const h = (c: string) => `sha256:${c.repeat(64)}`;
const artifact = {
  repository: "archive",
  commit: "a".repeat(40),
  path: "substack/pub/p/collected.json",
  hash: h("b"),
};
const source = {
  publicationId: "pub",
  postId: "p",
  url: "https://pub.substack.com/p/p",
  sourceVersion: h("1"),
  artifact,
  ingestionReason: "live" as const,
};
const STATEMENT = "The towers emit dangerous radiation.";
const claimId = h("c");
const assessment: ApplicabilityResult = {
  status: "complete",
  claimId,
  assessments: [],
  selected: [
    {
      entryId: "towers",
      revision: 1,
      entryArtifact: {
        repository: "research",
        commit: "e".repeat(40),
        path: "r.json",
        hash: h("f"),
      },
      evidence: {
        kind: "external",
        url: "https://example.org/survey",
        title: "Synthetic survey",
        retrievedAt: "2026-10-01T00:00:00Z",
        lastCheckedAt: "2026-10-01T00:00:00Z",
        passage: "Measured exposure stayed far below safety limits.",
      },
    },
  ],
  outdated: [],
  gaps: [],
  rejected: [],
  omitted: [],
  modelVersion: "m",
  promptVersion: "p",
};
const briefInput: BriefInput = {
  source,
  claims: [
    {
      id: claimId,
      statement: STATEMENT,
      passage: STATEMENT,
      span: { start: 0, end: STATEMENT.length },
      artifact,
      sourceVersion: source.sourceVersion,
    },
  ],
  assessments: [assessment],
};
const draftJson = (uncertainty: string) =>
  JSON.stringify({
    summary: "The post says the towers emit dangerous radiation.",
    themes: [],
    errors: [
      {
        claimId,
        explanation: "Measured exposure stayed far below safety limits.",
        citationIds: ["E1"],
        uncertainty,
      },
    ],
  });
const APPROVE = JSON.stringify({ verdict: "approve", issues: [] });
const REDRAFT = JSON.stringify({
  verdict: "redraft",
  issues: [
    {
      passage: "Uncertainty: medium.",
      problem: "Too certain for one survey.",
      requiredChange: "Say uncertainty is high.",
    },
  ],
});

function fake(name: string, responses: Array<string | Error>) {
  const calls: string[] = [];
  const p: ExtractionModelProvider = {
    modelVersion: `fake/${name}`,
    async complete(req) {
      calls.push(req.user);
      const next = responses.shift();
      if (next === undefined) throw new Error(`${name}: no response`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { p, calls };
}

let dir: string;
let artifacts: GitArtifactStore;
let operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-revision-worker-"));
  await mkdir(join(dir, "drafts"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "drafts"), repository: "drafts" });
  await artifacts.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

async function briefMessage() {
  const saved = await saveDraftingBrief({
    brief: briefInput,
    artifacts,
    operations,
    owner: "brief",
  });
  if (saved.kind !== "saved") throw new Error("brief");
  const pending = operations.duePendingEvents(10, BRIEF_READY_SUBJECT).at(-1)!;
  const m = {
    data: new TextEncoder().encode(pending.payload),
    deliveryCount: 1,
    acks: 0,
    naks: [] as number[],
    terms: 0,
    ack: async () => {
      m.acks++;
    },
    nak: (d?: number) => {
      m.naks.push(d ?? 0);
    },
    term: () => {
      m.terms++;
    },
    working: () => {},
  };
  return m as DeliveredMessage & typeof m;
}
const worker = (
  writer: ExtractionModelProvider,
  verifier: ExtractionModelProvider,
  maxRevisions?: number,
) =>
  new RevisionWorker({
    artifacts,
    operations,
    writer,
    verifier,
    owner: "rev",
    retryDelayMs: 0,
    ...(maxRevisions !== undefined ? { maxRevisions } : {}),
  });
const decisions = () =>
  operations
    .duePendingEvents(10, REVISION_DECIDED_SUBJECT)
    .map((e) => parseRevisionDecidedEvent(e.payload).data);

describe("RevisionWorker", () => {
  it("approves the exact draft on an immediate pass", async () => {
    const writer = fake("writer", [draftJson("medium")]);
    const verifier = fake("verifier", [APPROVE]);
    const m = await briefMessage();
    const r = await worker(writer.p, verifier.p).handle(m);
    expect(r).toMatchObject({ kind: "approved", revision: 0 });
    expect(m.acks).toBe(1);
    expect(decisions()).toMatchObject([{ revision: 0, action: "approve" }]);
  });

  it("routes one targeted correction through the writer, reverifies and approves", async () => {
    const writer = fake("writer", [draftJson("medium"), draftJson("high")]);
    const verifier = fake("verifier", [REDRAFT, APPROVE]);
    const r = await worker(writer.p, verifier.p).handle(await briefMessage());
    expect(r).toMatchObject({ kind: "approved", revision: 1 });
    expect(writer.calls[1]).toContain("Revise the previous draft");
    expect(writer.calls[1]).toContain("Say uncertainty is high.");
    expect(verifier.calls).toHaveLength(2);
    expect(decisions().map((d) => d.action)).toEqual(["redraft", "approve"]);
  });

  it("skips after the bounded number of revisions", async () => {
    const writer = fake("writer", [draftJson("medium"), draftJson("medium")]);
    const verifier = fake("verifier", [REDRAFT, REDRAFT]);
    const r = await worker(writer.p, verifier.p, 1).handle(await briefMessage());
    expect(r).toMatchObject({ kind: "skipped", revision: 1 });
    expect(writer.calls).toHaveLength(2);
    expect(decisions().map((d) => d.action)).toEqual(["redraft", "skip"]);
  });

  it("stays pending on a credit failure and resumes without redoing recorded work", async () => {
    const writer = fake("writer", [draftJson("medium"), new Error("credit exhausted")]);
    const verifier = fake("verifier", [REDRAFT]);
    const m = await briefMessage();
    expect(await worker(writer.p, verifier.p).handle(m)).toMatchObject({
      kind: "pending",
      reason: "writer:provider-failed",
    });
    expect(m.acks).toBe(0);
    // Later, with credit restored: revision 0 is reused, only revision 1 runs.
    const writer2 = fake("writer", [draftJson("high")]);
    const verifier2 = fake("verifier", [APPROVE]);
    expect(await worker(writer2.p, verifier2.p).handle(await briefMessage())).toMatchObject({
      kind: "approved",
      revision: 1,
    });
    expect(writer2.calls).toHaveLength(1);
    expect(verifier2.calls).toHaveLength(1);
  });

  it("reuses a saved draft, with its metadata, when verification was unavailable", async () => {
    const writer = fake("writer", [draftJson("medium")]);
    const down = fake("verifier", [new Error("credit exhausted")]);
    expect(await worker(writer.p, down.p).handle(await briefMessage())).toMatchObject({
      kind: "pending",
      reason: "verifier:verifier-unavailable",
    });
    const paths = await artifacts.list("drafts/pub/p/revisions", 50);
    const metaPath = paths.find((p) => p.endsWith("/0.json"))!;
    const meta = JSON.parse(await artifacts.read((await artifacts.lookup(metaPath))!));
    expect(meta).toMatchObject({
      modelVersion: "fake/writer",
      promptVersion: DEFAULT_DRAFT_PROMPT.version,
      templateVersion: "critique-template-v1",
      citationIds: ["E1"],
    });
    const writer2 = fake("writer", []);
    const r = await worker(writer2.p, fake("verifier", [APPROVE]).p).handle(await briefMessage());
    expect(r).toMatchObject({ kind: "approved", revision: 0 });
    expect(writer2.calls).toHaveLength(0);
  });

  it("bounds inconclusive verifier answers and then records an explicit skip", async () => {
    const writer = fake("writer", [draftJson("medium")]);
    const verifier = fake("verifier", ["not json", "not json", "not json"]);
    const w = new RevisionWorker({
      artifacts,
      operations,
      writer: writer.p,
      verifier: verifier.p,
      owner: "rev",
      retryDelayMs: 0,
      maxInconclusive: 2,
    });
    expect(await w.handle(await briefMessage())).toMatchObject({
      kind: "pending",
      reason: "verifier:inconclusive",
    });
    expect(await w.handle(await briefMessage())).toMatchObject({
      kind: "pending",
      reason: "verifier:inconclusive",
    });
    expect(await w.handle(await briefMessage())).toMatchObject({
      kind: "skipped",
      reason: "verifier-inconclusive",
    });
    expect(decisions().map((d) => d.action)).toEqual(["skip"]);
    expect(writer.calls).toHaveLength(1);
  });

  it("records a terminal skip when there is nothing supported to write", async () => {
    const empty = JSON.stringify({ summary: "s", themes: [], errors: [] });
    const r = await worker(fake("writer", [empty]).p, fake("verifier", []).p).handle(
      await briefMessage(),
    );
    expect(r).toEqual({ kind: "no-supported-errors" });
    expect(decisions()).toMatchObject([{ revision: 0, action: "skip" }]);
  });

  it("bounds malformed writer output and then records an explicit skip", async () => {
    const writer = fake("writer", Array(9).fill("not json"));
    const w = new RevisionWorker({
      artifacts,
      operations,
      writer: writer.p,
      verifier: fake("v", []).p,
      owner: "rev",
      retryDelayMs: 0,
      maxInconclusive: 1,
    });
    expect(await w.handle(await briefMessage())).toMatchObject({
      kind: "pending",
      reason: "writer:inconclusive",
    });
    expect(await w.handle(await briefMessage())).toMatchObject({
      kind: "skipped",
      reason: "writer-inconclusive",
    });
    expect(decisions().map((d) => d.action)).toEqual(["skip"]);
  });

  it("links each revision to the preceding attempt record", async () => {
    await worker(
      fake("writer", [draftJson("medium"), draftJson("high")]).p,
      fake("verifier", [REDRAFT, APPROVE]).p,
    ).handle(await briefMessage());
    const [first, second] = decisions();
    const record = JSON.parse(
      await artifacts.read({
        ...second!.record,
        sha256: second!.record.hash.replace("sha256:", ""),
      }),
    );
    expect(record.previous).toEqual(first!.record);
  });

  it("answers a duplicate event from stored state with no model calls", async () => {
    await worker(fake("writer", [draftJson("medium")]).p, fake("verifier", [APPROVE]).p).handle(
      await briefMessage(),
    );
    const writer = fake("writer", []);
    const verifier = fake("verifier", []);
    const again = await briefMessage();
    expect(await worker(writer.p, verifier.p).handle(again)).toMatchObject({
      kind: "approved",
      revision: 0,
    });
    expect(again.acks).toBe(1);
    expect(writer.calls).toHaveLength(0);
    expect(verifier.calls).toHaveLength(0);
    expect(decisions()).toHaveLength(1);
  });

  it("terminates malformed events", async () => {
    const m = await briefMessage();
    m.data = new TextEncoder().encode("{}");
    expect(await worker(fake("w", []).p, fake("v", []).p).handle(m)).toEqual({
      kind: "invalid-event",
    });
    expect(m.terms).toBe(1);
  });
});
