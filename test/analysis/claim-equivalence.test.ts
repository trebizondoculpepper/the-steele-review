import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  mergeClaimRecords,
  resolveClaimEquivalence,
} from "../../src/analysis/claim-equivalence.js";
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
            themeIds: ["geoengineering"],
          },
        ],
      }),
    ),
    artifacts: content,
    // Accepted claims need a theme link (#182); candidates get no claim record.
    themes: [{ id: "geoengineering", name: "Geoengineering", definition: "Weather modification." }],
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

describe("resolveClaimEquivalence", { timeout: 60_000 }, () => {
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
    // Direction is deterministic (smaller ID is canonical) so concurrent
    // reciprocal merges agree.
    const [canonicalId, mergedId] = first < second ? [first, second] : [second, first];
    expect(out).toMatchObject({ status: "merged", canonical: canonicalId });

    const canonical = await read(canonicalId);
    expect(canonical.occurrences.map((o) => o.postId).sort()).toEqual(["p1", "p2"]);
    expect(canonical.occurrences[0].passage).toBeTruthy();
    expect(canonical.equivalences?.[0]).toMatchObject({ record: mergedId });
    expect((await read(mergedId)).canonical).toBe(canonicalId);

    for (const id of [first, second]) {
      const again = await resolveClaimEquivalence({
        provider: model(),
        artifacts: content,
        recordId: id,
      });
      expect(["already-merged", "separate"]).toContain(again.status);
    }
    expect((await read(canonicalId)).occurrences).toHaveLength(2);

    await post("p3", "Weather modification tools have existed for many decades.");
    expect((await read(canonicalId)).occurrences.map((o) => o.postId).sort()).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
  });

  it("finishes a merge interrupted after the redirect was saved", async () => {
    const first = await post("p1", "Weather modification has been around for decades.");
    const second = await post("p2", "Weather modification tools have existed for many decades.");
    const [canonicalId, mergedId] = first < second ? [first, second] : [second, first];
    const ref = (await content.lookup(`claims/${mergedId}.json`))!;
    const rec = await read(mergedId);
    await content.revise(
      `claims/${mergedId}.json`,
      `${JSON.stringify({ ...rec, canonical: canonicalId }, null, 2)}\n`,
      ref.sha256,
    );
    const out = await resolveClaimEquivalence({
      provider: model(),
      artifacts: content,
      recordId: mergedId,
    });
    expect(out).toMatchObject({ status: "already-merged", canonical: canonicalId });
    expect((await read(canonicalId)).occurrences).toHaveLength(2);
  });

  it("forwards a copy whose target was redirected meanwhile", async () => {
    const ids = [
      await post("p1", "Weather modification has been around for decades."),
      await post("p2", "Weather modification tools have existed for many decades."),
      await post("p3", "Weather modification has existed for decades now."),
    ].sort();
    const [a, b, c] = ids;
    // b already redirected to a (its occurrences copied); now merge c into b.
    const decision = {
      reason: "same",
      modelVersion: "m",
      promptVersion: "p",
      decidedAt: new Date(0).toISOString(),
    } as never;
    await mergeClaimRecords(content, b, a, decision);
    await mergeClaimRecords(content, c, b, decision);
    expect((await read(a)).occurrences).toHaveLength(3);
    expect((await read(b)).occurrences).toHaveLength(1);
  });

  it("keeps both extraction histories when a merged occurrence is shared", async () => {
    const id = (n: string) => `claim-${n.repeat(32).slice(0, 32)}`;
    const target = id("1");
    const source = id("2");
    const occurrence = (extraction: string, extractions?: string[]) => ({
      occurrenceId: "occ-shared",
      publicationId: "pub",
      postId: "p1",
      kind: "assertion",
      extraction,
      ...(extractions ? { extractions } : {}),
    });
    const write = async (
      recordId: string,
      others: { extraction: string; extractions?: string[] },
    ) =>
      content.revise(
        `claims/${recordId}.json`,
        `${JSON.stringify({
          schemaVersion: 1,
          id: recordId,
          statement: "Weather modification has run for decades",
          groupingKey: "weather modification has run for decades",
          themeIds: ["geoengineering"],
          occurrences: [occurrence(others.extraction, others.extractions)],
        })}\n`,
        null,
      );
    // Two re-extractions of the same passage: one occurrence identity, two
    // extraction artifacts, each having contributed theme links.
    await write(target, { extraction: "commit:one" });
    await write(source, {
      extraction: "commit:two",
      extractions: ["commit:one", "commit:two"],
    });
    await mergeClaimRecords(content, source, target, {
      reason: "same",
      modelVersion: "m",
      promptVersion: "p",
      decidedAt: new Date(0).toISOString(),
    } as never);

    const canonical = await read(target);
    expect(canonical.occurrences).toHaveLength(1);
    expect(canonical.occurrences[0].extractions).toEqual(["commit:one", "commit:two"]);
  });

  it("follows a redirect chain past the recovery bound to its true end", async () => {
    const id = (n: number) => `claim-${n.toString(16).padStart(32, "0")}`;
    const link = 25;
    const occurrence = (n: number) => ({
      occurrenceId: `occ-${n}`,
      publicationId: "pub",
      postId: `p${n}`,
      kind: "assertion",
      extraction: "commit:one",
    });
    // Successive merges into larger IDs can build a chain longer than any
    // fixed recovery depth; identity is per record, not bound by chain length.
    for (let n = 1; n <= link; n++) {
      await content.revise(
        `claims/${id(n)}.json`,
        `${JSON.stringify({
          schemaVersion: 1,
          id: id(n),
          statement: `claim ${n}`,
          groupingKey: `claim ${n}`,
          themeIds: [],
          occurrences: n === 1 || n === link ? [occurrence(n)] : [],
          ...(n < link ? { canonical: id(n + 1) } : {}),
        })}\n`,
        null,
      );
    }
    const out = await resolveClaimEquivalence({
      provider: model(),
      artifacts: content,
      recordId: id(1),
    });
    expect(out).toMatchObject({ status: "already-merged", canonical: id(link) });
    // The copy lands on the true end of the chain, not on an intermediate.
    expect((await read(id(link))).occurrences.map((o) => o.occurrenceId).sort()).toEqual([
      "occ-1",
      `occ-${link}`,
    ]);
  });

  it("refuses a redirect cycle instead of returning an intermediate record", async () => {
    const id = (n: string) => `claim-${n.repeat(32).slice(0, 32)}`;
    const [a, b] = [id("a"), id("b")];
    const record = (self: string, canonical: string) => ({
      schemaVersion: 1,
      id: self,
      statement: "Weather modification has run for decades",
      groupingKey: "group",
      themeIds: [],
      occurrences: [
        {
          occurrenceId: `occ-${self}`,
          publicationId: "pub",
          postId: "p1",
          kind: "assertion",
          extraction: "commit:one",
        },
      ],
      canonical,
    });
    await content.revise(`claims/${a}.json`, `${JSON.stringify(record(a, b))}\n`, null);
    await content.revise(`claims/${b}.json`, `${JSON.stringify(record(b, a))}\n`, null);
    await expect(
      resolveClaimEquivalence({ provider: model(), artifacts: content, recordId: a }),
    ).rejects.toThrow("claim redirect cycle");
  });

  it("never overwrites an existing redirect in competing merges", async () => {
    const [a, b, c] = [
      await post("p1", "Weather modification has been around for decades."),
      await post("p2", "Weather modification tools have existed for many decades."),
      await post("p3", "Weather modification has existed for decades now."),
    ].sort();
    const d = {
      reason: "same",
      modelVersion: "m",
      promptVersion: "p",
      decidedAt: new Date(0).toISOString(),
    };
    await mergeClaimRecords(content, c, b, d);
    await mergeClaimRecords(content, c, a, d); // competing decision for c
    expect((await read(c)).canonical).toBe(b); // first redirect kept
    expect((await read(b)).canonical).toBe(a); // the two canonicals merged
    expect((await read(a)).occurrences).toHaveLength(3);
  });

  it("recovers an interrupted merge when rerun from the canonical side", async () => {
    const [a, b] = [
      await post("p1", "Weather modification has been around for decades."),
      await post("p2", "Weather modification tools have existed for many decades."),
    ].sort();
    await content.write(`claim-merges/${b}.json`, JSON.stringify({ from: b })); // journalled, as a real merge does
    const ref = (await content.lookup(`claims/${b}.json`))!;
    await content.revise(
      `claims/${b}.json`,
      `${JSON.stringify({ ...(await read(b)), canonical: a }, null, 2)}\n`,
      ref.sha256,
    );
    await resolveClaimEquivalence({ provider: model(), artifacts: content, recordId: a });
    expect((await read(a)).occurrences).toHaveLength(2);
  });

  it("recovers pending copies through transitive redirects", async () => {
    const [a, b, c] = [
      await post("p1", "Weather modification has been around for decades."),
      await post("p2", "Weather modification tools have existed for many decades."),
      await post("p3", "Weather modification has existed for decades now."),
    ].sort();
    // C→B interrupted after its redirect; then B→A completes.
    await content.write(`claim-merges/${c}.json`, JSON.stringify({ from: c })); // journalled, as a real merge does
    const ref = (await content.lookup(`claims/${c}.json`))!;
    await content.revise(
      `claims/${c}.json`,
      `${JSON.stringify({ ...(await read(c)), canonical: b }, null, 2)}\n`,
      ref.sha256,
    );
    const d = {
      reason: "same",
      modelVersion: "m",
      promptVersion: "p",
      decidedAt: new Date(0).toISOString(),
    };
    await mergeClaimRecords(content, b, a, d);
    await resolveClaimEquivalence({ provider: model(), artifacts: content, recordId: a });
    expect((await read(a)).occurrences).toHaveLength(3);
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
