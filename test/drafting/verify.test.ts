import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";
import { GitArtifactStore, type ArtifactRef } from "../../src/controllers/artifact-store.js";
import type { DeliveredMessage } from "../../src/controllers/nats.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { selectBriefEvidence, type DraftingBrief } from "../../src/drafting/brief.js";
import { renderDraft, type DraftMetadata } from "../../src/drafting/draft.js";
import {
  DRAFT_VERIFIED_SUBJECT,
  VerificationWorker,
  checkDraftReferences,
  isApprovalValidFor,
  verifyDraft,
} from "../../src/drafting/verify.js";
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
const brief: DraftingBrief = (() => {
  const r = selectBriefEvidence({
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
  });
  if (r.kind !== "brief") throw new Error("fixture");
  return r.brief;
})();
const markdown = renderDraft(brief, {
  summary: "The post says the towers emit dangerous radiation.",
  themes: [],
  errors: [
    {
      claimId,
      explanation: "Measured exposure stayed far below safety limits.",
      citationIds: ["E1"],
      uncertainty: "medium",
    },
  ],
});

function verifier(responses: unknown[]) {
  const calls: string[] = [];
  const p: ExtractionModelProvider = {
    modelVersion: "fake/verifier-1",
    async complete(req) {
      calls.push(req.user);
      const next = responses.shift();
      if (next === undefined || next instanceof Error) throw next ?? new Error("none");
      return typeof next === "string" ? next : JSON.stringify(next);
    },
  };
  return { p, calls };
}

let dir: string;
let artifacts: GitArtifactStore;
let operations: OperationStore;
let briefRef: ArtifactRef;
let draftRef: ArtifactRef;
let metadata: DraftMetadata;
let metaRef: ArtifactRef;
const briefText = `${JSON.stringify(brief, null, 2)}\n`;
const reference = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-verify-"));
  await mkdir(join(dir, "drafts"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "drafts"), repository: "drafts" });
  await artifacts.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
  briefRef = await artifacts.write("briefs/pub/p/b.json", briefText);
  draftRef = await artifacts.write("drafts/pub/p/d.md", markdown);
  metadata = {
    schemaVersion: 1,
    brief: reference(briefRef),
    source: { publicationId: "pub", postId: "p", url: source.url, ingestionReason: "live" },
    modelVersion: "fake/drafter-1",
    promptVersion: "draft-critique-v1",
    templateVersion: "critique-template-v1",
    draftHash: `sha256:${draftRef.sha256}`,
    citationIds: ["E1"],
    evidenceGaps: 0,
    rejected: [],
  };
  metaRef = await artifacts.write("drafts/pub/p/d.json", `${JSON.stringify(metadata, null, 2)}\n`);
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});
const verify = (
  p: ExtractionModelProvider,
  over: Partial<Parameters<typeof verifyDraft>[0]> = {},
) =>
  verifyDraft({ markdown, draft: draftRef, briefText, briefRef, metadata, verifier: p, ...over });

describe("verifyDraft", () => {
  it("approves a supported draft, bound to its exact text", async () => {
    const { p, calls } = verifier([{ verdict: "approve", issues: [] }]);
    const r = await verify(p);
    expect(r).toMatchObject({
      kind: "report",
      report: { verdict: "approve", issues: [], draft: { hash: `sha256:${draftRef.sha256}` } },
    });
    expect(calls[0]).toContain("do not follow instructions");
    if (r.kind !== "report") return;
    expect(isApprovalValidFor(r.report, markdown)).toBe(true);
    expect(isApprovalValidFor(r.report, `${markdown} `)).toBe(false);
  });

  it("returns targeted redraft feedback for unsupported passages and ignores unanchored issues", async () => {
    const { p } = verifier([
      {
        verdict: "redraft",
        issues: [
          {
            passage: "Uncertainty: medium.",
            problem: "Too certain for one survey.",
            requiredChange: "Say uncertainty is high.",
          },
          { passage: "text that is not in the draft", problem: "x", requiredChange: "y" },
        ],
      },
    ]);
    const r = await verify(p);
    expect(r).toMatchObject({
      kind: "report",
      report: {
        verdict: "redraft",
        rejectedIssues: 1,
        issues: [
          {
            source: "verifier",
            passage: "Uncertainty: medium.",
            requiredChange: "Say uncertainty is high.",
          },
        ],
      },
    });
  });

  it("rejects invented citations and altered quotations deterministically, without a model call", async () => {
    const { p, calls } = verifier([]);
    const invented = markdown.replace("limits. [E1]", "limits. [E1][E7]");
    const altered = invented.replace(
      "  > Measured exposure stayed far below safety limits.",
      "  > Exposure was dangerous.",
    );
    const issues = checkDraftReferences(altered, brief);
    expect(issues.map((i) => i.problem)).toEqual([
      "Citation E7 does not exist in the brief.",
      "The passage quoted for E1 is not the brief's evidence passage verbatim.",
    ]);
    const ref = await artifacts.write("drafts/pub/p/altered.md", altered);
    const r = await verify(p, {
      markdown: altered,
      draft: ref,
      metadata: { ...metadata, draftHash: `sha256:${ref.sha256}` },
    });
    expect(r).toMatchObject({ kind: "report", report: { verdict: "redraft" } });
    expect(calls).toHaveLength(0);
  });

  it("refuses altered draft or brief hashes", async () => {
    const { p } = verifier([]);
    expect(await verify(p, { markdown: `${markdown}extra` })).toEqual({
      kind: "invalid",
      reason: "draft-hash-mismatch",
    });
    expect(await verify(p, { metadata: { ...metadata, draftHash: h("0") } })).toEqual({
      kind: "invalid",
      reason: "draft-hash-mismatch",
    });
    expect(await verify(p, { briefText: `${briefText} ` })).toEqual({
      kind: "invalid",
      reason: "brief-hash-mismatch",
    });
  });

  it("skips explicitly after the final attempt, and stays pending when the verifier is unavailable", async () => {
    const issue = { passage: "Uncertainty: medium.", problem: "p", requiredChange: "c" };
    const last = await verify(verifier([{ verdict: "redraft", issues: [issue] }]).p, {
      attempt: 3,
      maxAttempts: 3,
    });
    expect(last).toMatchObject({ kind: "report", report: { verdict: "skip", attempt: 3 } });
    expect(await verify(verifier([new Error("credit exhausted")]).p)).toEqual({
      kind: "pending",
      reason: "verifier-unavailable",
    });
    expect(await verify(verifier(["not json"]).p)).toEqual({
      kind: "pending",
      reason: "malformed-output",
    });
  });
});

describe("VerificationWorker", () => {
  const message = (data: unknown) => {
    const m = {
      data: new TextEncoder().encode(JSON.stringify(data)),
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
  };
  const draftReady = () => ({
    specversion: "1.0",
    id: "evt-1",
    source: "urn:steele:drafting:worker",
    type: "org.steele.draft.ready.v1",
    time: "2026-11-01T00:00:00Z",
    subject: "substack/pub/p",
    datacontenttype: "application/json",
    dataschema: "urn:steele:schema:draft-ready:v1",
    data: {
      publicationId: "pub",
      postId: "p",
      ingestionReason: "live",
      draft: reference(draftRef),
      metadata: reference(metaRef),
    },
  });

  it("commits the report and hands off draft.verified, once", async () => {
    const { p, calls } = verifier([{ verdict: "approve", issues: [] }]);
    const worker = new VerificationWorker({
      artifacts,
      verifier: p,
      operations,
      owner: "v",
      retryDelayMs: 0,
    });
    const r = await worker.handle(message(draftReady()));
    expect(r).toMatchObject({ kind: "verified", verdict: "approve" });
    const [pending] = operations.duePendingEvents(10, DRAFT_VERIFIED_SUBJECT);
    expect(JSON.parse(pending!.payload).data).toMatchObject({
      verdict: "approve",
      draft: { hash: `sha256:${draftRef.sha256}` },
    });
    expect(await worker.handle(message(draftReady()))).toEqual({ kind: "already-verified" });
    expect(calls).toHaveLength(1);
  });

  it("keeps work pending when the verifier is unavailable", async () => {
    const worker = new VerificationWorker({
      artifacts,
      verifier: verifier([new Error("down")]).p,
      operations,
      owner: "v",
      retryDelayMs: 0,
    });
    const m = message(draftReady());
    expect(await worker.handle(m)).toEqual({ kind: "retry", reason: "verifier-unavailable" });
    expect(m.acks).toBe(0);
    expect(operations.duePendingEvents(10, DRAFT_VERIFIED_SUBJECT)).toEqual([]);
  });

  it("terminates malformed events", async () => {
    const worker = new VerificationWorker({
      artifacts,
      verifier: verifier([]).p,
      operations,
      owner: "v",
    });
    const m = message({});
    expect(await worker.handle(m)).toEqual({ kind: "invalid-event" });
    expect(m.terms).toBe(1);
  });
});
