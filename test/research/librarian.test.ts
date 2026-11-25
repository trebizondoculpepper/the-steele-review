import {
  PERIOD_NOT_ANCHORED,
  PERIOD_NOT_STATED,
} from "../../src/research/reporting-period.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { proposeThemes } from "../../src/analysis/theme-proposals.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import {
  type ArtifactRef,
  GitArtifactStore,
} from "../../src/controllers/artifact-store.js";
import { DossierStore } from "../../src/research/dossier.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { runResearchJob } from "../../src/research/runner.js";
import { researchJobId, type ResearchRequest } from "../../src/research/job.js";
import {
  type Commission,
  EmbeddingShortlister,
  LexicalShortlister,
  assessPostCoverage,
  mergeCoverage,
} from "../../src/research/librarian.js";

const TEXT =
  "A treaty bans weather weapons. They paid 56 million for the attack.";
const SHARED = "https://treaties.un.org/enmod";

let dir: string;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-librarian-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await artifacts.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function analysis(
  postId: string,
  claims: {
    id: string;
    statement: string;
    reportingPeriod?: { dependsOnPeriod: boolean; text?: string };
  }[],
  title = "Weather warfare",
  schemaVersion: 2 | 3 = 2,
  description = "Claims of weather modification as a weapon",
) {
  const post = { publicationId: "pub", postId };
  await proposeThemes({
    provider: {
      modelVersion: "fake/m",
      complete: async () =>
        JSON.stringify({
          themes: [{ title, description }],
        }),
    },
    artifacts,
    post,
    source: {
      text: TEXT,
      sourceVersion: sourceVersionFor(TEXT),
      artifact: {
        repository: "archive",
        commit: "a".repeat(40),
        path: `substack/pub/${postId}/collected.json`,
        hash: `sha256:${"b".repeat(64)}`,
      },
    },
  });
  const [themePath] = await artifacts.list(`theme-proposals/pub/${postId}`, 10);
  const themeResult = (await artifacts.lookup(themePath))!;
  const proposalId = JSON.parse(await artifacts.read(themeResult)).proposals[0]
    .id as string;
  const claimResult = await artifacts.write(
    `claim-extractions/pub/${postId}/r.json`,
    JSON.stringify({
      schemaVersion,
      post,
      sourceVersion: sourceVersionFor(TEXT),
      themeIds: [proposalId],
      themeResult: `${themeResult.commit}:${themeResult.path}`,
      claims: claims.map((c) => ({
        claim: {
          statement: c.statement,
          ...(c.reportingPeriod ? { reportingPeriod: c.reportingPeriod } : {}),
        },
        occurrence: {},
        kind: "assertion",
        themeIds: [proposalId],
        classification: "themed",
        claimRecordId: c.id,
      })),
      candidates: [],
      rejected: [],
      extraction: {
        modelVersion: "m",
        promptVersion: "p",
        extractedAt: "2026-01-01T00:00:00Z",
      },
    }),
  );
  return { themeResult, claimResult };
}

const ref = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

/** A researcher stand-in: saves a manifest/result per request and records calls. */
function researcher(
  plan: (req: ResearchRequest) =>
    | "busy"
    | "failed"
    | {
        passages: { claimRecordId: string; url: string; monitored?: boolean }[];
      },
) {
  const requests: ResearchRequest[] = [];
  const commission: Commission = async (request) => {
    requests.push(request);
    const jobId = researchJobId(request);
    // As in production (research/job.ts), the exact request is saved before the job runs.
    if (!(await artifacts.lookup(`research-jobs/${jobId}/request.json`)))
      await artifacts.write(
        `research-jobs/${jobId}/request.json`,
        JSON.stringify(request),
      );
    const outcome = plan(request);
    if (outcome === "busy") return { jobId, status: "busy" };
    if (outcome === "failed") {
      const result = {
        schemaVersion: 1 as const,
        jobId,
        outcome: "failed" as const,
        failure: "provider-error" as const,
        finishedAt: "2026-01-01T00:00:00Z",
      };
      const resultRef = await artifacts.write(
        `research-jobs/${jobId}/result.json`,
        JSON.stringify(result),
      );
      return { jobId, status: "finished", result, resultRef };
    }
    const urls = [...new Set(outcome.passages.map((p) => p.url))];
    // The production runner's saved report (research/runner.ts).
    const report = await artifacts.write(
      `research-jobs/${jobId}/report.json`,
      JSON.stringify({
        schemaVersion: 1,
        jobId,
        promptVersion: "fixture",
        model: "fixture",
        report: "# report",
        citations: urls,
      }),
    );
    const manifest = await artifacts.write(
      `research-jobs/${jobId}/manifest.json`,
      JSON.stringify({
        schemaVersion: 1,
        jobId,
        report: ref(report),
        citations: urls.map((url) => ({
          url,
          retrieval: "archived",
          ...(outcome.passages.find((p) => p.url === url)?.monitored
            ? { sourceType: "monitored-source", support: "unverified" }
            : { support: "supported" }),
          passages: outcome.passages
            .filter((p) => p.url === url)
            .map((p) => ({
              claimRecordId: p.claimRecordId,
              passage: `Article I text for ${p.claimRecordId}`,
            })),
        })),
        gaps: [],
        provider: { model: "fixture" },
      }),
    );
    const result = {
      schemaVersion: 1 as const,
      jobId,
      outcome: "complete-with-gaps" as const,
      manifest: ref(manifest),
      finishedAt: "2026-01-01T00:00:00Z",
    };
    const resultRef = await artifacts.write(
      `research-jobs/${jobId}/result.json`,
      JSON.stringify(result),
    );
    return { jobId, status: "finished", result, resultRef };
  };
  return { commission, requests };
}

const claims = [
  {
    id: "claim-treaty",
    statement: "A treaty prohibits hostile environmental modification",
  },
  {
    id: "claim-payment",
    statement: "A payment of 56 million funded an attack",
  },
];

describe("librarian coverage", { timeout: 60_000 }, () => {
  it("records separate decisions for two claims sharing one source, with exact references", async () => {
    const { themeResult, claimResult } = await analysis("p1", claims);
    const r = researcher(() => ({
      passages: [{ claimRecordId: "claim-treaty", url: SHARED }],
    }));
    const { record, ref: coverageRef } = await assessPostCoverage({
      artifacts,
      themeResult,
      claimResult,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    // One grouped request for both claims.
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0].claims.map((c) => c.claimRecordId).sort()).toEqual([
      "claim-payment",
      "claim-treaty",
    ]);
    const by = Object.fromEntries(
      record.claims.map((c) => [c.claimRecordId, c]),
    );
    expect(by["claim-treaty"]).toMatchObject({
      status: "evidence-found",
      citations: [{ url: SHARED }],
    });
    expect(by["claim-payment"]).toMatchObject({
      status: "no-independent-evidence",
    });
    expect(record.themeResult.path).toBe(themeResult.path);
    expect(record.claimResult.path).toBe(claimResult.path);
    expect(record.mappings[0]).toMatchObject({
      created: true,
      method: "lexical",
    });
    expect(record.jobs[0].manifest).toBeDefined();
    expect(coverageRef.path).toMatch(/^librarian\/coverage\/pub\/p1\//);
    // The dossier records both decisions against the same theme.
    const dossier = (await new DossierStore(artifacts).current(
      record.mappings[0].dossierId,
    ))!;
    expect(
      dossier.metadata.claims.find((c) => c.claimId === "claim-treaty"),
    ).toMatchObject({
      status: "covered",
    });
    expect(
      dossier.metadata.claims.find((c) => c.claimId === "claim-payment"),
    ).toMatchObject({
      status: "gap",
    });
    expect(record.dossiers[0].ref.commit).toBe(dossier.ref.commit);
  });

  it("reuses evidence for a covered claim in a later post and maps to the existing dossier", async () => {
    const first = await analysis("p1", claims);
    const r = researcher(() => ({
      passages: [{ claimRecordId: "claim-treaty", url: SHARED }],
    }));
    const one = await assessPostCoverage({
      artifacts,
      ...first,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    const second = await analysis("p2", [claims[0]], "Weather warfare");
    const two = await assessPostCoverage({
      artifacts,
      ...second,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    expect(r.requests).toHaveLength(1); // no new research
    expect(two.record.mappings[0]).toMatchObject({
      dossierId: one.record.mappings[0].dossierId,
      created: false,
    });
    expect(two.record.claims[0]).toMatchObject({
      status: "evidence-found",
      reused: true,
    });
  });

  it("leaves an explicit gap for a failed job and reports a running job as pending without touching the dossier", async () => {
    const failed = await analysis("p1", claims);
    const f = await assessPostCoverage({
      artifacts,
      ...failed,
      commission: researcher(() => "failed").commission,
      shortlister: new LexicalShortlister(),
    });
    expect(f.record.claims.every((c) => c.status === "research-failed")).toBe(
      true,
    );
    const d = (await new DossierStore(artifacts).current(
      f.record.mappings[0].dossierId,
    ))!;
    expect(d.metadata.claims.every((c) => c.status === "gap")).toBe(true);

    const pending = await analysis(
      "p3",
      [{ id: "claim-new", statement: "Something else entirely" }],
      "Unrelated subject",
    );
    const p = await assessPostCoverage({
      artifacts,
      ...pending,
      commission: researcher(() => "busy").commission,
      shortlister: new LexicalShortlister(),
    });
    expect(p.record.claims[0].status).toBe("pending");
    expect(
      await new DossierStore(artifacts).current(p.record.mappings[0].dossierId),
    ).toBeUndefined();
  });

  it("distinguishes claimant-only attribution from independent evidence", async () => {
    const a = await analysis("p1", [claims[1]]);
    const r = researcher(() => ({
      passages: [
        {
          claimRecordId: "claim-payment",
          url: "https://pub.substack.com/p/x",
          monitored: true,
        },
      ],
    }));
    const out = await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    expect(out.record.claims[0].status).toBe("claimant-only");
  });

  it("commissions one targeted second pass only for consequential unsupported claims", async () => {
    const a = await analysis("p1", claims);
    const r = researcher((req) =>
      req.pass === 1
        ? { passages: [{ claimRecordId: "claim-treaty", url: SHARED }] }
        : {
            passages: [
              {
                claimRecordId: "claim-payment",
                url: "https://www.gov.uk/payment-record",
              },
            ],
          },
    );
    const out = await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
      consequential: (c) => c.claimRecordId === "claim-payment",
    });
    expect(r.requests.map((q) => [q.pass, q.claims.length])).toEqual([
      [1, 2],
      [2, 1],
    ]);
    expect(r.requests[1].previousJobId).toBe(out.record.jobs[0].jobId);
    const payment = out.record.claims.find(
      (c) => c.claimRecordId === "claim-payment",
    )!;
    expect(payment).toMatchObject({ status: "evidence-found" });
    expect(payment.jobIds).toHaveLength(2);
  });

  it("reassessing the same analysis reuses its jobs instead of commissioning new research", async () => {
    const a = await analysis("p1", claims);
    const r = researcher(() => "failed");
    await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    expect(new Set(r.requests.map((q) => researchJobId(q))).size).toBe(1);
  });

  it("records a pending second pass instead of keeping the first-pass gap", async () => {
    const a = await analysis("p1", claims);
    const r = researcher((req) =>
      req.pass === 1
        ? { passages: [{ claimRecordId: "claim-treaty", url: SHARED }] }
        : "busy",
    );
    const out = await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
      consequential: (c) => c.claimRecordId === "claim-payment",
    });
    expect(
      out.record.claims.find((c) => c.claimRecordId === "claim-payment")
        ?.status,
    ).toBe("pending");
  });

  it("marks claimant-only per claim, not for every claim in a grouped job", async () => {
    const a = await analysis("p1", claims);
    const r = researcher(() => ({
      passages: [
        {
          claimRecordId: "claim-payment",
          url: "https://pub.substack.com/p/x",
          monitored: true,
        },
      ],
    }));
    const out = await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    const by = Object.fromEntries(
      out.record.claims.map((c) => [c.claimRecordId, c.status]),
    );
    expect(by).toEqual({
      "claim-payment": "claimant-only",
      "claim-treaty": "no-independent-evidence",
    });
  });

  it("keeps the same request after partial success, so reassessment never re-researches", async () => {
    const a = await analysis("p1", claims);
    const r = researcher(() => ({
      passages: [{ claimRecordId: "claim-treaty", url: SHARED }],
    }));
    const one = await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    const two = await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    expect(new Set(r.requests.map((q) => researchJobId(q))).size).toBe(1);
    const treaty = two.record.claims.find(
      (c) => c.claimRecordId === "claim-treaty",
    )!;
    expect(treaty).toMatchObject({ status: "evidence-found", reused: true });
    expect(treaty.evidenceFrom?.dossier.path).toBe(
      `dossier/${one.record.mappings[0].dossierId}.md`,
    );
  });

  it("sends one bounded request per theme and records the omitted claims (#533)", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      id: `claim-${String(i).padStart(3, "0")}`,
      statement: `Claim number ${i}`,
    }));
    const a = await analysis("p1", many);
    const r = researcher(() => ({ passages: [] }));
    await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    // One request for the theme, never a fan-out over the claim set.
    expect(r.requests.map((q) => q.claims.length)).toEqual([12]);
    expect(r.requests[0]!.claims[0]!.claimRecordId).toMatch(/claim-000$/);
    expect(r.requests[0]!.omittedClaimRecordIds).toHaveLength(138);
  }, 60_000);

  it("refuses a claim result extracted against a different theme result", async () => {
    const a = await analysis("p1", claims);
    const b = await analysis("p2", claims, "Something else");
    const mixed = await artifacts.write(
      "claim-extractions/pub/p1/mixed.json",
      (await artifacts.read(b.claimResult)).replace(
        '"postId":"p2"',
        '"postId":"p1"',
      ),
    );
    await expect(
      assessPostCoverage({
        artifacts,
        themeResult: a.themeResult,
        claimResult: mixed,
        commission: researcher(() => "failed").commission,
        shortlister: new LexicalShortlister(),
      }),
    ).rejects.toThrow("different theme result");
  });

  it("never lets a later gap erase evidence already saved, and does not record http-only support", () => {
    const base = {
      schemaVersion: 1 as const,
      themeId: "t",
      title: "T",
      scope: "S",
      claims: [
        { claimId: "c1", status: "covered" as const, citations: ["c-x"] },
      ],
      citations: [
        {
          id: "c-x",
          url: "https://a.example/",
          title: "a",
          passage: "p",
          checkedAt: "2026-01-01",
        },
      ],
      gaps: [],
      updatedAt: "2026-01-01",
    };
    const merged = mergeCoverage(
      base,
      [
        {
          claimRecordId: "c1",
          status: "research-failed",
          citations: [],
          reason: "late failure",
        },
        {
          claimRecordId: "c2",
          status: "evidence-found",
          citations: [{ url: "http://insecure.example/", passage: "q" }],
        },
      ],
      "2026-01-02",
    );
    expect(merged.claims.find((c) => c.claimId === "c1")).toMatchObject({
      status: "covered",
    });
    expect(merged.claims.find((c) => c.claimId === "c2")).toMatchObject({
      status: "gap",
    });
  });

  it("bounds a claim's dossier citations to the schema limit", () => {
    const base = {
      schemaVersion: 1 as const,
      themeId: "t",
      title: "T",
      scope: "S",
      claims: [],
      citations: [],
      gaps: [],
      updatedAt: "2026-01-01",
    };
    const many = Array.from({ length: 60 }, (_, i) => ({
      url: `https://s${i}.example/`,
      passage: `p${i}`,
    }));
    const merged = mergeCoverage(
      base,
      [{ claimRecordId: "c1", status: "evidence-found", citations: many }],
      "2026-01-02",
    );
    const c1 = merged.claims[0];
    expect(c1.status === "covered" && c1.citations.length).toBe(50);
    expect(merged.citations).toHaveLength(50);
  });

  it("falls back when an embedding response is malformed", async () => {
    const bad = new EmbeddingShortlister(
      { vectorSpace: "s", embed: async () => [[1, 0]] },
      "s",
    );
    const list = await bad.shortlist({ title: "x", description: "" }, [
      { themeId: "a", title: "x", scope: "y" },
    ]);
    expect(list).toMatchObject({
      method: "lexical",
      limitation: "embedding response invalid",
    });
  });

  it("reaches claimant-only through the real research runner", async () => {
    const a = await analysis("p1", [claims[1]]);
    const operations = new OperationStore({ path: join(dir, "state.sqlite") });
    const commission: Commission = async (request) => {
      const out = await runResearchJob({
        artifacts,
        operations,
        request,
        owner: "t",
        monitoredHosts: ["saveusnow.substack.com"],
        sonar: {
          model: "fixture",
          research: async () => ({
            report: "Only the author's post repeats this.",
            citations: ["https://saveusnow.substack.com/p/x"],
            model: "fixture",
          }),
        },
        fetcher: {
          fetch: async (url) => ({
            url,
            title: "post",
            text: "A payment of 56 million funded an attack, they say.",
          }),
        },
        judge: {
          judge: async ({ findings }) => ({
            passages: findings.map((f) => ({
              findingId: f.id,
              passage: "A payment of 56 million funded an attack",
            })),
          }),
        },
      });
      if (out.status !== "finished")
        return { jobId: out.jobId, status: "busy" };
      const resultRef = (await artifacts.lookup(
        `research-jobs/${out.jobId}/result.json`,
      ))!;
      return {
        jobId: out.jobId,
        status: "finished",
        result: out.result,
        resultRef,
      };
    };
    const out = await assessPostCoverage({
      artifacts,
      ...a,
      commission,
      shortlister: new LexicalShortlister(),
    });
    operations.close();
    expect(out.record.claims[0].status).toBe("claimant-only");
  });

  it("records a canonical theme without commissioning research (#528)", async () => {
    const r = researcher(() => ({ passages: [] }));
    const a = await analysis("p1", [claims[0]], "Mercury");
    const out = await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    const dossierId = out.record.mappings[0].dossierId;
    const { ThemeStore } = await import("../../src/research/theme-store.js");
    const theme = await new ThemeStore(artifacts).get(dossierId);
    expect(theme).toBeDefined();
    expect(theme!.title.length).toBeGreaterThan(0);
  });

  it("reuses a saved catalogue decision instead of recalculating it (#518)", async () => {
    const r = researcher(() => ({ passages: [] }));
    const first = await analysis("p1", [claims[0]], "Mercury");
    const created = await assessPostCoverage({
      artifacts,
      ...first,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    const dossierId = created.record.mappings[0].dossierId;

    // A second post accepts the existing dossier, which teaches the catalogue.
    const second = await analysis("p2", [claims[1]], "Mercury");
    const accepting = {
      decide: async () => ({ themeId: dossierId, rationale: "same subject" }),
    };
    await assessPostCoverage({
      artifacts,
      ...second,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
      judge: accepting,
    });

    // A third post with the same proposal reuses the catalogue and never asks
    // the judge again.
    const third = await analysis("p3", [claims[0]], "Mercury");
    const mustNotDecide = {
      decide: async () => {
        throw new Error("judge must not be consulted for a catalogue hit");
      },
    };
    const reused = await assessPostCoverage({
      artifacts,
      ...third,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
      judge: mustNotDecide,
    });
    expect(reused.record.mappings[0]).toMatchObject({
      dossierId,
      method: "catalogue",
      created: false,
    });
    // The coverage pins the exact mapping version it used (#518), with provenance.
    const pin = reused.record.mappings[0]!.mappingRef!;
    expect(pin.path).toMatch(/^librarian\/theme-mappings\/global\/.+\.json$/);
    const { ThemeMappingCatalogue } =
      await import("../../src/research/theme-mappings.js");
    const catalogue = new ThemeMappingCatalogue(artifacts);
    const pinnedRef = { ...pin, sha256: pin.hash.replace(/^sha256:/, "") };
    const used = await catalogue.pinned(pinnedRef);
    expect(used).toMatchObject({
      canonicalThemeId: dossierId,
      method: "lexical",
      source: { proposalId: expect.any(String) },
    });
    // A later correction revises the file; the pinned version is unchanged.
    await catalogue.correct({
      expected: pinnedRef,
      change: { canonicalThemeId: "another-theme" },
      reason: "split",
      correctedAt: "2026-03-01T00:00:00.000Z",
    });
    expect((await catalogue.pinned(pinnedRef)).canonicalThemeId).toBe(
      dossierId,
    );
  });

  it("maps to an established theme that has no research yet, keeping its ID (#528)", async () => {
    const { ThemeStore } = await import("../../src/research/theme-store.js");
    const { themeCoverage } =
      await import("../../src/research/theme-coverage.js");
    await new ThemeStore(artifacts).ensure({
      id: "mercury-theme",
      title: "Mercury",
      description: "Claims about mercury.",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await themeCoverage(artifacts, "mercury-theme"))?.state).toBe(
      "unresearched",
    );
    const seen: string[][] = [];
    const judge = {
      decide: async (
        _p: unknown,
        shortlist: { candidates: { themeId: string }[] },
      ) => {
        seen.push(shortlist.candidates.map((c) => c.themeId));
        return { themeId: "mercury-theme", rationale: "same subject" };
      },
    };
    const a = await analysis("p1", [claims[0]], "Mercury");
    const r = researcher(() => ({ passages: [] }));
    const out = await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
      judge: judge as never,
    });
    // The dossier-less theme was a candidate, and the mapping kept its identity.
    expect(seen[0]).toContain("mercury-theme");
    expect(out.record.mappings[0]).toMatchObject({
      dossierId: "mercury-theme",
      created: false,
    });
  });

  it("gives a theme its own dossier when the judge rejects a same-named one", async () => {
    const a = await analysis("p1", [claims[0]], "Mercury");
    const r = researcher(() => ({ passages: [] }));
    const first = await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    // Same title, different meaning: the saved mapping is not inherited, so the
    // judge decides, and its rejection gives a separate theme (#531).
    const b = await analysis(
      "p2",
      [claims[1]],
      "Mercury",
      2,
      "The planet Mercury and its orbit",
    );
    const rejecting = {
      decide: async () => ({ themeId: null, rationale: "different subject" }),
    };
    const second = await assessPostCoverage({
      artifacts,
      ...b,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
      judge: rejecting,
    });
    expect(second.record.mappings[0].dossierId).not.toBe(
      first.record.mappings[0].dossierId,
    );
  });

  it("refuses claim and theme results for different source versions", async () => {
    const a = await analysis("p1", claims);
    const text = (await artifacts.read(a.claimResult)).replace(
      /"sourceVersion": ?"sha256:[0-9a-f]+"/,
      `"sourceVersion":"sha256:${"0".repeat(64)}"`,
    );
    const other = await artifacts.write(
      "claim-extractions/pub/p1/other.json",
      text,
    );
    await expect(
      assessPostCoverage({
        artifacts,
        themeResult: a.themeResult,
        claimResult: other,
        commission: researcher(() => "failed").commission,
        shortlister: new LexicalShortlister(),
      }),
    ).rejects.toThrow("different source versions");
  });

  it("accounts for a merged claim under its canonical record", async () => {
    const canonical = `claim-${"a".repeat(32)}`;
    const merged = `claim-${"b".repeat(32)}`;
    const record = (id: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        schemaVersion: 1,
        id,
        statement: "s",
        groupingKey: "g",
        themeIds: [],
        occurrences: [],
        ...extra,
      });
    await artifacts.revise(`claims/${canonical}.json`, record(canonical), null);
    await artifacts.revise(
      `claims/${merged}.json`,
      record(merged, { canonical }),
      null,
    );
    const a = await analysis("p1", [
      { id: merged, statement: "A merged claim" },
    ]);
    const r = researcher(() => ({
      passages: [{ claimRecordId: canonical, url: SHARED }],
    }));
    const out = await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    // The request keeps the extraction's own ID; coverage is recorded canonically.
    expect(r.requests[0].claims.map((c) => c.claimRecordId)).toEqual([merged]);
    expect(out.record.claims[0]).toMatchObject({
      claimRecordId: canonical,
      status: "evidence-found",
    });
  });

  it("reuses its own saved theme mapping when reassessing an analysis", async () => {
    const a = await analysis("p1", [claims[0]], "AI");
    const r = researcher(() => ({ passages: [] }));
    const one = await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    const rejecting = {
      decide: async () => ({ themeId: null, rationale: "different subject" }),
    };
    const two = await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
      judge: rejecting,
    });
    expect(two.record.mappings[0].dossierId).toBe(
      one.record.mappings[0].dossierId,
    );
    expect(new Set(r.requests.map((q) => researchJobId(q))).size).toBe(1);
  });

  it("falls back to the lexical shortlist, and records why, when vectors are incompatible", async () => {
    const shortlister = new EmbeddingShortlister(
      { vectorSpace: "other/space#3", embed: async () => [] },
      "expected/space#3",
    );
    const list = await shortlister.shortlist(
      { title: "Weather warfare", description: "" },
      [{ themeId: "weather-warfare", title: "Weather warfare", scope: "x" }],
    );
    expect(list).toMatchObject({
      method: "lexical",
      limitation: "incompatible vector space",
    });
    const ok = new EmbeddingShortlister(
      {
        vectorSpace: "s#2",
        embed: async (texts) =>
          texts.map((t) => (t.startsWith("Weather") ? [1, 0] : [0, 1])),
      },
      "s#2",
    );
    const hit = await ok.shortlist(
      { title: "Weather warfare", description: "" },
      [
        { themeId: "a", title: "Weather weapons", scope: "x" },
        { themeId: "b", title: "Vaccines", scope: "y" },
      ],
    );
    expect(hit.method).toBe("embedding");
    expect(hit.candidates[0]).toMatchObject({ themeId: "a", score: 1 });
  });
});

describe("librarian coverage across extraction schema versions", () => {
  it("accepts claims from a version 3 extraction", async () => {
    const { themeResult, claimResult } = await analysis("p3", claims, "Weather warfare", 3);
    const r = researcher(() => "busy");
    const { record } = await assessPostCoverage({
      artifacts,
      themeResult,
      claimResult,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    expect(r.requests[0]!.canonicalNeeds!.needs.every((n) => !!n.occurrenceScope)).toBe(true);
    expect(record.claims.every((c) => c.status === "pending")).toBe(true);
    expect(record.claims.map((c) => c.claimRecordId).sort()).toEqual([
      "claim-payment",
      "claim-treaty",
    ]);
  });
});

describe(
  "theme research reuse across posts (#658)",
  { timeout: 60_000 },
  () => {
    const extra = {
      id: "claim-new",
      statement: "A new aircraft sprayed the region",
    };
    const supportTreatyOnly = (req: ResearchRequest) => ({
      passages: req.claims
        .filter((c) => c.claimRecordId === "claim-treaty")
        .map((c) => ({
          claimRecordId: c.claimRecordId,
          url: "https://un.example/enmod",
        })),
    });

    async function firstPost() {
      const r = researcher(supportTreatyOnly);
      const first = await analysis("p1", claims, "Weather warfare");
      const created = await assessPostCoverage({
        artifacts,
        ...first,
        commission: r.commission,
        shortlister: new LexicalShortlister(),
      });
      return created.record.mappings[0]!.dossierId;
    }

    it("does not repurchase a researched theme when byline, post and claim order change", async () => {
      const dossierId = await firstPost();
      const accept = {
        decide: async () => ({ themeId: dossierId, rationale: "same theme" }),
      };
      // Another post: different post identity (byline/context), claims reordered, one new.
      const r = researcher(supportTreatyOnly);
      const second = await analysis(
        "p2",
        [extra, claims[1]!, claims[0]!],
        "Weather warfare",
      );
      const out = await assessPostCoverage({
        artifacts,
        ...second,
        commission: r.commission,
        shortlister: new LexicalShortlister(),
        judge: accept,
      });
      // No new full discovery: one targeted theme request for only what still needs evidence.
      expect(r.requests).toHaveLength(1);
      const req = r.requests[0]!;
      expect(req).toMatchObject({ origin: "theme", pass: 1 });
      expect(req.post).toBeUndefined();
      expect(req.claims.map((c) => c.claimRecordId).sort()).toEqual([
        "claim-new",
        "claim-payment",
      ]);
      expect(
        req.claims.every(
          (c) => c.themeIds.length === 1 && c.themeIds[0] === dossierId,
        ),
      ).toBe(true);
      // Covered evidence is reused with its exact dossier version; nothing is
      // presented as covering the new claim unless the targeted work supports it.
      const byId = new Map(out.record.claims.map((c) => [c.claimRecordId, c]));
      expect(byId.get("claim-treaty")).toMatchObject({
        reused: true,
        status: "evidence-found",
      });
      expect(byId.get("claim-treaty")!.evidenceFrom?.dossier.path).toMatch(
        /^dossier\//,
      );
      expect(byId.get("claim-new")).toMatchObject({ reused: false });
      expect(byId.get("claim-new")!.status).not.toBe("evidence-found");
      // The precise post request context stays as audit provenance in the coverage record.
      expect(out.record.post).toMatchObject({
        publicationId: "pub",
        postId: "p2",
      });
    });

    it("gives targeted research the same single follow-up for a consequential gap (#597)", async () => {
      const dossierId = await firstPost();
      const accept = {
        decide: async () => ({ themeId: dossierId, rationale: "same theme" }),
      };
      const r = researcher(supportTreatyOnly);
      const second = await analysis(
        "p2",
        [extra, claims[1]!, claims[0]!],
        "Weather warfare",
      );
      await assessPostCoverage({
        artifacts,
        ...second,
        commission: r.commission,
        shortlister: new LexicalShortlister(),
        judge: accept,
        consequential: (c) => c.claimRecordId === "claim-new",
      });
      expect(r.requests).toHaveLength(2);
      const [first, follow] = r.requests;
      expect(follow).toMatchObject({
        origin: "theme",
        pass: 2,
        previousJobId: researchJobId(first!),
      });
      expect(follow!.post).toBeUndefined();
      expect(follow!.claims.map((c) => c.claimRecordId)).toEqual(["claim-new"]);
    });

    it("gives a third post with the same needs the same targeted job, whatever its byline", async () => {
      const dossierId = await firstPost();
      const accept = {
        decide: async () => ({ themeId: dossierId, rationale: "same theme" }),
      };
      const jobs: string[] = [];
      for (const postId of ["p2", "p3"]) {
        const r = researcher(() => "busy");
        const a = await analysis(
          postId,
          [claims[1]!, extra, claims[0]!],
          "Weather warfare",
        );
        await assessPostCoverage({
          artifacts,
          ...a,
          commission: r.commission,
          shortlister: new LexicalShortlister(),
          judge: accept,
        });
        jobs.push(...r.requests.map((q) => researchJobId(q)));
      }
      expect(jobs).toHaveLength(2);
      expect(jobs[0]).toBe(jobs[1]);
    });

    it("replays the same targeted job when the same analysis is reassessed", async () => {
      const dossierId = await firstPost();
      const accept = {
        decide: async () => ({ themeId: dossierId, rationale: "same theme" }),
      };
      // The targeted job supports the new claim but not the old gap.
      const supportNew = (req: ResearchRequest) => ({
        passages: req.claims
          .filter((c) => c.claimRecordId === "claim-new")
          .map((c) => ({
            claimRecordId: c.claimRecordId,
            url: "https://source.example/new",
          })),
      });
      const second = await analysis(
        "p2",
        [extra, claims[1]!, claims[0]!],
        "Weather warfare",
      );
      const jobs: string[] = [];
      for (let i = 0; i < 2; i++) {
        const r = researcher(supportNew);
        await assessPostCoverage({
          artifacts,
          ...second,
          commission: r.commission,
          shortlister: new LexicalShortlister(),
          judge: accept,
        });
        jobs.push(...r.requests.map((q) => researchJobId(q)));
      }
      // The dossier now covers claim-new, yet the reassessment sends the identical request.
      expect(jobs).toHaveLength(2);
      expect(jobs[1]).toBe(jobs[0]);
    });

    it("keeps the same request after a crash between the dossier save and the coverage record", async () => {
      const r = researcher(supportTreatyOnly);
      const a = await analysis("p1", claims, "Weather warfare");
      let crash = true;
      const crashing = new Proxy(artifacts, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver);
          if (prop !== "write" || typeof v !== "function") return v;
          return (path: string, ...rest: unknown[]) => {
            if (crash && path.startsWith("librarian/coverage/")) {
              crash = false;
              throw new Error("crash before coverage");
            }
            return (v as (...x: unknown[]) => unknown).apply(target, [
              path,
              ...rest,
            ]);
          };
        },
      });
      await expect(
        assessPostCoverage({
          artifacts: crashing as never,
          ...a,
          commission: r.commission,
          shortlister: new LexicalShortlister(),
        }),
      ).rejects.toThrow("crash before coverage");
      // The dossier was revised, but the retry follows the retained plan.
      const retry = await assessPostCoverage({
        artifacts,
        ...a,
        commission: r.commission,
        shortlister: new LexicalShortlister(),
      });
      const ids = r.requests.map((q) => researchJobId(q));
      expect(new Set(ids).size).toBe(1);
      expect(r.requests.every((q) => q.origin === "extraction")).toBe(true);
      expect(retry.record.jobs.map((j) => j.jobId)).toEqual([ids[0]]);
    });

    it("spends no request allowance on a group covered since the plan was made", async () => {
      const both = (req: ResearchRequest) => ({
        passages: req.claims.map((c) => ({
          claimRecordId: c.claimRecordId,
          url: "https://un.example/x",
        })),
      });
      const a = await analysis("p1", claims, "Weather warfare");
      const first = researcher(both);
      await assessPostCoverage({
        artifacts,
        ...a,
        commission: first.commission,
        shortlister: new LexicalShortlister(),
      });
      expect(first.requests).toHaveLength(1);
      // Everything is covered now: replaying the retained plan commissions nothing.
      const again = researcher(both);
      await assessPostCoverage({
        artifacts,
        ...a,
        commission: again.commission,
        shortlister: new LexicalShortlister(),
      });
      expect(again.requests).toHaveLength(0);
    });

    it("refuses recovery of a theme job that no coverage record binds to this article", async () => {
      const { validateRetainedArticleResearch } =
        await import("../../src/research/retained-research-source.js");
      const request: ResearchRequest = {
        schemaVersion: 1,
        origin: "theme",
        pass: 1,
        claims: [
          {
            claimRecordId: "claim-new",
            statement: "A new aircraft sprayed the region",
            themeIds: ["weather"],
          },
        ],
        question: "Targeted enhancement",
        corpusRefs: [],
      };
      const id = researchJobId(request);
      await artifacts.write(
        `research-jobs/${id}/request.json`,
        JSON.stringify(request),
      );
      const capture = await artifacts.write(
        "substack/pub/p9/collected.json",
        "{}",
      );
      await expect(
        validateRetainedArticleResearch({
          artifacts,
          operations: {
            researchRecovery: () => undefined,
            researchDiscoveryAccepted: () => false,
          } as never,
          jobIds: [id],
          capture,
          post: { publicationId: "pub", postId: "p9" },
          sourceContext: { schemaVersion: 1 } as never,
        }),
      ).rejects.toThrow("retained-research-capture-mismatch");
    });

    it("keeps a pre-upgrade workflow's journaled full request for a researched theme", async () => {
      const dossierId = await firstPost();
      const accept = {
        decide: async () => ({ themeId: dossierId, rationale: "same theme" }),
      };
      const second = await analysis(
        "p2",
        [extra, claims[1]!, claims[0]!],
        "Weather warfare",
      );
      // What the pre-upgrade planner would have pinned: the full extraction request.
      const probe = researcher(() => "busy");
      const { assessPostCoverage: assess } =
        await import("../../src/research/librarian.js");
      // Derive the full request's ID by planning without prior research context.
      const fresh = await mkdtemp(join(tmpdir(), "steele-pre-"));
      const old = artifacts;
      try {
        artifacts = new GitArtifactStore({
          repoPath: fresh,
          repository: "content",
        });
        await artifacts.initialise();
        const a = await analysis(
          "p2",
          [extra, claims[1]!, claims[0]!],
          "Weather warfare",
        );
        await assess({
          artifacts,
          ...a,
          commission: probe.commission,
          shortlister: new LexicalShortlister(),
        });
      } finally {
        await rm(fresh, { recursive: true, force: true });
        artifacts = old;
      }
      const fullIds = new Set(
        probe.requests.map((q) =>
          researchJobId({
            ...q,
            post: {
              ...q.post!,
              themeResult: ref(second.themeResult),
              claimResult: ref(second.claimResult),
            },
          }),
        ),
      );
      const r = researcher(() => "busy");
      await assessPostCoverage({
        artifacts,
        ...second,
        commission: r.commission,
        shortlister: new LexicalShortlister(),
        judge: accept,
        pinnedJobIds: fullIds,
      });
      expect(r.requests.every((q) => q.origin === "extraction")).toBe(true);
    });

    it("keeps the pinned jobs of reused period-scoped coverage, so evidence provenance survives (#903 review)", async () => {
      const revenue = {
        id: "claim-revenue-keep",
        statement: "Acme reported revenue of 10 million",
        reportingPeriod: { dependsOnPeriod: true, text: "Q3 2026" },
      };
      const a = await analysis("keep-jobs", [revenue]);
      const support = (req: ResearchRequest) => ({
        passages: req.claims.map((c) => ({
          claimRecordId: c.claimRecordId,
          url: SHARED,
        })),
      });
      const first = await assessPostCoverage({
        artifacts,
        ...a,
        commission: researcher(support).commission,
        shortlister: new LexicalShortlister(),
      });
      const again = await assessPostCoverage({
        artifacts,
        ...a,
        commission: researcher(() => "busy").commission,
        shortlister: new LexicalShortlister(),
      });
      const claim = again.record.claims.find(
        (c) => c.claimRecordId === "claim-revenue-keep",
      )!;
      expect(claim).toMatchObject({ status: "evidence-found", reused: true });
      for (const id of claim.jobIds)
        expect(again.record.jobs.find((j) => j.jobId === id)?.manifest).toEqual(
          first.record.jobs.find((j) => j.jobId === id)?.manifest,
        );
      expect(claim.jobIds.length).toBeGreaterThan(0);
    });

    it("accepts a full-length claim with its reporting-period note", async () => {
      const long = `${"A".repeat(1990)} 10 million`;
      const r = researcher(() => "busy");
      await assessPostCoverage({
        artifacts,
        ...(await analysis("long-claim", [
          {
            id: "claim-long",
            statement: long,
            reportingPeriod: { dependsOnPeriod: true, text: "Q3 2026" },
          },
        ])),
        commission: r.commission,
        shortlister: new LexicalShortlister(),
      });
      expect(
        r.requests
          .flatMap((q) => q.claims)
          .find((c) => c.claimRecordId === "claim-long")!.statement,
      ).toHaveLength(long.length + " [reporting period: Q3 2026]".length);
    });

    it("refuses recovery of a theme job that no coverage record binds to this article", async () => {
      const { validateRetainedArticleResearch } =
        await import("../../src/research/retained-research-source.js");
      const request: ResearchRequest = {
        schemaVersion: 1,
        origin: "theme",
        pass: 1,
        claims: [
          {
            claimRecordId: "claim-new",
            statement: "A new aircraft sprayed the region",
            themeIds: ["weather"],
          },
        ],
        question: "Targeted enhancement",
        corpusRefs: [],
      };
      const id = researchJobId(request);
      await artifacts.write(
        `research-jobs/${id}/request.json`,
        JSON.stringify(request),
      );
      const capture = await artifacts.write(
        "substack/pub/p9/collected.json",
        "{}",
      );
      await expect(
        validateRetainedArticleResearch({
          artifacts,
          operations: {
            researchRecovery: () => undefined,
            researchDiscoveryAccepted: () => false,
          } as never,
          jobIds: [id],
          capture,
          post: { publicationId: "pub", postId: "p9" },
          sourceContext: { schemaVersion: 1 } as never,
        }),
      ).rejects.toThrow("retained-research-capture-mismatch");
    });

    it("keeps a pre-upgrade workflow's journaled full request for a researched theme", async () => {
      const dossierId = await firstPost();
      const accept = {
        decide: async () => ({ themeId: dossierId, rationale: "same theme" }),
      };
      const second = await analysis(
        "p2",
        [extra, claims[1]!, claims[0]!],
        "Weather warfare",
      );
      // What the pre-upgrade planner would have pinned: the full extraction request.
      const probe = researcher(() => "busy");
      const { assessPostCoverage: assess } =
        await import("../../src/research/librarian.js");
      // Derive the full request's ID by planning without prior research context.
      const fresh = await mkdtemp(join(tmpdir(), "steele-pre-"));
      const old = artifacts;
      try {
        artifacts = new GitArtifactStore({
          repoPath: fresh,
          repository: "content",
        });
        await artifacts.initialise();
        const a = await analysis(
          "p2",
          [extra, claims[1]!, claims[0]!],
          "Weather warfare",
        );
        await assess({
          artifacts,
          ...a,
          commission: probe.commission,
          shortlister: new LexicalShortlister(),
        });
      } finally {
        await rm(fresh, { recursive: true, force: true });
        artifacts = old;
      }
      const fullIds = new Set(
        probe.requests.map((q) =>
          researchJobId({
            ...q,
            post: {
              ...q.post!,
              themeResult: ref(second.themeResult),
              claimResult: ref(second.claimResult),
            },
          }),
        ),
      );
      const r = researcher(() => "busy");
      await assessPostCoverage({
        artifacts,
        ...second,
        commission: r.commission,
        shortlister: new LexicalShortlister(),
        judge: accept,
        pinnedJobIds: fullIds,
      });
      expect(r.requests.every((q) => q.origin === "extraction")).toBe(true);
    });

    it("replays the planned question even if the prompt file changes", async () => {
      const dossierId = await firstPost();
      const accept = {
        decide: async () => ({ themeId: dossierId, rationale: "same theme" }),
      };
      const second = await analysis(
        "p2",
        [extra, claims[1]!, claims[0]!],
        "Weather warfare",
      );
      const first = researcher(() => "busy");
      await assessPostCoverage({
        artifacts,
        ...second,
        commission: first.commission,
        shortlister: new LexicalShortlister(),
        judge: accept,
      });
      // Simulate a prompt edit after planning: the retained plan's question wins.
      const [planPath] = await artifacts.list(
        `librarian/request-plans/pub/p2`,
        10,
      );
      const plan = JSON.parse(
        await artifacts.read((await artifacts.lookup(planPath!))!),
      );
      expect(plan.dossiers[dossierId].question).toBe(
        first.requests[0]!.question,
      );
      const again = researcher(() => "busy");
      await assessPostCoverage({
        artifacts,
        ...second,
        commission: again.commission,
        shortlister: new LexicalShortlister(),
        judge: accept,
      });
      expect(researchJobId(again.requests[0]!)).toBe(
        researchJobId(first.requests[0]!),
      );
    });
  },
);

describe("mappings first (#531)", { timeout: 60_000 }, () => {
  it("reuses a newly established theme for compatible wording on another post without a decision", async () => {
    const r = researcher(() => ({ passages: [] }));
    const a = await analysis("p1", [claims[0]!], "Mercury");
    const first = await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    const b = await analysis("p2", [claims[1]!], "Mercury");
    const mustNotDecide = {
      decide: async () => {
        throw new Error("no decision for a compatible mapping");
      },
    };
    const second = await assessPostCoverage({
      artifacts,
      ...b,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
      judge: mustNotDecide,
    });
    expect(second.record.mappings[0]).toMatchObject({
      dossierId: first.record.mappings[0]!.dossierId,
      method: "catalogue",
    });
  });

  it("keeps the mapping when research then fails", async () => {
    const a = await analysis("p1", [claims[0]!], "Mercury");
    const out = await assessPostCoverage({
      artifacts,
      ...a,
      commission: researcher(() => "failed").commission,
      shortlister: new LexicalShortlister(),
    });
    const { ThemeMappingCatalogue } =
      await import("../../src/research/theme-mappings.js");
    const saved = await new ThemeMappingCatalogue(artifacts).lookup({
      proposal: "Mercury",
      description: "Claims of weather modification as a weapon",
    });
    expect(saved?.canonicalThemeId).toBe(out.record.mappings[0]!.dossierId);
  });

  it("reconciles to a theme a concurrent assessment established after this one started", async () => {
    const { ThemeMappingCatalogue } =
      await import("../../src/research/theme-mappings.js");
    const { ThemeStore } = await import("../../src/research/theme-store.js");
    const a = await analysis("p2", [claims[1]!], "Mercury");
    // Simulate the race: the other assessment's theme and mapping land after
    // this assessment's opening snapshot (injected on its first commission).
    let raced = false;
    const r = researcher(() => ({ passages: [] }));
    const catalogue = new ThemeMappingCatalogue(artifacts);
    const store = new ThemeStore(artifacts);
    const originalRecord = catalogue.recordPinned.bind(catalogue);
    const proto = Object.getPrototypeOf(catalogue) as {
      recordPinned: typeof catalogue.recordPinned;
    };
    const realRecord = proto.recordPinned;
    proto.recordPinned = async function (this: unknown, mapping) {
      if (!raced) {
        raced = true;
        await store.ensure({
          id: "mercury-other",
          title: "Mercury",
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        await originalRecord({ ...mapping, canonicalThemeId: "mercury-other" });
      }
      return realRecord.call(this, mapping);
    };
    try {
      const out = await assessPostCoverage({
        artifacts,
        ...a,
        commission: r.commission,
        shortlister: new LexicalShortlister(),
      });
      expect(out.record.mappings[0]).toMatchObject({
        dossierId: "mercury-other",
        method: "catalogue",
      });
      expect(
        r.requests.every((q) =>
          q.claims.every((c) => c.themeIds.includes("mercury-other")),
        ),
      ).toBe(true);
    } finally {
      proto.recordPinned = realRecord;
    }
  });
});

describe("reporting periods in research (#889)", { timeout: 60_000 }, () => {
  it("leaves a claim with an unstated reporting period out of research, with the reason", async () => {
    const { themeResult, claimResult } = await analysis("period-889", [
      ...claims,
      {
        id: "claim-revenue",
        statement: "Acme reported revenue of 10 million",
        reportingPeriod: { dependsOnPeriod: true },
      },
    ]);
    const r = researcher(() => "busy");
    const { record } = await assessPostCoverage({
      artifacts,
      themeResult,
      claimResult,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    const revenue = record.claims.find(
      (c) => c.claimRecordId === "claim-revenue",
    );
    expect(revenue).toMatchObject({
      status: "not-commissioned",
      reason: PERIOD_NOT_STATED,
    });
    // Eligible claims continue; the excluded one is never sent to research.
    expect(
      r.requests.flatMap((q) => q.claims.map((c) => c.claimRecordId)),
    ).not.toContain("claim-revenue");
    expect(r.requests.length).toBeGreaterThan(0);
  });

  it("never reuses another post's evidence for a period-dependent claim (#903 review)", async () => {
    const revenue = (period: string) => ({
      id: "claim-revenue-q",
      statement: "Acme reported revenue of 10 million",
      reportingPeriod: { dependsOnPeriod: true, text: period },
    });
    const support = (req: ResearchRequest) => ({
      passages: req.claims.map((c) => ({
        claimRecordId: c.claimRecordId,
        url: SHARED,
      })),
    });
    const first = await analysis("period-q3", [revenue("Q3 2026")]);
    await assessPostCoverage({
      artifacts,
      ...first,
      commission: researcher(support).commission,
      shortlister: new LexicalShortlister(),
    });
    // Same statement in another post, about another period: researched again.
    const second = await analysis("period-q4", [revenue("Q4 2026")]);
    const r = researcher(() => "busy");
    const { record } = await assessPostCoverage({
      artifacts,
      ...second,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    const claim = record.claims.find(
      (c) => c.claimRecordId === "claim-revenue-q",
    )!;
    expect(claim.reused).toBe(false);
    expect(
      r.requests.flatMap((q) => q.claims.map((c) => c.claimRecordId)),
    ).toContain("claim-revenue-q");
  });

  it("sends the stated period to research, so the prompt, judge and job identity carry it", async () => {
    const revenue = (period?: string) => ({
      id: "claim-revenue-p",
      statement: "Acme reported revenue of 10 million",
      reportingPeriod: period
        ? { dependsOnPeriod: true, text: period }
        : { dependsOnPeriod: true },
    });
    const ask = async (postId: string, period: string) => {
      const r = researcher(() => "busy");
      await assessPostCoverage({
        artifacts,
        ...(await analysis(postId, [revenue(period)])),
        commission: r.commission,
        shortlister: new LexicalShortlister(),
      });
      return r.requests
        .flatMap((q) => q.claims)
        .find((c) => c.claimRecordId === "claim-revenue-p")!;
    };
    const q3 = await ask("req-q3", "Q3 2026");
    const q4 = await ask("req-q4", "Q4 2026");
    expect(q3.statement).toBe(
      "Acme reported revenue of 10 million [reporting period: Q3 2026]",
    );
    expect(q4.statement).toContain("[reporting period: Q4 2026]");
    // A relative period is not anchored to a year: excluded, never researched.
    const r = researcher(() => "busy");
    const { record } = await assessPostCoverage({
      artifacts,
      ...(await analysis("req-rel", [revenue("last year")])),
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    expect(
      record.claims.find((c) => c.claimRecordId === "claim-revenue-p")!.reason,
    ).toBe(PERIOD_NOT_ANCHORED);
    expect(
      r.requests.flatMap((q) => q.claims.map((c) => c.claimRecordId)),
    ).not.toContain("claim-revenue-p");
  });

  it("keeps a claim eligible when any of its occurrences states the period", async () => {
    const r = researcher(() => "busy");
    const { record } = await assessPostCoverage({
      artifacts,
      ...(await analysis("mixed-occ", [
        {
          id: "claim-mixed",
          statement: "Acme reported revenue of 10 million",
          reportingPeriod: { dependsOnPeriod: true },
        },
        {
          id: "claim-mixed",
          statement: "Acme reported revenue of 10 million",
          reportingPeriod: { dependsOnPeriod: true, text: "Q3 2026" },
        },
      ])),
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    expect(
      record.claims.find((c) => c.claimRecordId === "claim-mixed")!.reason,
    ).not.toBe(PERIOD_NOT_STATED);
    expect(
      r.requests.flatMap((q) => q.claims.map((c) => c.statement)),
    ).toContain(
      "Acme reported revenue of 10 million [reporting period: Q3 2026]",
    );
  });

  it("reassessing reuses only this analysis's own coverage, never another post's later evidence", async () => {
    const revenue = (period: string) => ({
      id: "claim-revenue-r",
      statement: "Acme reported revenue of 10 million",
      reportingPeriod: { dependsOnPeriod: true, text: period },
    });
    const q3 = await analysis("reassess-q3", [revenue("Q3 2026")]);
    const assess = async (
      a: typeof q3,
      plan: Parameters<typeof researcher>[0],
    ) => {
      const r = researcher(plan);
      const { record } = await assessPostCoverage({
        artifacts,
        ...a,
        commission: r.commission,
        shortlister: new LexicalShortlister(),
      });
      return { record, r };
    };
    await assess(q3, () => "busy"); // Q3 research pending
    await assess(
      await analysis("reassess-q4", [revenue("Q4 2026")]),
      (req) => ({
        passages: req.claims.map((c) => ({
          claimRecordId: c.claimRecordId,
          url: SHARED,
        })),
      }),
    ); // Q4 evidence saved under the same statement-keyed entry
    const again = await assess(q3, () => "busy");
    const claim = again.record.claims.find(
      (c) => c.claimRecordId === "claim-revenue-r",
    )!;
    expect(claim.reused).toBe(false);
    expect(claim.status).not.toBe("evidence-found");
  });
});
