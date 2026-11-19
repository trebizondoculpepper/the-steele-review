import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";
import { extractGroundedClaims } from "../../src/analysis/grounded-claims.js";
import {
  MAX_DIAGNOSTIC_FIELD,
  candidateSnapshot,
  malformedResponse,
  safeText,
} from "../../src/analysis/rejection.js";
import { ThemeCatalogueStore, detectThemes } from "../../src/analysis/theme-catalogue.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";

const SECRET = "sk-or-v1-SENTINELSECRET0123456789abcdef";
const TEXT = "They are spraying the skies again. The bins were late.";
const source = {
  text: TEXT,
  sourceVersion: sourceVersionFor(TEXT),
  artifact: {
    repository: "archive",
    commit: "a".repeat(40),
    path: "substack/pub/post/collected.json",
    hash: `sha256:${"b".repeat(64)}`,
  },
  publicationId: "pub",
  postId: "post",
  url: "https://pub.example.com/p/post",
};

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-rejection-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const model = (...responses: string[]): ExtractionModelProvider => ({
  modelVersion: "fake/model",
  async complete() {
    const next = responses.shift();
    if (next === undefined) throw new Error("none");
    return next;
  },
});

describe("rejection diagnostics helpers", () => {
  it("keeps only allowlisted string fields, bounded and redacted", () => {
    const snap = candidateSnapshot(
      {
        name: "x".repeat(MAX_DIAGNOSTIC_FIELD + 50),
        definition: `uses ${SECRET}`,
        evil: "drop me",
        confidence: 3,
      },
      ["name", "definition", "confidence"],
    );
    expect(Object.keys(snap.fields).sort()).toEqual(["definition", "name"]);
    expect(snap.truncated).toBe(true);
    expect(snap.fields.name.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_FIELD + 1);
    expect(JSON.stringify(snap)).not.toContain("SENTINELSECRET");
    expect(JSON.stringify(snap)).not.toContain("drop me");
    expect(candidateSnapshot("not an object", ["name"]).fields).toEqual({});
  });

  it("redacts in bounded time on pathological input", () => {
    const start = performance.now();
    const out = safeText("a/".repeat(80_000), 1000);
    expect(performance.now() - start).toBeLessThan(500);
    expect(out.truncated).toBe(true);
  });

  it("classifies and bounds malformed responses", () => {
    expect(malformedResponse(1, "not json", 1000).reason).toBe("not-json");
    expect(malformedResponse(1, '{"wrong":1}', 1000).reason).toBe("invalid-structure");
    expect(malformedResponse(1, "y".repeat(50), 10).reason).toBe("too-large");
    const big = malformedResponse(2, `${"z".repeat(5000)} Bearer ${SECRET}`, 100_000);
    expect(big.truncated).toBe(true);
    expect(big.excerpt).not.toContain("SENTINELSECRET");
    expect(safeText(`a\u0000b\u001bc Bearer abcdefghijklmnop`, 100).text).toBe("abc [redacted]");
  });
});

describe("extractors keep rejected candidates inspectable", () => {
  it("records claim rejections with stage and candidate wording", async () => {
    const out = await extractGroundedClaims({
      provider: model(
        JSON.stringify({
          claims: [
            {
              statement: "The skies are sprayed with aluminium",
              claimType: "factual",
              kind: "assertion",
              passage: "an invented quotation",
              qualifiers: [],
              entities: [],
              dates: [],
              speaker: { kind: "author-voice" },
              themeIds: [],
            },
            { statement: "broken", extra: SECRET },
          ],
        }),
      ),
      artifacts: content,
      themes: [],
      source,
    });
    if (out.status !== "extracted") throw new Error(out.status);
    expect(out.record.claims).toEqual([]);
    expect(out.record.rejected.map((r) => [r.reason, r.stage])).toEqual([
      ["passage-not-found", "grounding"],
      ["malformed-claim", "schema"],
    ]);
    expect(out.record.rejected[0].candidate?.fields.statement).toBe(
      "The skies are sprayed with aluminium",
    );
    expect(JSON.stringify(out.record)).not.toContain("SENTINELSECRET");
  });

  it("records theme rejections and keeps a private trace of a failed run", async () => {
    const catalogue = new ThemeCatalogueStore(content);
    const ok = await detectThemes({
      provider: model(
        "not json",
        JSON.stringify({
          existing: [{ id: "invented", confidence: "low", passages: [{ passage: "bins" }] }],
          proposed: [],
        }),
      ),
      catalogue,
      artifacts: content,
      post: { publicationId: "pub", postId: "post" },
      source,
    });
    if (ok.status !== "detected") throw new Error(ok.status);
    expect(ok.detection.rejected[0]).toMatchObject({
      reason: "unknown-id",
      stage: "grounding",
      candidate: { fields: { id: "invented", confidence: "low" } },
    });
    expect(ok.detection.malformedAttempts?.[0]).toMatchObject({ attempt: 1, reason: "not-json" });

    const failed = await detectThemes({
      provider: model(`oops ${SECRET}`, "still not json"),
      catalogue,
      artifacts: content,
      post: { publicationId: "pub", postId: "other" },
      source,
    });
    expect(failed.status).toBe("failed");
    const traces = await content.list("extraction-failures", 10);
    expect(traces).toHaveLength(1);
    const trace = await content.read((await content.lookup(traces[0]))!);
    expect(trace).toContain("not-json");
    expect(trace).not.toContain("SENTINELSECRET");
  });
});
