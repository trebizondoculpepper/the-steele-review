import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ComparisonResult } from "../../src/analysis/historical-comparison.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  BRIEF_READY_SUBJECT,
  DraftingBriefSchema,
  saveDraftingBrief,
  selectBriefEvidence,
  type BriefInput,
} from "../../src/drafting/brief.js";
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
const evidence = (url: string) => ({
  kind: "external" as const,
  url,
  title: "Synthetic source",
  retrievedAt: "2026-01-01T00:00:00Z",
  lastCheckedAt: "2026-10-01T00:00:00Z",
  passage: "Measured exposure stayed far below safety limits.",
});
const entryArtifact = {
  repository: "research",
  commit: "e".repeat(40),
  path: "research/towers.json",
  hash: h("f"),
};
const assessment = (claimId: string, urls: string[], gaps: string[] = []): ApplicabilityResult => ({
  status: "complete",
  claimId,
  assessments: [
    {
      entryId: "towers",
      revision: 2,
      applicability: urls.length ? "applicable" : "not-applicable",
      rationale: { text: "r", generatedBy: "m", isEvidence: false },
      limitations: ["Typical installations only."],
      unresolved: [],
    },
  ],
  selected: urls.map((u) => ({
    entryId: "towers",
    revision: 2,
    entryArtifact,
    evidence: evidence(u),
  })),
  outdated: [],
  gaps,
  rejected: [],
  omitted: [],
  modelVersion: "m",
  promptVersion: "p",
});
const history = (claimId: string, current = artifact): ComparisonResult => ({
  status: "complete",
  claimId,
  findings: [
    {
      kind: "repetition",
      explanation: { text: "x", generatedBy: "m", isEvidence: false },
      uncertainty: "low",
      current: {
        claimId,
        quote: "The towers",
        artifact: current,
        sourceVersion: source.sourceVersion,
        start: 0,
        end: 10,
      },
      earlier: [],
    },
  ],
  rejected: [],
  modelVersion: "m",
  promptVersion: "p",
});

const input = (over: Partial<BriefInput> = {}): BriefInput => ({
  source,
  claims: [towers, fees],
  assessments: [
    assessment(
      towers.id,
      ["https://example.org/a", "https://example.org/b"],
      ["Where exactly residents measured"],
    ),
    assessment(fees.id, []),
  ],
  ...over,
});

describe("selectBriefEvidence", () => {
  it("includes supported claims with citation IDs and exact versions, and lists unsupported ones as gaps", () => {
    const r = selectBriefEvidence(input());
    expect(r.kind).toBe("brief");
    if (r.kind !== "brief") return;
    expect(DraftingBriefSchema.parse(r.brief)).toEqual(r.brief);
    expect(r.brief.claims).toEqual([
      expect.objectContaining({
        claimId: towers.id,
        citationIds: ["E1", "E2"],
        limitations: ["Typical installations only."],
        gaps: ["Where exactly residents measured"],
      }),
    ]);
    expect(r.brief.citations[0]).toMatchObject({
      citationId: "E1",
      entryId: "towers",
      entryRevision: 2,
      entryArtifact,
    });
    expect(r.brief.evidenceGaps).toEqual([
      { claimId: fees.id, statement: fees.statement, gaps: [fees.statement] },
    ]);
    expect(r.brief.source).toEqual(source);
  });

  it("does not need historical findings, but keeps them when supplied", () => {
    const without = selectBriefEvidence(input());
    const withHistory = selectBriefEvidence(input({ comparisons: [history(towers.id)] }));
    expect(without.kind === "brief" && without.brief.history).toEqual([]);
    expect(withHistory.kind === "brief" && withHistory.brief.history).toHaveLength(1);
  });

  it("returns an explicit gap when no claim has material evidence", () => {
    const r = selectBriefEvidence(
      input({ assessments: [assessment(towers.id, []), assessment(fees.id, [])] }),
    );
    expect(r).toMatchObject({
      kind: "evidence-gap",
      gaps: [{ claimId: towers.id }, { claimId: fees.id }],
    });
  });

  it("rejects provenance mismatches", () => {
    const otherVersion = { ...towers, sourceVersion: h("9") };
    expect(selectBriefEvidence(input({ claims: [otherVersion, fees] })).kind).toBe(
      "provenance-mismatch",
    );
    expect(
      selectBriefEvidence(input({ assessments: [assessment(h("7"), ["https://example.org/a"])] }))
        .kind,
    ).toBe("provenance-mismatch");
    const otherArtifact = { ...artifact, commit: "c".repeat(40) };
    expect(
      selectBriefEvidence(input({ comparisons: [history(towers.id, otherArtifact)] })).kind,
    ).toBe("provenance-mismatch");
  });

  it("deduplicates one evidence item cited by two claims", () => {
    const r = selectBriefEvidence(
      input({
        assessments: [
          assessment(towers.id, ["https://example.org/a"]),
          assessment(fees.id, ["https://example.org/a"]),
        ],
      }),
    );
    expect(r.kind === "brief" && r.brief.citations).toHaveLength(1);
    expect(r.kind === "brief" && r.brief.claims.map((c) => c.citationIds)).toEqual([
      ["E1"],
      ["E1"],
    ]);
  });
});

describe("saveDraftingBrief", () => {
  let dir: string;
  let artifacts: GitArtifactStore;
  let operations: OperationStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "steele-brief-"));
    await mkdir(join(dir, "archive"));
    artifacts = new GitArtifactStore({ repoPath: join(dir, "archive"), repository: "drafts" });
    await artifacts.initialise();
    operations = new OperationStore({ path: join(dir, "state.sqlite") });
  });
  afterEach(async () => {
    operations.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("saves an immutable brief, hands off a pointer after the save and reuses it on repeat", async () => {
    const first = await saveDraftingBrief({ brief: input(), artifacts, operations, owner: "w" });
    expect(first).toMatchObject({ kind: "saved", reused: false });
    if (first.kind !== "saved") return;
    expect(first.artifact.path).toMatch(/^briefs\/pub\/p\/[0-9a-f]{64}\.json$/);
    const pending = operations.duePendingEvents(10, BRIEF_READY_SUBJECT);
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0]!.payload).data).toMatchObject({
      brief: { path: first.artifact.path, commit: first.artifact.commit },
      ingestionReason: "live",
      claims: 1,
      evidenceGaps: 1,
    });
    const again = await saveDraftingBrief({ brief: input(), artifacts, operations, owner: "w" });
    expect(again).toMatchObject({ kind: "saved", reused: true });
    expect(operations.duePendingEvents(10, BRIEF_READY_SUBJECT)).toHaveLength(1);
  });

  it("saves nothing for an evidence gap or provenance mismatch", async () => {
    const gap = await saveDraftingBrief({
      brief: input({ assessments: [assessment(towers.id, [])] }),
      artifacts,
      operations,
      owner: "w",
    });
    expect(gap.kind).toBe("evidence-gap");
    const mismatch = await saveDraftingBrief({
      brief: input({ claims: [{ ...towers, sourceVersion: h("9") }] }),
      artifacts,
      operations,
      owner: "w",
    });
    expect(mismatch.kind).toBe("provenance-mismatch");
    // Nothing was committed: the archive has no commits at all.
    expect(await artifacts.lookup("briefs/pub/p/none.json")).toBeUndefined();
    expect(operations.duePendingEvents(10)).toEqual([]);
  });
});
