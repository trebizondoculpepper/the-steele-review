import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { resolveClaimEquivalence } from "../../src/analysis/claim-equivalence.js";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";
import {
  ClaimRecordSchema,
  claimRecordId,
  extractGroundedClaims,
} from "../../src/analysis/grounded-claims.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-equiv-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function model(...responses: string[]): ExtractionModelProvider & { calls: number } {
  const p = {
    modelVersion: "fake/model",
    calls: 0,
    async complete() {
      p.calls++;
      const next = responses.shift();
      if (next === undefined) throw new Error("no response");
      return next;
    },
  };
  return p;
}

/** Extract one assertion from a one-sentence post, through the real #144 path. */
async function post(postId: string, sentence: string) {
  const text = sentence;
  await extractGroundedClaims({
    provider: model(
      JSON.stringify({
        claims: [
          {
            statement: sentence.replace(/\.$/, ""),
            claimType: "factual",
            kind: "assertion",
            passage: sentence,
            qualifiers: [],
            entities: [],
            dates: [],
            speaker: { kind: "author-voice" },
            themeIds: [],
          },
        ],
      }),
    ),
    artifacts: content,
    themes: [],
    source: {
      text,
      sourceVersion: sourceVersionFor(text),
      artifact: {
        repository: "archive",
        commit: "a".repeat(40),
        path: `substack/pub/${postId}/collected.json`,
        hash: `sha256:${"b".repeat(64)}`,
      },
      publicationId: "pub",
      postId,
      url: `https://pub.example.com/p/${postId}`,
    },
  });
  return claimRecordId(sentence.replace(/\.$/, ""));
}

const read = async (id: string) =>
  ClaimRecordSchema.parse(
    JSON.parse(await content.read((await content.lookup(`claims/${id}.json`))!)),
  );

describe("resolveClaimEquivalence", () => {
  it("reuses an earlier claim for an equivalent rewording, keeping both occurrences", async () => {
    const first = await post("p1", "Weather modification has been around for decades.");
    const second = await post("p2", "Weather modification tools have existed for many decades.");
    const m = model(
      JSON.stringify({ match: first, confidence: "high", reason: "Same claim, reworded." }),
    );
    const out = await resolveClaimEquivalence({
      provider: m,
      artifacts: content,
      recordId: second,
    });
    expect(out).toMatchObject({ status: "merged", canonical: first });

    const canonical = await read(first);
    expect(canonical.occurrences.map((o) => o.postId)).toEqual(["p1", "p2"]);
    expect(canonical.equivalences?.[0]).toMatchObject({
      record: second,
      reason: "Same claim, reworded.",
    });
    expect((await read(second)).canonical).toBe(first);

    // Rerun: no model call, no extra occurrences.
    const again = await resolveClaimEquivalence({
      provider: model(),
      artifacts: content,
      recordId: second,
    });
    expect(again).toMatchObject({ status: "already-merged", canonical: first });
    expect((await read(first)).occurrences).toHaveLength(2);

    // A later occurrence of the reworded claim lands on the canonical record.
    await post("p3", "Weather modification tools have existed for many decades.");
    expect((await read(first)).occurrences.map((o) => o.postId)).toEqual(["p1", "p2", "p3"]);
  });

  it("keeps a negated or materially qualified claim separate", async () => {
    const first = await post("p1", "Weather modification has been around for decades.");
    const negated = await post("p2", "Weather modification has not been around for decades.");
    const out = await resolveClaimEquivalence({
      provider: model(
        JSON.stringify({ match: null, confidence: "high", reason: "One is a negation." }),
      ),
      artifacts: content,
      recordId: negated,
    });
    expect(out.status).toBe("separate");
    expect((await read(negated)).canonical).toBeUndefined();
    expect((await read(first)).occurrences).toHaveLength(1);
  });

  it("does not merge on low confidence or an ID that was not offered", async () => {
    await post("p1", "Weather modification has been around for decades.");
    const second = await post("p2", "Weather modification is maybe older than we think.");
    const low = await resolveClaimEquivalence({
      provider: model(
        JSON.stringify({
          match: claimRecordId("Weather modification has been around for decades"),
          confidence: "medium",
          reason: "Possibly.",
        }),
      ),
      artifacts: content,
      recordId: second,
    });
    expect(low.status).toBe("separate");

    const third = await post("p3", "Weather modification needs regulation.");
    const invented = await resolveClaimEquivalence({
      provider: model(
        JSON.stringify({ match: `claim-${"f".repeat(32)}`, confidence: "high", reason: "x" }),
      ),
      artifacts: content,
      recordId: third,
    });
    expect(invented.status).toBe("separate");
  });

  it("returns new without a model call when nothing is similar, and reports bad output", async () => {
    const lone = await post("p1", "The bins were late again.");
    const m = model();
    expect(
      (await resolveClaimEquivalence({ provider: m, artifacts: content, recordId: lone })).status,
    ).toBe("separate");
    expect(m.calls).toBe(0);

    const other = await post("p2", "The bins were collected late again.");
    const bad = await resolveClaimEquivalence({
      provider: model("nope", "{}"),
      artifacts: content,
      recordId: other,
    });
    expect(bad).toMatchObject({ status: "failed", reason: "malformed-output" });
  });
});
