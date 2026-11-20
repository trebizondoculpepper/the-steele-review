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
import { ResearchManifestSchema } from "../../src/research/job.js";
import { type SupportJudge, runResearchJob } from "../../src/research/runner.js";
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
};
const fetcher: PageFetcher = {
  async fetch(url) {
    const p = pages[url];
    if (p instanceof WebAdapterError) throw p;
    if (p === undefined) throw new WebAdapterError("not-found");
    return { url, title: "t", text: p };
  },
};
const judge: SupportJudge = {
  async judge({ source }) {
    return [
      ...(source.includes("Article I")
        ? [{ findingId: "request", passage: "not to engage in military or any other hostile use" }]
        : []),
      { findingId: "request", passage: "a passage that is not in the source" },
      { findingId: "claim-from-elsewhere", passage: "Article I" },
    ];
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

describe("research runner", () => {
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
        { findings: [{ id: "request", statement: "s" }], url: "u", source: TREATY },
        new AbortController().signal,
      ),
    ).toEqual([{ findingId: "request", passage: "Article I" }]);
    const bad = new ModelSupportJudge({ modelVersion: "m", complete: async () => "no json here" });
    expect(
      await bad.judge({ findings: [], url: "u", source: "" }, new AbortController().signal),
    ).toEqual([]);
  });
});
