import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { ModelProviderError } from "../../src/controllers/openrouter.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { WebAdapterError } from "../../src/controllers/research-web.js";
import { RESEARCH_COMPLETED_SUBJECT } from "../../src/events/research-completed-event.js";
import type { PageFetcher } from "../../src/research/gap-research.js";
import { RESEARCH_JOB_SCHEMA_VERSION, ResearchManifestSchema } from "../../src/research/job.js";
import {
  RESEARCH_PROMPT_VERSION,
  type SupportJudge,
  runResearchJob,
} from "../../src/research/runner.js";
import { OpenRouterSonarClient, type SonarClient, citationUrls } from "../../src/research/sonar.js";

const SECRET = "sk-or-SENTINEL-9f2a";
const request = {
  schemaVersion: 1,
  origin: "manual",
  subject: "ENMOD Convention and weather modification",
  question: "Does a treaty prohibit hostile environmental modification?",
  pass: 1,
  claims: [],
  corpusRefs: [],
};
const TREATY =
  "Article I. Each State Party undertakes not to engage in military or any other hostile use of environmental modification techniques having widespread, long-lasting or severe effects.";

let dir: string;
let artifacts: GitArtifactStore;
let operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-runner-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await artifacts.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

function sonar(citations: string[], fail?: ModelProviderError): SonarClient & { calls: number } {
  const client = {
    model: "perplexity/sonar-deep-research",
    calls: 0,
    async research() {
      client.calls++;
      if (fail) throw fail;
      return {
        report: "The ENMOD Convention (1977) prohibits hostile use.",
        citations,
        model: client.model,
        costUsd: 0.4,
      };
    },
  };
  return client;
}
const pages: Record<string, string | WebAdapterError> = {
  "https://treaties.un.org/enmod": TREATY,
  "https://example.org/blog": "Some unrelated commentary about weather.",
  "https://example.org/report.pdf": new WebAdapterError("unsupported-content"),
  "https://example.org/moved": new WebAdapterError("redirected"),
  "https://example.org/gone": new WebAdapterError("not-found"),
  "https://author.substack.com/p/post": TREATY,
};
let fetched = 0;
const fetcher: PageFetcher = {
  async fetch(url) {
    fetched++;
    const p = pages[url];
    if (p instanceof WebAdapterError) throw p;
    if (p === undefined) throw new WebAdapterError("not-found");
    return { url, title: "t", text: p };
  },
};
const judge: SupportJudge = {
  async judge({ source }) {
    const passages = [
      ...(source.includes("Article I")
        ? [{ findingId: "request", passage: "not to engage in military or any other hostile use" }]
        : []),
      { findingId: "request", passage: "a passage that is not in the source" },
      { findingId: "claim-from-elsewhere", passage: "Article I" },
      { findingId: "request", passage: "NOT TO ENGAGE IN MILITARY" },
    ];
    return { passages, sourceType: "treaty", rationale: "Primary treaty text." };
  },
};
const run = (s: SonarClient, extra: Record<string, unknown> = {}) =>
  runResearchJob({
    artifacts,
    operations,
    request,
    owner: "t",
    sonar: s,
    fetcher,
    judge,
    ...extra,
  });

describe("research runner", { timeout: 60_000 }, () => {
  it("stops recoverably when the support judge runs out of credit, reusing the saved report (#407)", async () => {
    const s1 = sonar(["https://treaties.un.org/enmod"]);
    const brokeJudge: SupportJudge = {
      judge: async () => {
        throw new ModelProviderError("credit-exhausted", 402);
      },
    };
    const first = await run(s1, { judge: brokeJudge });
    const fetchedAfterFirst = fetched;
    expect(first).toMatchObject({ result: { outcome: "failed", failure: "budget-exceeded" } });
    expect(await artifacts.lookup(`research-jobs/${first.jobId}/result.json`)).toBeUndefined();
    // Credit restored: the saved report is reused (no second paid call).
    const s2 = sonar(["https://treaties.un.org/enmod"]);
    const second = await run(s2);
    expect(s2.calls).toBe(0);
    expect(second.jobId).toBe(first.jobId);
    // The saved source snapshot is what gets judged, not a fresh fetch.
    expect(fetched).toBe(fetchedAfterFirst);
    expect((second as { result: { outcome: string } }).result.outcome).not.toBe("failed");
  });

  const jobDir = async () => {
    // A credit stop records no terminal result, so this is a cheap way to learn
    // the stable job ID without any paid or fetched work.
    const probe = await run(sonar([], new ModelProviderError("credit-exhausted", 402)));
    return `research-jobs/${probe.jobId}`;
  };
  const validReport = (jobId: string, citations: unknown) => ({
    schemaVersion: RESEARCH_JOB_SCHEMA_VERSION,
    jobId,
    promptVersion: RESEARCH_PROMPT_VERSION,
    model: "perplexity/sonar-deep-research",
    report: "A saved report.",
    citations,
  });

  it("fails on a retained report with the wrong shape instead of reusing or refetching (#432)", async () => {
    const dirName = await jobDir();
    const jobId = dirName.replace("research-jobs/", "");
    await artifacts.write(
      `${dirName}/report.json`,
      `${JSON.stringify({ ...validReport(jobId, null) })}\n`,
    );
    const paid = sonar(["https://treaties.un.org/enmod"]);
    const before = fetched;
    const out = await run(paid);
    expect(out).toMatchObject({ result: { outcome: "failed", failure: "invalid-report" } });
    expect(paid.calls).toBe(0);
    expect(fetched).toBe(before);
  });

  it("reuses a retained report written under the legacy prompt wording (#443)", async () => {
    const dirName = await jobDir();
    const jobId = dirName.replace("research-jobs/", "");
    await artifacts.write(
      `${dirName}/report.json`,
      `${JSON.stringify({
        ...validReport(jobId, ["https://treaties.un.org/enmod"]),
        promptVersion: "sonar-research-v1",
      })}\n`,
    );
    const paid = sonar(["https://treaties.un.org/enmod"]);
    const paused: SupportJudge = {
      judge: async () => {
        throw new ModelProviderError("credit-exhausted", 402);
      },
    };
    // Reused (no paid report call) but paused later, not rejected.
    expect(await run(paid, { judge: paused })).toMatchObject({
      result: { outcome: "failed", failure: "budget-exceeded" },
    });
    expect(paid.calls).toBe(0);
  });

  it("rejects a retained report for another job or prompt identity (#432)", async () => {
    const dirName = await jobDir();
    await artifacts.write(
      `${dirName}/report.json`,
      `${JSON.stringify({ ...validReport("some-other-job", ["https://treaties.un.org/enmod"]), jobId: "some-other-job" })}\n`,
    );
    const paid = sonar(["https://treaties.un.org/enmod"]);
    expect(await run(paid)).toMatchObject({
      result: { outcome: "failed", failure: "invalid-report" },
    });
    expect(paid.calls).toBe(0);
  });

  it("accepts a large retained citation list that the producer can generate (#432)", async () => {
    const dirName = await jobDir();
    const jobId = dirName.replace("research-jobs/", "");
    const citations = [
      "https://treaties.un.org/enmod",
      ...Array.from({ length: 399 }, (_, n) => `https://example.org/missing-${n}`),
    ];
    await artifacts.write(
      `${dirName}/report.json`,
      `${JSON.stringify(validReport(jobId, citations))}\n`,
    );
    // A paused judge keeps the run recoverable; it must not be rejected as an
    // invalid snapshot just because the report has many citations.
    const paused: SupportJudge = {
      judge: async () => {
        throw new ModelProviderError("credit-exhausted", 402);
      },
    };
    expect(await run(sonar([]), { judge: paused })).toMatchObject({
      result: { outcome: "failed", failure: "budget-exceeded" },
    });
  });

  it("rejects an over-bound citation list in a retained report (#432)", async () => {
    const dirName = await jobDir();
    const jobId = dirName.replace("research-jobs/", "");
    const citations = Array.from({ length: 501 }, (_, n) => `https://example.org/${n}`);
    await artifacts.write(
      `${dirName}/report.json`,
      `${JSON.stringify(validReport(jobId, citations))}\n`,
    );
    const paid = sonar([]);
    expect(await run(paid)).toMatchObject({
      result: { outcome: "failed", failure: "invalid-report" },
    });
    expect(paid.calls).toBe(0);
  });

  it("rejects a retained source snapshot for a different URL (#432)", async () => {
    const dirName = await jobDir();
    const jobId = dirName.replace("research-jobs/", "");
    await artifacts.write(
      `${dirName}/report.json`,
      `${JSON.stringify(validReport(jobId, ["https://treaties.un.org/enmod"]))}\n`,
    );
    const { createHash } = await import("node:crypto");
    const sourceKey = createHash("sha256")
      .update("https://treaties.un.org/enmod")
      .digest("hex")
      .slice(0, 32);
    await artifacts.write(
      `${dirName}/sources/${sourceKey}.json`,
      `${JSON.stringify({
        url: "https://example.org/other",
        title: "t",
        truncated: false,
        text: TREATY,
      })}\n`,
    );
    const before = fetched;
    expect(await run(sonar([]))).toMatchObject({
      result: { outcome: "failed", failure: "invalid-report" },
    });
    expect(fetched).toBe(before);
  });

  it("fails cleanly on malformed JSON in a retained report or source, without paid calls or refetches (#432)", async () => {
    const dirName = await jobDir();
    await artifacts.write(`${dirName}/report.json`, "{not-json\n");
    const paid = sonar([]);
    const out = await run(paid);
    expect(out).toMatchObject({ result: { outcome: "failed", failure: "invalid-report" } });
    expect(paid.calls).toBe(0);
    expect(JSON.stringify(out)).not.toContain("not-json");
  });

  it("fails cleanly on a malformed retained source snapshot (#432)", async () => {
    const dirName = await jobDir();
    const jobId = dirName.replace("research-jobs/", "");
    await artifacts.write(
      `${dirName}/report.json`,
      `${JSON.stringify(validReport(jobId, ["https://treaties.un.org/enmod"]))}\n`,
    );
    const { createHash } = await import("node:crypto");
    const key = createHash("sha256")
      .update("https://treaties.un.org/enmod")
      .digest("hex")
      .slice(0, 32);
    await artifacts.write(`${dirName}/sources/${key}.json`, "{not-json\n");
    const before = fetched;
    expect(await run(sonar([]))).toMatchObject({
      result: { outcome: "failed", failure: "invalid-report" },
    });
    expect(fetched).toBe(before);
  });

  it("resumes with a retained report holding a citation URL over 2,000 characters (#432)", async () => {
    const long = `https://example.org/${"a".repeat(2_500)}`;
    const dirName = await jobDir();
    const jobId = dirName.replace("research-jobs/", "");
    await artifacts.write(
      `${dirName}/report.json`,
      `${JSON.stringify(validReport(jobId, ["https://treaties.un.org/enmod", long]))}\n`,
    );
    const paid = sonar([]);
    const out = await run(paid, { limits: { maxSources: 1 } });
    expect(paid.calls).toBe(0);
    expect((out as { result: { failure?: string } }).result.failure).not.toBe("invalid-report");
  });

  it("accepts a retained source snapshot with empty text (#432)", async () => {
    const dirName = await jobDir();
    const jobId = dirName.replace("research-jobs/", "");
    await artifacts.write(
      `${dirName}/report.json`,
      `${JSON.stringify(validReport(jobId, ["https://treaties.un.org/enmod"]))}\n`,
    );
    const { createHash } = await import("node:crypto");
    const key = createHash("sha256")
      .update("https://treaties.un.org/enmod")
      .digest("hex")
      .slice(0, 32);
    await artifacts.write(
      `${dirName}/sources/${key}.json`,
      `${JSON.stringify({ url: "https://treaties.un.org/enmod", title: "t", truncated: false, text: "" })}\n`,
    );
    const out = await run(sonar([]));
    expect((out as { result: { failure?: string } }).result.failure).not.toBe("invalid-report");
  });

  it("saves nothing terminal on exhausted credit, so the same job runs after credit returns (#407)", async () => {
    const broke = sonar([], new ModelProviderError("credit-exhausted", 402));
    const first = await run(broke);
    expect(first).toMatchObject({
      status: "finished",
      reused: false,
      result: { outcome: "failed", failure: "budget-exceeded" },
    });
    expect(await artifacts.lookup(`research-jobs/${first.jobId}/result.json`)).toBeUndefined();
    // Credit restored: the same job ID runs again and completes.
    const restored = sonar(["https://treaties.un.org/enmod"]);
    const second = await run(restored);
    expect(restored.calls).toBe(1);
    expect(second.jobId).toBe(first.jobId);
    expect(second).toMatchObject({ status: "finished", reused: false });
    expect((second as { result: { outcome: string } }).result.outcome).not.toBe("failed");
  });

  it("completes when every citation is archived with a verified supporting passage", async () => {
    const out = await run(sonar(["https://treaties.un.org/enmod"]));
    expect(out.status === "finished" && out.result.outcome).toBe("complete");
    if (out.status !== "finished") return;
    const manifest = ResearchManifestSchema.parse(
      JSON.parse(await artifacts.read((await artifacts.lookup(out.result.manifest!.path))!)),
    );
    expect(manifest.citations[0]).toMatchObject({ retrieval: "archived", support: "supported" });
    // Only the verbatim passage for a known finding is kept.
    expect(manifest.citations[0].passages).toEqual([
      { claimRecordId: "request", passage: "not to engage in military or any other hostile use" },
    ]);
    expect(manifest.citations[0]).toMatchObject({
      sourceType: "treaty",
      confidenceRationale: "Primary treaty text.",
    });
    expect(manifest.provider).toEqual({ model: "perplexity/sonar-deep-research", costUsd: 0.4 });
    expect(
      await artifacts.read(
        manifest.coveringNote
          ? (await artifacts.lookup(manifest.coveringNote.path))!
          : (null as never),
      ),
    ).toContain("No recorded gaps");
    expect(operations.duePendingEvents(10, RESEARCH_COMPLETED_SUBJECT)).toHaveLength(1);
  });

  it("records partial retrieval, unsupported PDFs and redirects, and unverified sources as gaps", async () => {
    const out = await run(
      sonar([
        "https://treaties.un.org/enmod",
        "https://example.org/blog",
        "https://example.org/report.pdf",
        "https://example.org/moved",
        "https://example.org/gone",
      ]),
    );
    expect(out.status === "finished" && out.result.outcome).toBe("complete-with-gaps");
    if (out.status !== "finished") return;
    const manifest = ResearchManifestSchema.parse(
      JSON.parse(await artifacts.read((await artifacts.lookup(out.result.manifest!.path))!)),
    );
    expect(manifest.citations.map((c) => [c.retrieval, c.retrievalReason ?? c.support])).toEqual([
      ["archived", "supported"],
      ["archived", "unverified"],
      ["unsupported", "unsupported-content"],
      ["unsupported", "redirected"],
      ["inaccessible", "not-found"],
    ]);
    expect(manifest.gaps.join(" ")).toContain("could not be archived");
  });

  it("fails fast on a provider error or timeout, with no manifest and no second call", async () => {
    const s = sonar([], new ModelProviderError("timeout"));
    const out = await run(s);
    expect(out.status === "finished" && out.result).toMatchObject({
      outcome: "failed",
      failure: "timeout",
    });
    expect(out.status === "finished" && out.result.manifest).toBeUndefined();
    const again = await run(s);
    expect(again).toMatchObject({ status: "finished", reused: true });
    expect(s.calls).toBe(1);
  });

  it("never calls the provider again when the request is redelivered after success", async () => {
    const s = sonar(["https://treaties.un.org/enmod"]);
    await run(s);
    await run(s);
    expect(s.calls).toBe(1);
    expect(operations.duePendingEvents(10, RESEARCH_COMPLETED_SUBJECT)).toHaveLength(1);
  });

  it("records sources as not checked when no support judge is configured", async () => {
    const out = await run(sonar(["https://treaties.un.org/enmod"]), { judge: undefined });
    expect(out.status === "finished" && out.result.outcome).toBe("complete-with-gaps");
  });

  it("bounds the number of sources retrieved", async () => {
    const out = await run(sonar(["https://treaties.un.org/enmod", "https://example.org/blog"]), {
      limits: { maxSources: 1 },
    });
    if (out.status !== "finished") throw new Error("expected finished");
    const manifest = ResearchManifestSchema.parse(
      JSON.parse(await artifacts.read((await artifacts.lookup(out.result.manifest!.path))!)),
    );
    expect(manifest.citations[1]).toMatchObject({
      retrieval: "not-attempted",
      retrievalReason: "source-limit",
    });
  });
});

describe("review fixes", { timeout: 60_000 }, () => {
  it("keeps compatibility characters distinct when matching passages", async () => {
    const sup: PageFetcher = {
      async fetch(url) {
        return { url, title: "t", text: "Emissions fell by 10² tonnes." };
      },
    };
    const j: SupportJudge = {
      async judge() {
        return { passages: [{ findingId: "request", passage: "Emissions fell by 102 tonnes." }] };
      },
    };
    const out = await runResearchJob({
      artifacts,
      operations,
      request,
      owner: "t",
      fetcher: sup,
      judge: j,
      sonar: sonar(["https://example.org/data"]),
    });
    if (out.status !== "finished") throw new Error("expected finished");
    const manifest = ResearchManifestSchema.parse(
      JSON.parse(await artifacts.read((await artifacts.lookup(out.result.manifest!.path))!)),
    );
    expect(manifest.citations[0]).toMatchObject({ support: "unverified", passages: [] });
  });

  it("judges support against the discovery report's conclusions, not only the claims", async () => {
    const seen: string[] = [];
    const recording: SupportJudge = {
      async judge(i) {
        seen.push(i.report);
        return { passages: [] };
      },
    };
    await run(sonar(["https://treaties.un.org/enmod"]), { judge: recording });
    expect(seen).toEqual(["The ENMOD Convention (1977) prohibits hostile use."]);
  });

  it("never accepts the monitored author's own material as support", async () => {
    const out = await run(sonar(["https://author.substack.com/p/post"]), {
      monitoredHosts: ["author.substack.com"],
    });
    if (out.status !== "finished") throw new Error("expected finished");
    expect(out.result.outcome).toBe("complete-with-gaps");
    const manifest = ResearchManifestSchema.parse(
      JSON.parse(await artifacts.read((await artifacts.lookup(out.result.manifest!.path))!)),
    );
    expect(manifest.citations[0]).toMatchObject({
      retrieval: "archived",
      support: "unverified",
      sourceType: "monitored-source",
      // Explicit claim-level attribution, still never counted as support.
      passages: [
        { claimRecordId: "request", passage: "not to engage in military or any other hostile use" },
      ],
    });
  });

  it("renews the run lease while processing sources", async () => {
    let clock = 1_000_000;
    operations.close();
    operations = new OperationStore({ path: join(dir, "state.sqlite"), now: () => clock });
    const slow: PageFetcher = {
      async fetch(url) {
        clock += 40 * 60_000; // each source takes longer than the 30-minute lease
        return { url, title: "t", text: TREATY };
      },
    };
    const out = await runResearchJob({
      artifacts,
      operations,
      request,
      owner: "t",
      fetcher: slow,
      judge,
      sonar: sonar(["https://treaties.un.org/enmod", "https://example.org/blog"]),
    });
    expect(out.status === "finished" && out.result.outcome).toBe("complete");
  });
});

describe("OpenRouter Sonar client", () => {
  const respond =
    (body: unknown, status = 200) =>
    async () =>
      new Response(JSON.stringify(body), { status });

  it("sends finite limits and returns the report with structured and annotated citations", async () => {
    let sent: Record<string, unknown> = {};
    const client = new OpenRouterSonarClient({
      apiKey: SECRET,
      timeoutMs: 180_000,
      maxOutputTokens: 4_000,
      fetch: (async (_url: unknown, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            model: "perplexity/sonar-deep-research",
            citations: ["https://a.example/x#frag", "ftp://bad"],
            choices: [
              {
                message: {
                  content: "Report",
                  annotations: [
                    { type: "url_citation", url_citation: { url: "https://b.example/y" } },
                    { type: "url_citation", url_citation: { url: "https://a.example/x" } },
                  ],
                },
              },
            ],
            usage: { cost: 0.31 },
          }),
        );
      }) as typeof fetch,
    });
    const out = await client.research({ system: "s", user: "u" }, new AbortController().signal);
    expect(sent).toMatchObject({ model: "perplexity/sonar-deep-research", max_tokens: 4_000 });
    expect(out).toEqual({
      report: "Report",
      citations: ["https://a.example/x", "https://b.example/y"],
      model: "perplexity/sonar-deep-research",
      costUsd: 0.31,
    });
  });

  it("maps HTTP failures to codes without leaking the key", async () => {
    const client = new OpenRouterSonarClient({
      apiKey: SECRET,
      timeoutMs: 5_000,
      maxOutputTokens: 10,
      fetch: respond({ error: SECRET }, 402) as unknown as typeof fetch,
    });
    const error = await client
      .research({ system: "s", user: "u" }, new AbortController().signal)
      .catch((e) => e);
    expect(error).toMatchObject({ code: "credit-exhausted" });
    expect(String(error) + JSON.stringify(error)).not.toContain(SECRET);
  });

  it("requires finite limits", () => {
    expect(
      () => new OpenRouterSonarClient({ apiKey: "k", timeoutMs: 0, maxOutputTokens: 10 }),
    ).toThrow();
    expect(
      () => new OpenRouterSonarClient({ apiKey: "k", timeoutMs: 1_000, maxOutputTokens: Infinity }),
    ).toThrow();
  });

  it("counts citations beyond the manifest limit instead of dropping them silently", async () => {
    const many = Array.from({ length: 503 }, (_, i) => `https://s${i}.example/`);
    const client = new OpenRouterSonarClient({
      apiKey: "k",
      timeoutMs: 5_000,
      maxOutputTokens: 10,
      fetch: (async () =>
        new Response(
          JSON.stringify({ citations: many, choices: [{ message: { content: "R" } }] }),
        )) as unknown as typeof fetch,
    });
    const out = await client.research({ system: "s", user: "u" }, new AbortController().signal);
    expect([out.citations.length, out.omittedCitations]).toEqual([500, 3]);
  });

  it("deduplicates and filters citation URLs", () => {
    expect(
      citationUrls([
        "https://x.example/a",
        "https://x.example/a#b",
        "javascript:alert(1)",
        "https://u:p@x.example/",
      ]),
    ).toEqual(["https://x.example/a"]);
  });
});

describe("model support judge", () => {
  it("parses quoted passages and treats malformed answers as no support", async () => {
    const { ModelSupportJudge } = await import("../../src/research/support-judge.js");
    const ok = new ModelSupportJudge({
      modelVersion: "m",
      complete: async () =>
        '```json\n{"passages":[{"findingId":"request","passage":"Article I"}]}\n```',
    });
    expect(
      await ok.judge(
        { findings: [{ id: "request", statement: "s" }], report: "r", url: "u", source: TREATY },
        new AbortController().signal,
      ),
    ).toEqual({ passages: [{ findingId: "request", passage: "Article I" }] });
    const bad = new ModelSupportJudge({ modelVersion: "m", complete: async () => "no json here" });
    expect(
      await bad.judge(
        { findings: [], report: "", url: "u", source: "" },
        new AbortController().signal,
      ),
    ).toEqual({ passages: [] });
  });
});
