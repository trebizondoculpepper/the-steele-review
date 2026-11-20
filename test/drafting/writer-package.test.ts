import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { PackageInputError, saveWriterPackage } from "../../src/drafting/writer-package.js";
import { DossierStore } from "../../src/research/dossier.js";
import { LexicalShortlister, assessPostCoverage } from "../../src/research/librarian.js";
import { CLAIMS, SHARED, librarianFixtures } from "../research/librarian-fixtures.js";

let dir: string;
let content: GitArtifactStore;
let fx: ReturnType<typeof librarianFixtures>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-writer-package-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  fx = librarianFixtures(content);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function coverageFor(
  plan: Parameters<typeof fx.researcher>[0],
  claims = CLAIMS,
  postId = "p1",
) {
  const a = await fx.analysis(postId, claims);
  const r = fx.researcher(plan);
  return {
    analysis: a,
    ...(await assessPostCoverage({
      artifacts: content,
      ...a,
      commission: r.commission,
      shortlister: new LexicalShortlister(),
    })),
  };
}

describe("writer evidence package (#148)", () => {
  it("pins source, analysis and dossiers, keeping covered claims and explicit gaps", async () => {
    const { ref } = await coverageFor(() => ({
      passages: [{ claimRecordId: "claim-treaty", url: SHARED }],
    }));
    const { package: pkg, ref: pkgRef } = await saveWriterPackage({ content, coverage: ref });
    expect(pkg.status).toBe("ready");
    expect(pkgRef.path).toMatch(/^writer-packages\/pub\/p1\//);
    const by = Object.fromEntries(pkg.claims.map((c) => [c.claimRecordId, c]));
    expect(by["claim-treaty"]).toMatchObject({
      status: "covered",
      coverage: "evidence-found",
      evidence: [{ url: SHARED }],
    });
    expect(by["claim-payment"]).toMatchObject({
      status: "gap",
      coverage: "no-independent-evidence",
      evidence: [],
    });
    expect(pkg.themes[0].title).toBe("Weather warfare");
    expect(pkg.source.artifact.path).toBe("substack/pub/p1/collected.json");
    expect(pkg.coverage.path).toBe(ref.path);
    expect(pkg.dossiers).toHaveLength(1);
  });

  it("reuses the same package on rerun, and a changed dossier gives a new one while the old stays readable", async () => {
    const { ref, analysis: a } = await coverageFor(() => ({
      passages: [{ claimRecordId: "claim-treaty", url: SHARED }],
    }));
    const first = await saveWriterPackage({ content, coverage: ref });
    const again = await saveWriterPackage({ content, coverage: ref });
    expect(again.ref).toEqual(first.ref);

    // A later dossier revision followed by a new coverage record yields a new package.
    const store = new DossierStore(content);
    const id = first.package.dossiers[0].dossierId;
    const current = (await store.current(id))!;
    await store.save({ ...current, body: `${current.body}\n\nRevised.` }, current.ref);
    const second = await assessPostCoverage({
      artifacts: content,
      ...a,
      commission: fx.researcher(() => ({ passages: [] })).commission,
      shortlister: new LexicalShortlister(),
    });
    const newer = await saveWriterPackage({ content, coverage: second.ref });
    expect(newer.ref.path).not.toBe(first.ref.path);
    expect(JSON.parse(await content.read(first.ref)).dossiers).toEqual(first.package.dossiers);
  });

  it("returns an explicit evidence-gap package when no claim has independent evidence", async () => {
    const { ref } = await coverageFor(() => "failed");
    const { package: pkg } = await saveWriterPackage({ content, coverage: ref });
    expect(pkg.status).toBe("evidence-gap");
    expect(pkg.claims.every((c) => c.status === "gap" && c.evidence.length === 0)).toBe(true);
  });

  it("refuses missing or mismatched inputs and pending research", async () => {
    await expect(
      saveWriterPackage({
        content,
        coverage: {
          repository: "content",
          commit: "f".repeat(40),
          path: "librarian/coverage/x.json",
          sha256: "0".repeat(64),
        },
      }),
    ).rejects.toThrow(PackageInputError);
    const { ref } = await coverageFor(() => ({ passages: [] }));
    const record = JSON.parse(await content.read(ref));
    record.themeResult.hash = `sha256:${"0".repeat(64)}`;
    const tampered = await content.write(
      "librarian/coverage/pub/p1/tampered.json",
      JSON.stringify(record),
    );
    await expect(saveWriterPackage({ content, coverage: tampered })).rejects.toThrow(
      "theme result",
    );
    const pending = await coverageFor(
      () => "busy",
      [{ id: "claim-other", statement: "Something else" }],
      "p2",
    );
    await expect(saveWriterPackage({ content, coverage: pending.ref })).rejects.toThrow("pending");
  });

  describe("narrative and movement context (#176)", () => {
    const comparison = (
      source: { repository: string; commit: string; path: string; hash: string },
      sourceVersion: string,
      kind: string,
      extra: Record<string, unknown> = {},
    ) =>
      JSON.stringify({
        status: "complete",
        claimId: `sha256:${"c".repeat(64)}`,
        findings: [
          {
            kind,
            explanation: {
              text: "The 2023 post makes the same claim about the treaty.",
              generatedBy: "m",
              isEvidence: false,
            },
            uncertainty: "medium",
            current: {
              claimId: "x",
              quote: "A treaty bans weather weapons.",
              artifact: source,
              sourceVersion,
              start: 0,
              end: 30,
            },
            earlier: [
              {
                passageId: "p",
                postId: "earlier-post",
                publishedAt: "2023-05-01",
                url: "https://pub.example.com/p/earlier-post",
                quote: "The treaty bans weather weapons.",
                artifact: {
                  repository: "archive",
                  commit: "d".repeat(40),
                  path: "substack/pub/earlier-post/collected.json",
                  hash: `sha256:${"e".repeat(64)}`,
                },
                start: 0,
                end: 32,
              },
            ],
            ...extra,
          },
        ],
        rejected: [],
        modelVersion: "m",
        promptVersion: "p",
      });

    it("carries dated earlier passages as quoted evidence and the comparison as generated text", async () => {
      const { ref } = await coverageFor(() => ({
        passages: [{ claimRecordId: "claim-treaty", url: SHARED }],
      }));
      const record = JSON.parse(await content.read(ref));
      const themes = JSON.parse(
        await content.read((await content.lookup(record.themeResult.path))!),
      );
      const rep = await content.write(
        "comparisons/pub/p1/a.json",
        comparison(record.source, themes.sourceVersion, "repetition"),
      );
      const contra = await content.write(
        "comparisons/pub/p1/b.json",
        comparison(record.source, themes.sourceVersion, "possible-contradiction", {
          conflictRationale:
            "Earlier the author said the treaty was irrelevant; wording differs in scope.",
        }),
      );
      const { package: pkg } = await saveWriterPackage({
        content,
        coverage: ref,
        comparisons: [rep, contra],
      });
      const history = pkg.context!.history;
      expect(history.status).toBe("available");
      expect(history.comparisons[0]).toMatchObject({
        kind: "repetition",
        earlier: [
          {
            publishedAt: "2023-05-01",
            quote: "The treaty bans weather weapons.",
            url: "https://pub.example.com/p/earlier-post",
          },
        ],
        comparison: { isEvidence: false },
      });
      expect(history.comparisons[1]).toMatchObject({
        kind: "possible-contradiction",
        conflictRationale: expect.stringContaining("differs"),
      });
      // Movement background comes from the dossier's independently cited passages.
      expect(pkg.context!.background).toMatchObject({
        status: "available",
        passages: [{ url: SHARED }],
      });
    });

    it("records absent history and absent movement background as explicit gaps", async () => {
      const { ref } = await coverageFor(() => ({ passages: [] }));
      const { package: pkg } = await saveWriterPackage({ content, coverage: ref });
      expect(pkg.context!.history).toMatchObject({ status: "gap", comparisons: [] });
      expect(pkg.context!.background).toMatchObject({ status: "gap", passages: [] });
    });

    it("refuses a comparison about another source version, and changed context yields a new package", async () => {
      const { ref } = await coverageFor(() => ({
        passages: [{ claimRecordId: "claim-treaty", url: SHARED }],
      }));
      const record = JSON.parse(await content.read(ref));
      const themes = JSON.parse(
        await content.read((await content.lookup(record.themeResult.path))!),
      );
      const other = await content.write(
        "comparisons/pub/p1/other.json",
        comparison(record.source, `sha256:${"9".repeat(64)}`, "repetition"),
      );
      await expect(
        saveWriterPackage({ content, coverage: ref, comparisons: [other] }),
      ).rejects.toThrow("another source version");
      const plain = await saveWriterPackage({ content, coverage: ref });
      const rep = await content.write(
        "comparisons/pub/p1/a.json",
        comparison(record.source, themes.sourceVersion, "repetition"),
      );
      const withHistory = await saveWriterPackage({ content, coverage: ref, comparisons: [rep] });
      expect(withHistory.ref.path).not.toBe(plain.ref.path);
    });
  });
});
