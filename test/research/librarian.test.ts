import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { proposeThemes } from "../../src/analysis/theme-proposals.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { type ArtifactRef, GitArtifactStore } from "../../src/controllers/artifact-store.js";
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

const TEXT = "A treaty bans weather weapons. They paid 56 million for the attack.";
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
  claims: { id: string; statement: string }[],
  title = "Weather warfare",
  schemaVersion: 2 | 3 = 2,
) {
  const post = { publicationId: "pub", postId };
  await proposeThemes({
    provider: {
      modelVersion: "fake/m",
      complete: async () =>
        JSON.stringify({
          themes: [{ title, description: "Claims of weather modification as a weapon" }],
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
  const proposalId = JSON.parse(await artifacts.read(themeResult)).proposals[0].id as string;
  const claimResult = await artifacts.write(
    `claim-extractions/pub/${postId}/r.json`,
    JSON.stringify({
      schemaVersion,
      post,
      sourceVersion: sourceVersionFor(TEXT),
      themeIds: [proposalId],
      themeResult: `${themeResult.commit}:${themeResult.path}`,
      claims: claims.map((c) => ({
        claim: { statement: c.statement },
        occurrence: {},
        kind: "assertion",
        themeIds: [proposalId],
        classification: "themed",
        claimRecordId: c.id,
      })),
      candidates: [],
      rejected: [],
      extraction: { modelVersion: "m", promptVersion: "p", extractedAt: "2026-01-01T00:00:00Z" },
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
  plan: (
    req: ResearchRequest,
  ) =>
    | "busy"
    | "failed"
    | { passages: { claimRecordId: string; url: string; monitored?: boolean }[] },
) {
  const requests: ResearchRequest[] = [];
  const commission: Commission = async (request) => {
    requests.push(request);
    const jobId = researchJobId(request);
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
    const report = await artifacts.write(`research-jobs/${jobId}/report.md`, "# report\n");
    const urls = [...new Set(outcome.passages.map((p) => p.url))];
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
  { id: "claim-treaty", statement: "A treaty prohibits hostile environmental modification" },
  { id: "claim-payment", statement: "A payment of 56 million funded an attack" },
];

describe("librarian coverage", { timeout: 60_000 }, () => {
  it("records separate decisions for two claims sharing one source, with exact references", async () => {
    const { themeResult, claimResult } = await analysis("p1", claims);
    const r = researcher(() => ({ passages: [{ claimRecordId: "claim-treaty", url: SHARED }] }));
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
    const by = Object.fromEntries(record.claims.map((c) => [c.claimRecordId, c]));
    expect(by["claim-treaty"]).toMatchObject({
      status: "evidence-found",
      citations: [{ url: SHARED }],
    });
    expect(by["claim-payment"]).toMatchObject({ status: "no-independent-evidence" });
    expect(record.themeResult.path).toBe(themeResult.path);
    expect(record.claimResult.path).toBe(claimResult.path);
    expect(record.mappings[0]).toMatchObject({ created: true, method: "lexical" });
    expect(record.jobs[0].manifest).toBeDefined();
    expect(coverageRef.path).toMatch(/^librarian\/coverage\/pub\/p1\//);
    // The dossier records both decisions against the same theme.
    const dossier = (await new DossierStore(artifacts).current(record.mappings[0].dossierId))!;
    expect(dossier.metadata.claims.find((c) => c.claimId === "claim-treaty")).toMatchObject({
      status: "covered",
    });
    expect(dossier.metadata.claims.find((c) => c.claimId === "claim-payment")).toMatchObject({
      status: "gap",
    });
    expect(record.dossiers[0].ref.commit).toBe(dossier.ref.commit);
  });

  it("reuses evidence for a covered claim in a later post and maps to the existing dossier", async () => {
    const first = await analysis("p1", claims);
    const r = researcher(() => ({ passages: [{ claimRecordId: "claim-treaty", url: SHARED }] }));
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
    expect(two.record.claims[0]).toMatchObject({ status: "evidence-found", reused: true });
  });

  it("leaves an explicit gap for a failed job and reports a running job as pending without touching the dossier", async () => {
    const failed = await analysis("p1", claims);
    const f = await assessPostCoverage({
      artifacts,
      ...failed,
      commission: researcher(() => "failed").commission,
      shortlister: new LexicalShortlister(),
    });
    expect(f.record.claims.every((c) => c.status === "research-failed")).toBe(true);
    const d = (await new DossierStore(artifacts).current(f.record.mappings[0].dossierId))!;
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
        { claimRecordId: "claim-payment", url: "https://pub.substack.com/p/x", monitored: true },
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
              { claimRecordId: "claim-payment", url: "https://www.gov.uk/payment-record" },
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
    const payment = out.record.claims.find((c) => c.claimRecordId === "claim-payment")!;
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
      req.pass === 1 ? { passages: [{ claimRecordId: "claim-treaty", url: SHARED }] } : "busy",
    );
    const out = await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
      consequential: (c) => c.claimRecordId === "claim-payment",
    });
    expect(out.record.claims.find((c) => c.claimRecordId === "claim-payment")?.status).toBe(
      "pending",
    );
  });

  it("marks claimant-only per claim, not for every claim in a grouped job", async () => {
    const a = await analysis("p1", claims);
    const r = researcher(() => ({
      passages: [
        { claimRecordId: "claim-payment", url: "https://pub.substack.com/p/x", monitored: true },
      ],
    }));
    const out = await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    const by = Object.fromEntries(out.record.claims.map((c) => [c.claimRecordId, c.status]));
    expect(by).toEqual({
      "claim-payment": "claimant-only",
      "claim-treaty": "no-independent-evidence",
    });
  });

  it("keeps the same request after partial success, so reassessment never re-researches", async () => {
    const a = await analysis("p1", claims);
    const r = researcher(() => ({ passages: [{ claimRecordId: "claim-treaty", url: SHARED }] }));
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
    const treaty = two.record.claims.find((c) => c.claimRecordId === "claim-treaty")!;
    expect(treaty).toMatchObject({ status: "evidence-found", reused: true });
    expect(treaty.evidenceFrom?.dossier.path).toBe(
      `dossier/${one.record.mappings[0].dossierId}.md`,
    );
  });

  it("splits a dossier's claims into requests of at most 100", async () => {
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
    expect(r.requests.map((q) => q.claims.length)).toEqual([100, 50]);
  }, 60_000);

  it("refuses a claim result extracted against a different theme result", async () => {
    const a = await analysis("p1", claims);
    const b = await analysis("p2", claims, "Something else");
    const mixed = await artifacts.write(
      "claim-extractions/pub/p1/mixed.json",
      (await artifacts.read(b.claimResult)).replace('"postId":"p2"', '"postId":"p1"'),
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
      claims: [{ claimId: "c1", status: "covered" as const, citations: ["c-x"] }],
      citations: [
        { id: "c-x", url: "https://a.example/", title: "a", passage: "p", checkedAt: "2026-01-01" },
      ],
      gaps: [],
      updatedAt: "2026-01-01",
    };
    const merged = mergeCoverage(
      base,
      [
        { claimRecordId: "c1", status: "research-failed", citations: [], reason: "late failure" },
        {
          claimRecordId: "c2",
          status: "evidence-found",
          citations: [{ url: "http://insecure.example/", passage: "q" }],
        },
      ],
      "2026-01-02",
    );
    expect(merged.claims.find((c) => c.claimId === "c1")).toMatchObject({ status: "covered" });
    expect(merged.claims.find((c) => c.claimId === "c2")).toMatchObject({ status: "gap" });
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
    const bad = new EmbeddingShortlister({ vectorSpace: "s", embed: async () => [[1, 0]] }, "s");
    const list = await bad.shortlist({ title: "x", description: "" }, [
      { themeId: "a", title: "x", scope: "y" },
    ]);
    expect(list).toMatchObject({ method: "lexical", limitation: "embedding response invalid" });
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
      if (out.status !== "finished") return { jobId: out.jobId, status: "busy" };
      const resultRef = (await artifacts.lookup(`research-jobs/${out.jobId}/result.json`))!;
      return { jobId: out.jobId, status: "finished", result: out.result, resultRef };
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
    const accepting = { decide: async () => ({ themeId: dossierId, rationale: "same subject" }) };
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
    const { ThemeMappingCatalogue } = await import("../../src/research/theme-mappings.js");
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
    expect((await catalogue.pinned(pinnedRef)).canonicalThemeId).toBe(dossierId);
  });

  it("maps to an established theme that has no research yet, keeping its ID (#528)", async () => {
    const { ThemeStore } = await import("../../src/research/theme-store.js");
    const { themeCoverage } = await import("../../src/research/theme-coverage.js");
    await new ThemeStore(artifacts).ensure({
      id: "mercury-theme",
      title: "Mercury",
      description: "Claims about mercury.",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await themeCoverage(artifacts, "mercury-theme"))?.state).toBe("unresearched");
    const seen: string[][] = [];
    const judge = {
      decide: async (_p: unknown, shortlist: { candidates: { themeId: string }[] }) => {
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
    expect(out.record.mappings[0]).toMatchObject({ dossierId: "mercury-theme", created: false });
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
    const b = await analysis("p2", [claims[1]], "Mercury");
    const rejecting = { decide: async () => ({ themeId: null, rationale: "different subject" }) };
    const second = await assessPostCoverage({
      artifacts,
      ...b,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
      judge: rejecting,
    });
    expect(second.record.mappings[0].dossierId).not.toBe(first.record.mappings[0].dossierId);
  });

  it("refuses claim and theme results for different source versions", async () => {
    const a = await analysis("p1", claims);
    const text = (await artifacts.read(a.claimResult)).replace(
      /"sourceVersion": ?"sha256:[0-9a-f]+"/,
      `"sourceVersion":"sha256:${"0".repeat(64)}"`,
    );
    const other = await artifacts.write("claim-extractions/pub/p1/other.json", text);
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
    await artifacts.revise(`claims/${merged}.json`, record(merged, { canonical }), null);
    const a = await analysis("p1", [{ id: merged, statement: "A merged claim" }]);
    const r = researcher(() => ({ passages: [{ claimRecordId: canonical, url: SHARED }] }));
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
    const rejecting = { decide: async () => ({ themeId: null, rationale: "different subject" }) };
    const two = await assessPostCoverage({
      artifacts,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
      judge: rejecting,
    });
    expect(two.record.mappings[0].dossierId).toBe(one.record.mappings[0].dossierId);
    expect(new Set(r.requests.map((q) => researchJobId(q))).size).toBe(1);
  });

  it("falls back to the lexical shortlist, and records why, when vectors are incompatible", async () => {
    const shortlister = new EmbeddingShortlister(
      { vectorSpace: "other/space#3", embed: async () => [] },
      "expected/space#3",
    );
    const list = await shortlister.shortlist({ title: "Weather warfare", description: "" }, [
      { themeId: "weather-warfare", title: "Weather warfare", scope: "x" },
    ]);
    expect(list).toMatchObject({ method: "lexical", limitation: "incompatible vector space" });
    const ok = new EmbeddingShortlister(
      {
        vectorSpace: "s#2",
        embed: async (texts) => texts.map((t) => (t.startsWith("Weather") ? [1, 0] : [0, 1])),
      },
      "s#2",
    );
    const hit = await ok.shortlist({ title: "Weather warfare", description: "" }, [
      { themeId: "a", title: "Weather weapons", scope: "x" },
      { themeId: "b", title: "Vaccines", scope: "y" },
    ]);
    expect(hit.method).toBe("embedding");
    expect(hit.candidates[0]).toMatchObject({ themeId: "a", score: 1 });
  });
});

describe("librarian coverage across extraction schema versions", () => {
  it("accepts claims from a version 3 extraction", async () => {
    const { themeResult, claimResult } = await analysis("p3", claims, "Weather warfare", 3);
    const r = researcher(() => ({ passages: [{ claimRecordId: "claim-treaty", url: SHARED }] }));
    const { record } = await assessPostCoverage({
      artifacts,
      themeResult,
      claimResult,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    });
    expect(record.claims.map((c) => c.claimRecordId).sort()).toEqual([
      "claim-payment",
      "claim-treaty",
    ]);
  });
});

describe("theme research reuse across posts (#658)", { timeout: 60_000 }, () => {
  const extra = { id: "claim-new", statement: "A new aircraft sprayed the region" };
  const supportTreatyOnly = (req: ResearchRequest) => ({
    passages: req.claims
      .filter((c) => c.claimRecordId === "claim-treaty")
      .map((c) => ({ claimRecordId: c.claimRecordId, url: "https://un.example/enmod" })),
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
    const accept = { decide: async () => ({ themeId: dossierId, rationale: "same theme" }) };
    // Another post: different post identity (byline/context), claims reordered, one new.
    const r = researcher(supportTreatyOnly);
    const second = await analysis("p2", [extra, claims[1]!, claims[0]!], "Weather warfare");
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
    expect(req.claims.map((c) => c.claimRecordId).sort()).toEqual(["claim-new", "claim-payment"]);
    expect(req.claims.every((c) => c.themeIds.length === 1 && c.themeIds[0] === dossierId)).toBe(
      true,
    );
    // Covered evidence is reused with its exact dossier version; nothing is
    // presented as covering the new claim unless the targeted work supports it.
    const byId = new Map(out.record.claims.map((c) => [c.claimRecordId, c]));
    expect(byId.get("claim-treaty")).toMatchObject({ reused: true, status: "evidence-found" });
    expect(byId.get("claim-treaty")!.evidenceFrom?.dossier.path).toMatch(/^dossier\//);
    expect(byId.get("claim-new")).toMatchObject({ reused: false });
    expect(byId.get("claim-new")!.status).not.toBe("evidence-found");
    // The precise post request context stays as audit provenance in the coverage record.
    expect(out.record.post).toMatchObject({ publicationId: "pub", postId: "p2" });
  });

  it("gives a third post with the same needs the same targeted job, whatever its byline", async () => {
    const dossierId = await firstPost();
    const accept = { decide: async () => ({ themeId: dossierId, rationale: "same theme" }) };
    const jobs: string[] = [];
    for (const postId of ["p2", "p3"]) {
      const r = researcher(() => "busy");
      const a = await analysis(postId, [claims[1]!, extra, claims[0]!], "Weather warfare");
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
    const accept = { decide: async () => ({ themeId: dossierId, rationale: "same theme" }) };
    // The targeted job supports the new claim but not the old gap.
    const supportNew = (req: ResearchRequest) => ({
      passages: req.claims
        .filter((c) => c.claimRecordId === "claim-new")
        .map((c) => ({ claimRecordId: c.claimRecordId, url: "https://source.example/new" })),
    });
    const second = await analysis("p2", [extra, claims[1]!, claims[0]!], "Weather warfare");
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
});
