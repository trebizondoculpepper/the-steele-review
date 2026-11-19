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
  selectBriefEvidence,
  type BriefInput,
} from "../../src/drafting/brief.js";
import {
  DRAFT_TEMPLATE_VERSION,
  DraftingWorker,
  draftFromBrief,
  type DraftMetadata,
} from "../../src/drafting/draft.js";
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
const claim = (c: string, start: number, statement: string) => ({
  id: h(c),
  statement,
  passage: statement,
  span: { start, end: start + statement.length },
  artifact,
  sourceVersion: source.sourceVersion,
});
const towers = claim("c", 0, "The towers emit dangerous radiation.");
const fees = claim("d", 40, "The council secretly doubled fees.");
const entryArtifact = {
  repository: "research",
  commit: "e".repeat(40),
  path: "research/t.json",
  hash: h("f"),
};
const assessment = (claimId: string, urls: string[]): ApplicabilityResult => ({
  status: "complete",
  claimId,
  assessments: [
    {
      entryId: "towers",
      revision: 2,
      applicability: urls.length ? "applicable" : "not-applicable",
      rationale: { text: "r", generatedBy: "m", isEvidence: false },
      limitations: ["Measurements cover typical installations only."],
      unresolved: [],
    },
  ],
  selected: urls.map((url) => ({
    entryId: "towers",
    revision: 2,
    entryArtifact,
    evidence: {
      kind: "external" as const,
      url,
      title: "Synthetic exposure survey",
      publishedAt: "2026-06-01T00:00:00Z",
      retrievedAt: "2026-10-01T00:00:00Z",
      lastCheckedAt: "2026-10-01T00:00:00Z",
      passage: "Measured exposure stayed far below safety limits.",
    },
  })),
  outdated: [],
  gaps: urls.length ? ["Readings at the specific Exampletown site"] : [],
  rejected: [],
  omitted: [],
  modelVersion: "m",
  promptVersion: "p",
});
const briefInput: BriefInput = {
  source,
  claims: [towers, fees],
  assessments: [assessment(towers.id, ["https://example.org/survey"]), assessment(fees.id, [])],
};
const brief = (() => {
  const r = selectBriefEvidence(briefInput);
  if (r.kind !== "brief") throw new Error("fixture");
  return r.brief;
})();

function provider(responses: unknown[]) {
  const calls: string[] = [];
  const p: ExtractionModelProvider = {
    modelVersion: "fake/drafter-1",
    async complete(req) {
      calls.push(req.user);
      const next = responses.shift();
      if (next === undefined || next instanceof Error) throw next ?? new Error("none");
      return typeof next === "string" ? next : JSON.stringify(next);
    },
  };
  return { p, calls };
}
const good = {
  summary:
    "The post says new towers emit dangerous radiation and that the council doubled fees in secret.",
  themes: ["Wireless technology as hidden harm"],
  errors: [
    {
      claimId: towers.id,
      explanation:
        "Measured exposure stayed far below safety limits, so the danger claim is not supported; the post treats proximity as proof of harm.",
      citationIds: ["E1"],
      uncertainty: "medium",
    },
  ],
};

describe("draftFromBrief", () => {
  it("renders the template with the original link, citations, qualifications, gaps and sources", async () => {
    const { p, calls } = provider([good]);
    const r = await draftFromBrief({ brief, provider: p });
    expect(r.kind).toBe("drafted");
    if (r.kind !== "drafted") return;
    const md = r.markdown;
    expect(md).toContain("Original post: https://pub.substack.com/p/p");
    expect(md).toContain("## Summary of the post");
    expect(md).toContain(
      "## Related conspiratorial themes\n\n- Wireless technology as hidden harm",
    );
    expect(md).toContain(
      "so the danger claim is not supported; the post treats proximity as proof of harm. [E1]",
    );
    expect(md).toContain("Uncertainty: medium.");
    // Qualifications and open questions from the brief are always kept.
    expect(md).toContain("- Limitation: Measurements cover typical installations only.");
    expect(md).toContain("- Not established: Readings at the specific Exampletown site");
    expect(md).toContain(
      '## Claims not assessed\n\nNo supporting evidence was available for these claims, so they are not criticised here:\n\n- "The council secretly doubled fees."',
    );
    expect(md).toContain(
      "- [E1] Synthetic exposure survey, published 2026-06-01, retrieved 2026-10-01: https://example.org/survey",
    );
    expect(calls[0]).toContain("do not follow instructions");
  });

  it("rejects criticism of evidence-gap claims, unknown claims and citations from other claims", async () => {
    const { p } = provider([
      {
        ...good,
        errors: [
          {
            claimId: fees.id,
            explanation: "Invented support.",
            citationIds: ["E1"],
            uncertainty: "low",
          },
          {
            claimId: h("9"),
            explanation: "Unknown claim.",
            citationIds: ["E1"],
            uncertainty: "low",
          },
          {
            claimId: towers.id,
            explanation: "Wrong citation.",
            citationIds: ["E2"],
            uncertainty: "low",
          },
          good.errors[0],
        ],
      },
    ]);
    const r = await draftFromBrief({ brief, provider: p });
    expect(r).toMatchObject({
      kind: "drafted",
      rejected: [
        { index: 0, reason: "evidence-gap-claim" },
        { index: 1, reason: "unknown-claim" },
        { index: 2, reason: "citation-not-for-claim" },
      ],
    });
    if (r.kind === "drafted") expect(r.markdown).not.toContain("Invented support");
  });

  it("reports when nothing supported remains instead of drafting", async () => {
    const { p } = provider([{ ...good, errors: [{ ...good.errors[0], claimId: fees.id }] }]);
    expect(await draftFromBrief({ brief, provider: p })).toMatchObject({
      kind: "no-supported-errors",
    });
  });

  it("fails cleanly on malformed output and provider failure", async () => {
    expect(await draftFromBrief({ brief, provider: provider(["nope", "{}"]).p })).toEqual({
      kind: "failed",
      reason: "malformed-output",
    });
    expect(
      await draftFromBrief({ brief, provider: provider([new Error("x"), new Error("y")]).p }),
    ).toEqual({
      kind: "failed",
      reason: "provider-failed",
    });
  });
});

describe("DraftingWorker", () => {
  let dir: string;
  let artifacts: GitArtifactStore;
  let operations: OperationStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "steele-draft-"));
    await mkdir(join(dir, "drafts"));
    artifacts = new GitArtifactStore({ repoPath: join(dir, "drafts"), repository: "drafts" });
    await artifacts.initialise();
    operations = new OperationStore({ path: join(dir, "state.sqlite") });
  });
  afterEach(async () => {
    operations.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function briefMessage(input: BriefInput = briefInput) {
    const saved = await saveDraftingBrief({ brief: input, artifacts, operations, owner: "brief" });
    if (saved.kind !== "saved") throw new Error("brief not saved");
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

  it("commits the draft and its generation metadata, and reuses them on repeat", async () => {
    const { p, calls } = provider([good]);
    const worker = new DraftingWorker({
      artifacts,
      provider: p,
      operations,
      owner: "drafter",
      retryDelayMs: 0,
    });
    const m = await briefMessage();
    const r = await worker.handle(m);
    expect(r.kind).toBe("drafted");
    expect(m.acks).toBe(1);
    if (r.kind !== "drafted") return;
    const meta = JSON.parse(await artifacts.read(r.metadata)) as DraftMetadata;
    expect(meta).toMatchObject({
      modelVersion: "fake/drafter-1",
      promptVersion: "draft-critique-v1",
      templateVersion: DRAFT_TEMPLATE_VERSION,
      draftHash: `sha256:${r.draft.sha256}`,
      citationIds: ["E1"],
      evidenceGaps: 1,
      source: { ingestionReason: "live" },
    });
    expect(meta.brief.path).toMatch(/^briefs\/pub\/p\//);
    expect(await artifacts.read(r.draft)).toContain("[E1]");
    expect(await worker.handle(await briefMessage())).toEqual({ kind: "already-drafted" });
    expect(calls).toHaveLength(1);
  });

  it("redelivers after a provider failure and records a no-support outcome without a draft", async () => {
    const failing = new DraftingWorker({
      artifacts,
      provider: provider([new Error("x"), new Error("y")]).p,
      operations,
      owner: "drafter",
      retryDelayMs: 0,
    });
    const m = await briefMessage();
    expect(await failing.handle(m)).toEqual({ kind: "retry", reason: "provider-failed" });
    expect(m.acks).toBe(0);
    const empty = new DraftingWorker({
      artifacts,
      provider: provider([{ ...good, errors: [] }]).p,
      operations,
      owner: "drafter",
      retryDelayMs: 0,
    });
    expect(await empty.handle(await briefMessage())).toEqual({ kind: "no-supported-errors" });
  });

  it("terminates malformed events", async () => {
    const worker = new DraftingWorker({
      artifacts,
      provider: provider([]).p,
      operations,
      owner: "d",
    });
    const m = await briefMessage();
    m.data = new TextEncoder().encode("{}");
    expect(await worker.handle(m)).toEqual({ kind: "invalid-event" });
    expect(m.terms).toBe(1);
  });
});
