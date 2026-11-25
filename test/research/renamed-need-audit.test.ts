import { MAX_CLAIMS_PER_REQUEST } from "../../src/research/librarian.js";
import {
  sourceContextFor,
  saveSourceContext,
} from "../../src/content/source-context.js";
import { saveWriterPackage } from "../../src/drafting/writer-package.js";
import { createHash } from "node:crypto";
import { newDossierId } from "../../src/research/librarian.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { runResearchJob } from "../../src/research/runner.js";
import type { ResearchRequest } from "../../src/research/job.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import {
  assessPostCoverage,
  LexicalShortlister,
} from "../../src/research/librarian.js";
import { researchJobId, openResearchJob } from "../../src/research/job.js";
import { librarianFixtures, SHARED } from "./librarian-fixtures.js";
import { proposeThemes } from "../../src/analysis/theme-proposals.js";
import { createClaim } from "../../src/analysis/claim.js";
import { createClaimOccurrence } from "../../src/analysis/claim-occurrence.js";
import {
  ClaimExtractionRecordSchema,
  claimRecordId,
} from "../../src/analysis/grounded-claims.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
const statements = [
  "The ENMOD Convention prohibits hostile environmental modification.",
  "The ENMOD Convention was adopted on 10 December 1976.",
];
const text = statements.join(" ");
const treatyId = claimRecordId(statements[0]!);
const meta = {
  modelVersion: "synthetic/model",
  promptVersion: "synthetic-prompt",
  extractedAt: "2026-01-01T00:00:00.000Z",
};
async function analysis(
  artifacts: GitArtifactStore,
  postId: string,
  needRecordId: string,
  options: {
    qualifier?: string;
    reverse?: boolean;
    title?: string;
    description?: string;
    duplicateMixed?: boolean;
    quotedBy?: string;
    statements?: string[];
    claimIds?: string[];
  } = {},
) {
  const assertions = options.statements ?? statements;
  const bodyText = options.qualifier
    ? assertions
        .join(" ")
        .replace(assertions[1]!, `${options.qualifier} ${assertions[1]}`)
    : assertions.join(" ");
  const sourceText = options.quotedBy
    ? `${options.quotedBy} said: ${bodyText}`
    : bodyText;
  const actualText = options.duplicateMixed
    ? `${sourceText} ${assertions[1]}`
    : sourceText;
  const post = { publicationId: "pub", postId };
  const raw = await artifacts.write(
    `synthetic-sources/${postId}.md`,
    actualText,
  );
  const artifact = {
    repository: raw.repository,
    commit: raw.commit,
    path: raw.path,
    hash: `sha256:${raw.sha256}`,
  };
  const source = {
    text: actualText,
    sourceVersion: sourceVersionFor(actualText),
    artifact,
    publicationId: "pub",
    postId,
    url: `https://source.example/${postId}`,
    author: `Synthetic author ${postId}`,
  };
  const contextRef = await saveSourceContext(
    artifacts,
    sourceContextFor(
      {
        item: {
          publicationId: "pub",
          postId,
          url: source.url,
          title: `Synthetic ${postId}`,
          author: source.author,
        },
        ingestionReason: "live",
        supplied: { articleHtml: `<p>${actualText}</p>` },
        text: actualText,
        complete: true,
        provenance: {
          sourceUrl: source.url,
          acquiredAt: meta.extractedAt,
          method: "article-html",
          originalMedium: "written",
        },
      },
      raw,
    ),
  );
  const sourceContext = {
    repository: contextRef.repository,
    commit: contextRef.commit,
    path: contextRef.path,
    hash: `sha256:${contextRef.sha256}`,
  };
  const proposed = await proposeThemes({
    provider: {
      modelVersion: "synthetic/model",
      complete: async () =>
        JSON.stringify({
          themes: [
            {
              title: options.title ?? "Weather warfare",
              description:
                options.description ??
                "History and scope of the ENMOD Convention",
            },
          ],
        }),
    },
    artifacts,
    post,
    source,
    sourceContext: contextRef,
  });
  if (proposed.status !== "proposed")
    throw new Error(`synthetic-theme-fixture-${proposed.reason}`);
  const themeResult = proposed.ref;
  const proposal = JSON.parse(await artifacts.read(themeResult)).proposals[0]
    .id as string;
  const claims = assertions.map((statement, i) => {
    const passage =
      options.qualifier && i === 1
        ? `${options.qualifier} ${statement}`
        : statement;
    const start = actualText.indexOf(passage);
    const claim = createClaim(
      {
        statement,
        claimType: "factual",
        sourceVersion: source.sourceVersion,
        span: { start, end: start + passage.length },
        passage,
        entities: ["ENMOD Convention"],
        ...(options.qualifier && i === 1
          ? { qualifiers: [options.qualifier] }
          : {}),
        dates:
          i === 1 ? [{ text: "10 December 1976", value: "1976-12-10" }] : [],
        extraction: meta,
      },
      source,
    );
    const occurrence = createClaimOccurrence({
      claim,
      source,
      speaker: options.quotedBy
        ? {
            kind: "quoted",
            name: options.quotedBy,
            evidence: { start: 0, end: options.quotedBy.length },
          }
        : { kind: "author-voice" },
      assertionKind: options.quotedBy ? "quotation" : "assertion",
      themes: [proposal],
    });
    return {
      claim,
      occurrence,
      kind: options.quotedBy ? ("quotation" as const) : ("assertion" as const),
      themeIds: [proposal],
      classification: "themed" as const,
      claimRecordId:
        i === 0 ? treatyId : (options.claimIds?.[i] ?? needRecordId),
    };
  });
  if (options.duplicateMixed) {
    const statement = assertions[1]!;
    const start = actualText.lastIndexOf(statement);
    const claim = createClaim(
      {
        statement,
        claimType: "factual",
        sourceVersion: source.sourceVersion,
        span: { start, end: start + statement.length },
        passage: statement,
        entities: ["ENMOD Convention"],
        dates: [{ text: "10 December 1976", value: "1976-12-10" }],
        extraction: meta,
      },
      source,
    );
    const occurrence = createClaimOccurrence({
      claim,
      source,
      speaker: { kind: "author-voice" },
      assertionKind: "assertion",
      themes: [proposal],
    });
    claims.push({
      claim,
      occurrence,
      kind: "assertion",
      themeIds: [proposal],
      classification: "themed",
      claimRecordId: needRecordId,
    });
  }
  const record = ClaimExtractionRecordSchema.parse({
    schemaVersion: 4,
    post,
    sourceVersion: source.sourceVersion,
    themeIds: [proposal],
    sourceContext,
    themeResult: `${themeResult.commit}:${themeResult.path}`,
    claims: options.reverse ? [...claims].reverse() : claims,
    candidates: [],
    rejected: [],
    extraction: meta,
  });
  const claimResult = await artifacts.write(
    `claim-extractions/pub/${postId}/r.json`,
    JSON.stringify(record),
  );
  return { themeResult, claimResult };
}
it(
  "reuses a current accepted date-scoped need across renamed record identifiers and source authors",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-renamed-need-audit-"));
    try {
      const artifacts = new GitArtifactStore({
        repoPath: dir,
        repository: "content",
      });
      await artifacts.initialise();
      const fx = librarianFixtures(artifacts);
      const first = await analysis(
        artifacts,
        "first",
        `claim-${"a".repeat(32)}`,
      );
      const operations = new OperationStore({
        path: join(dir, "state.sqlite"),
      });
      const commission = async (req: ResearchRequest) => {
        const outcome = await runResearchJob({
          artifacts,
          operations,
          request: req,
          owner: "synthetic",
          sonar: {
            model: "synthetic",
            research: async () => ({
              model: "synthetic",
              report: "Independent treaty history.",
              citations: [SHARED],
            }),
          },
          fetcher: { fetch: async (url) => ({ url, title: "Treaty", text }) },
          judge: {
            judge: async ({ findings }) => ({
              sourceType: "treaty",
              passages: findings
                .filter((f) => f.statement.includes("prohibits"))
                .map((f) => ({ findingId: f.id, passage: statements[0]! })),
            }),
          },
        });
        return outcome.status === "finished"
          ? {
              status: "finished" as const,
              jobId: outcome.jobId,
              result: outcome.result,
              resultRef: await artifacts.lookup(
                `research-jobs/${outcome.jobId}/result.json`,
              ),
            }
          : outcome;
      };
      const initial = await assessPostCoverage({
        artifacts,
        ...first,
        commission,
        shortlister: new LexicalShortlister(),
      });
      const themeId = initial.record.mappings[0]!.dossierId;
      const jobs: string[] = [];
      for (const [post, id] of [
        ["later-a", `claim-${"b".repeat(32)}`],
        ["later-b", `claim-${"c".repeat(32)}`],
      ]) {
        const a = await analysis(artifacts, post!, id!);
        const pending = fx.researcher(() => "busy");
        const later = await assessPostCoverage({
          artifacts,
          ...a,
          commission: pending.commission,
          shortlister: new LexicalShortlister(),
          judge: {
            decide: async () => ({
              themeId,
              rationale: "same canonical topic",
            }),
          },
        });
        expect(
          later.record.claims.find((c) => c.claimRecordId === treatyId),
        ).toMatchObject({
          status: "evidence-found",
          reused: true,
        });
        expect(pending.requests).toHaveLength(1);
        expect(pending.requests[0]!.claims.map((c) => c.statement)).toEqual([
          statements[1],
        ]);
        expect(pending.requests[0]!.origin).toBe("theme");
        jobs.push(researchJobId(pending.requests[0]!));
      }
      expect(jobs[0]).toBe(jobs[1]);
      operations.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it(
  "projects finished need evidence onto renamed current occurrences without reusing old passage IDs or different qualifiers",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-finished-need-"));
    const artifacts = new GitArtifactStore({
      repoPath: dir,
      repository: "content",
    });
    await artifacts.initialise();
    const operations = new OperationStore({ path: join(dir, "state.sqlite") });
    let discoveries = 0;
    const requests: ResearchRequest[] = [];
    let supportDate = false;
    const commission = async (request: ResearchRequest) => {
      requests.push(request);
      const outcome = await runResearchJob({
        artifacts,
        operations,
        request,
        owner: "synthetic",
        sonar: {
          model: "synthetic",
          research: async () => {
            discoveries++;
            return {
              model: "synthetic",
              report: "Independent treaty history.",
              citations: [SHARED],
            };
          },
        },
        fetcher: { fetch: async (url) => ({ url, title: "Treaty", text }) },
        judge: {
          judge: async ({ findings }) => ({
            sourceType: "treaty",
            passages: findings
              .filter((f) => supportDate || f.statement.includes("prohibits"))
              .map((f) => ({
                findingId: f.id,
                passage: f.statement.includes("prohibits")
                  ? statements[0]!
                  : statements[1]!,
              })),
          }),
        },
      });
      return outcome.status === "finished"
        ? {
            status: "finished" as const,
            jobId: outcome.jobId,
            result: outcome.result,
            resultRef: await artifacts.lookup(
              `research-jobs/${outcome.jobId}/result.json`,
            ),
          }
        : outcome;
    };
    try {
      const first = await analysis(
        artifacts,
        "seed",
        `claim-${"1".repeat(32)}`,
      );
      await assessPostCoverage({
        artifacts,
        ...first,
        commission,
        shortlister: new LexicalShortlister(),
      });
      supportDate = true;
      const second = await analysis(
        artifacts,
        "enhance",
        `claim-${"2".repeat(32)}`,
      );
      const completed = await assessPostCoverage({
        artifacts,
        ...second,
        commission,
        shortlister: new LexicalShortlister(),
      });
      expect(
        completed.record.claims.every((c) => c.status === "evidence-found"),
      ).toBe(true);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.claims.map((c) => c.statement)).toEqual([
        statements[1],
      ]);
      const currentId = `claim-${"3".repeat(32)}`;
      const third = await analysis(artifacts, "current", currentId, {
        reverse: true,
      });
      const reused = await assessPostCoverage({
        artifacts,
        ...third,
        commission: async () => {
          throw new Error("must not commission cached evidence");
        },
        shortlister: new LexicalShortlister(),
      });
      expect(
        reused.record.claims.every(
          (c) => c.status === "evidence-found" && c.reused,
        ),
      ).toBe(true);
      expect(reused.record.claims.map((c) => c.claimRecordId)).toContain(
        currentId,
      );
      expect(reused.record.claims.map((c) => c.claimRecordId)).not.toContain(
        `claim-${"2".repeat(32)}`,
      );
      expect(discoveries).toBe(2);
      expect(reused.record.jobs).toHaveLength(2);
      const packaged = await saveWriterPackage({
        content: artifacts,
        coverage: reused.ref,
      });
      const currentEvidence = packaged.package.claims.find(
        (c) => c.claimRecordId === currentId,
      )!.evidence;
      const originalJob = completed.record.jobs.find(
        (j) =>
          j.jobId ===
          reused.record.claims.find((c) => c.claimRecordId === currentId)!
            .jobIds[0],
      )!;
      const originalManifest = JSON.parse(
        await artifacts.read({
          repository: originalJob.manifest!.repository,
          commit: originalJob.manifest!.commit,
          path: originalJob.manifest!.path,
          sha256: originalJob.manifest!.hash.slice(7),
        }),
      );
      expect(currentEvidence[0]!.passage).toBe(statements[1]);
      expect(currentEvidence[0]!.archived).toEqual(
        originalManifest.citations[0].archivedArtifact,
      );
      const changed = await analysis(artifacts, "changed-scope", currentId, {
        qualifier: "allegedly",
      });
      const pending = librarianFixtures(artifacts).researcher(() => "busy");
      const scoped = await assessPostCoverage({
        artifacts,
        ...changed,
        commission: pending.commission,
        shortlister: new LexicalShortlister(),
      });
      expect(
        scoped.record.claims.find((c) => c.claimRecordId === currentId),
      ).toMatchObject({
        status: "pending",
        reused: false,
      });
      expect(pending.requests).toHaveLength(1);
      expect(pending.requests[0]!.claims.map((c) => c.statement)).toEqual([
        statements[1],
      ]);
      expect(
        pending.requests[0]!.canonicalNeeds!.needs[0]!.proposition.qualifiers,
      ).toEqual(["allegedly"]);
      expect(discoveries).toBe(2);
    } finally {
      operations.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it(
  "lazily proves compatible immutable legacy full reports without rewriting them or commissioning research",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-legacy-need-"));
    const artifacts = new GitArtifactStore({
      repoPath: dir,
      repository: "content",
    });
    await artifacts.initialise();
    const operations = new OperationStore({ path: join(dir, "state.sqlite") });
    try {
      const first = await analysis(
        artifacts,
        "legacy",
        `claim-${"4".repeat(32)}`,
      );
      const ref = (r: typeof first.themeResult) => ({
        repository: r.repository,
        commit: r.commit,
        path: r.path,
        hash: `sha256:${r.sha256}`,
      });
      const key = createHash("sha256")
        .update(
          JSON.stringify([ref(first.themeResult), ref(first.claimResult)]),
        )
        .digest("hex")
        .slice(0, 32);
      const dossierId = newDossierId("Weather warfare");
      const planRef = await artifacts.write(
        `librarian/request-plans/pub/legacy/${key}.json`,
        JSON.stringify({
          schemaVersion: 2,
          dossiers: { [dossierId]: { mode: "full" } },
          order: [dossierId],
        }),
      );
      let originalRequest: ResearchRequest | undefined;
      let discoveries = 0;
      const seeded = await assessPostCoverage({
        artifacts,
        ...first,
        shortlister: new LexicalShortlister(),
        commission: async (request) => {
          originalRequest = request;
          const result = await runResearchJob({
            artifacts,
            operations,
            request,
            owner: "synthetic",
            sonar: {
              model: "synthetic",
              research: async () => {
                discoveries++;
                return {
                  model: "synthetic",
                  report: "Independent historical findings.",
                  citations: [SHARED],
                };
              },
            },
            fetcher: { fetch: async (url) => ({ url, title: "Treaty", text }) },
            judge: {
              judge: async ({ findings }) => ({
                sourceType: "treaty",
                passages: findings.map((f) => ({
                  findingId: f.id,
                  passage: f.statement,
                })),
              }),
            },
          });
          return result.status === "finished"
            ? {
                status: "finished",
                jobId: result.jobId,
                result: result.result,
                resultRef: await artifacts.lookup(
                  `research-jobs/${result.jobId}/result.json`,
                ),
              }
            : result;
        },
      });
      expect(originalRequest!.canonicalNeeds).toBeUndefined();
      expect(
        seeded.record.claims.every((c) => c.status === "evidence-found"),
      ).toBe(true);
      const oldResultRef = await artifacts.lookup(
        `research-jobs/${researchJobId(originalRequest!)}/result.json`,
      );
      const oldResultBytes = await artifacts.read(oldResultRef!);
      const later = await analysis(
        artifacts,
        "later-legacy",
        `claim-${"5".repeat(32)}`,
        {
          reverse: true,
        },
      );
      const reused = await assessPostCoverage({
        artifacts,
        ...later,
        shortlister: new LexicalShortlister(),
        commission: async () => {
          throw new Error("legacy proof must not commission");
        },
      });
      expect(
        reused.record.claims.every(
          (c) => c.reused && c.status === "evidence-found",
        ),
      ).toBe(true);
      expect(discoveries).toBe(1);
      expect(await artifacts.read(oldResultRef!)).toBe(oldResultBytes);
      expect(await artifacts.lookup(planRef.path)).toEqual(planRef);
      expect(researchJobId(originalRequest!)).toBe(
        oldResultRef!.path.split("/")[1],
      );
    } finally {
      operations.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it(
  "records same-title conflicting meanings as unresolved without creating or researching a new dossier",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-title-conflict-"));
    try {
      const artifacts = new GitArtifactStore({
        repoPath: dir,
        repository: "content",
      });
      await artifacts.initialise();
      const { ThemeStore, listCanonicalThemes } =
        await import("../../src/research/theme-store.js");
      await new ThemeStore(artifacts).ensure({
        id: "mercury-planet",
        title: "Mercury",
        description: "Astronomical planet orbit around the Sun",
        createdAt: meta.extractedAt,
      });
      const item = await analysis(
        artifacts,
        "mercury",
        `claim-${"6".repeat(32)}`,
        {
          title: "Mercury",
          description: "Toxic liquid metal health hazards",
        },
      );
      const result = await assessPostCoverage({
        artifacts,
        ...item,
        shortlister: new LexicalShortlister(),
        commission: async () => {
          throw new Error("uncertain theme must not research");
        },
      });
      expect(result.record.mappings).toEqual([]);
      // The byline's author theme (added on main) is also proposed; this test
      // is about the same-title Mercury conflict.
      const mercury = result.record.unresolvedProposals!.filter(
        (p) => p.title === "Mercury",
      );
      expect(mercury).toHaveLength(1);
      expect(mercury[0]!.reason).toContain("conflicts");
      expect(
        result.record.claims.every(
          (c) => c.dossierId === null && c.status === "not-commissioned",
        ),
      ).toBe(true);
      expect(await listCanonicalThemes(new ThemeStore(artifacts))).toHaveLength(
        1,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it(
  "checks exact titles and saved title aliases before a truncated similarity shortlist",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-title-first-"));
    try {
      const artifacts = new GitArtifactStore({
        repoPath: dir,
        repository: "content",
      });
      await artifacts.initialise();
      const { ThemeStore } = await import("../../src/research/theme-store.js");
      const { ThemeMappingCatalogue } =
        await import("../../src/research/theme-mappings.js");
      await new ThemeStore(artifacts).ensure({
        id: "enmod-topic",
        title: "Environmental treaties",
        description: "History and scope of the ENMOD Convention",
        createdAt: meta.extractedAt,
      });
      await new ThemeMappingCatalogue(artifacts).recordPinned({
        schemaVersion: 1,
        proposal: "Weather warfare",
        description: "History and scope of the ENMOD Convention",
        canonicalThemeId: "enmod-topic",
        decidedAt: meta.extractedAt,
        decidedBy: { publicationId: "pub", postId: "saved" },
        rationale: "synthetic established alias",
      });
      const item = await analysis(
        artifacts,
        "alias",
        `claim-${"7".repeat(32)}`,
        {
          description: "History and scope of the ENMOD treaty Convention",
        },
      );
      const pending = librarianFixtures(artifacts).researcher(() => "busy");
      const result = await assessPostCoverage({
        artifacts,
        ...item,
        commission: pending.commission,
        shortlister: {
          shortlist: async () => ({
            method: "lexical",
            candidates: Array.from({ length: 5 }, (_, i) => ({
              themeId: `unrelated-${i}`,
              title: `Unrelated ${i}`,
              scope: "synthetic",
              score: 1,
            })),
          }),
        },
      });
      expect(result.record.mappings[0]!.dossierId).toBe("enmod-topic");
      expect(result.record.mappings[0]!.created).toBe(false);
      expect(result.record.mappings[0]!.rationale).toContain("title-first");
      expect(pending.requests).toHaveLength(1);
      expect(
        pending.requests[0]!.claims.every(
          (c) => c.themeIds[0] === "enmod-topic",
        ),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it(
  "keeps titles primary in fallback and retains short UN and 5G identifiers",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-title-fallback-"));
    try {
      const artifacts = new GitArtifactStore({
        repoPath: dir,
        repository: "content",
      });
      await artifacts.initialise();
      const { ThemeStore } = await import("../../src/research/theme-store.js");
      const scope =
        "Public accountability policy and facial recognition systems";
      const store = new ThemeStore(artifacts);
      await store.ensure({
        id: "un-topic",
        title: "UN surveillance",
        description: scope,
        createdAt: meta.extractedAt,
      });
      await store.ensure({
        id: "5g-topic",
        title: "5G",
        description: scope,
        createdAt: meta.extractedAt,
      });
      await store.ensure({
        id: "distractor",
        title: "Separate archive",
        description: scope,
        createdAt: meta.extractedAt,
      });
      const shortlister = {
        shortlist: async () => ({
          method: "lexical" as const,
          candidates: [
            {
              themeId: "distractor",
              title: "Separate archive",
              scope,
              score: 1,
            },
          ],
        }),
      };
      for (const [title, id] of [
        ["UN", "un-topic"],
        ["5G policy", "5g-topic"],
      ]) {
        const item = await analysis(artifacts, id!, `claim-${"8".repeat(32)}`, {
          title,
          description: scope,
        });
        const pending = librarianFixtures(artifacts).researcher(() => "busy");
        const result = await assessPostCoverage({
          artifacts,
          ...item,
          shortlister,
          commission: pending.commission,
        });
        expect(result.record.mappings[0]!.dossierId).toBe(id);
        expect(result.record.mappings[0]!.rationale).toContain("title-primary");
      }
      const unrelated = await analysis(
        artifacts,
        "unrelated",
        `claim-${"9".repeat(32)}`,
        {
          title: "Unrelated subject",
          description: scope,
        },
      );
      const result = await assessPostCoverage({
        artifacts,
        ...unrelated,
        shortlister,
        commission: async () => {
          throw new Error("description-only candidate must not commission");
        },
      });
      expect(result.record.mappings).toEqual([]);
      expect(result.record.unresolvedProposals![0]!.reason).toContain(
        "description similarity alone",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it(
  "refuses legacy passage attribution when one original grouped ID has mixed accepted semantic scopes",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-legacy-ambiguous-"));
    const artifacts = new GitArtifactStore({
      repoPath: dir,
      repository: "content",
    });
    await artifacts.initialise();
    const operations = new OperationStore({ path: join(dir, "state.sqlite") });
    try {
      const id = `claim-${"a".repeat(32)}`;
      const old = await analysis(artifacts, "mixed-old", id, {
        qualifier: "allegedly",
        duplicateMixed: true,
      });
      const themes = JSON.parse(await artifacts.read(old.themeResult));
      const record = JSON.parse(await artifacts.read(old.claimResult));
      const ref = (r: typeof old.themeResult) => ({
        repository: r.repository,
        commit: r.commit,
        path: r.path,
        hash: `sha256:${r.sha256}`,
      });
      const request: ResearchRequest = {
        schemaVersion: 1,
        origin: "extraction",
        pass: 1,
        post: {
          publicationId: "pub",
          postId: "mixed-old",
          sourceArtifact: themes.artifact,
          sourceContext: record.sourceContext,
          themeResult: ref(old.themeResult),
          claimResult: ref(old.claimResult),
        },
        claims: [
          {
            claimRecordId: id,
            statement: statements[1]!,
            themeIds: ["enmod-topic"],
          },
        ],
        question: "What does independent evidence show?",
        corpusRefs: [],
      };
      let discoveries = 0;
      await runResearchJob({
        artifacts,
        operations,
        request,
        owner: "synthetic",
        sonar: {
          model: "synthetic",
          research: async () => {
            discoveries++;
            return {
              model: "synthetic",
              report: "Treaty history.",
              citations: [SHARED],
            };
          },
        },
        fetcher: { fetch: async (url) => ({ url, title: "Treaty", text }) },
        judge: {
          judge: async () => ({
            sourceType: "treaty",
            passages: [{ findingId: id, passage: statements[1]! }],
          }),
        },
      });
      const current = await analysis(artifacts, "mixed-current", id);
      const currentThemes = JSON.parse(
        await artifacts.read(current.themeResult),
      );
      const { researchNeedBindings } =
        await import("../../src/research/need-bindings.js");
      const binding = researchNeedBindings({
        record: JSON.parse(await artifacts.read(current.claimResult)),
        source: currentThemes.artifact,
        ...current,
        mappings: new Map(
          currentThemes.proposals.map((p: { id: string }) => [
            p.id,
            "enmod-topic",
          ]),
        ),
      });
      const { createLegacyResearchNeedLookup } =
        await import("../../src/research/need-evidence.js");
      const result = await createLegacyResearchNeedLookup(artifacts)(
        binding.entries.find((e) => e.claimRecordId === id)!.need,
      );
      expect(result).toEqual({
        status: "unavailable",
        reason: "legacy-proof-ambiguous",
      });
      expect(discoveries).toBe(1);
    } finally {
      operations.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it(
  "reconnects pending full research across current analyses, bylines, context and proposal aliases using one actual request",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-pending-canonical-"));
    const artifacts = new GitArtifactStore({
      repoPath: dir,
      repository: "content",
    });
    await artifacts.initialise();
    const operations = new OperationStore({ path: join(dir, "state.sqlite") });
    try {
      let claimed = 0;
      let providerCalls = 0;
      const requests: ResearchRequest[] = [];
      const commission = async (request: ResearchRequest) => {
        requests.push(request);
        const opened = await openResearchJob({
          artifacts,
          operations,
          request,
          owner: `synthetic-${requests.length}`,
        });
        if (opened.status === "run") claimed++;
        return { status: "busy" as const, jobId: opened.jobId };
      };
      const first = await analysis(
        artifacts,
        "pending-first",
        `claim-${"b".repeat(32)}`,
      );
      const pendingFirst = await assessPostCoverage({
        artifacts,
        ...first,
        shortlister: new LexicalShortlister(),
        commission,
      });
      const themeId = pendingFirst.record.mappings[0]!.dossierId;
      const { ThemeMappingCatalogue } =
        await import("../../src/research/theme-mappings.js");
      await new ThemeMappingCatalogue(artifacts).recordPinned({
        schemaVersion: 1,
        proposal: "Treaty obligations",
        description: "History and scope of the ENMOD Convention",
        canonicalThemeId: themeId,
        decidedAt: meta.extractedAt,
        decidedBy: { publicationId: "pub", postId: "synthetic-alias" },
        rationale: "synthetic verified canonical alias",
      });
      const second = await analysis(
        artifacts,
        "pending-second",
        `claim-${"c".repeat(32)}`,
        {
          title: "Treaty obligations",
          reverse: true,
        },
      );
      const pendingSecond = await assessPostCoverage({
        artifacts,
        ...second,
        shortlister: new LexicalShortlister(),
        commission,
      });
      expect(requests).toHaveLength(2);
      expect(requests[0]).toEqual(requests[1]);
      expect(requests[0]!.origin).toBe("theme");
      expect(requests[0]!.post).toBeUndefined();
      expect(requests[0]!.question).toContain(themeId);
      expect(requests[0]!.question).not.toContain("Treaty obligations");
      expect(researchJobId(requests[0]!)).toBe(researchJobId(requests[1]!));
      expect(claimed).toBe(1);
      expect(pendingFirst.record.needBindings).not.toEqual(
        pendingSecond.record.needBindings,
      );
      const reconnect = await runResearchJob({
        artifacts,
        operations,
        request: requests[1]!,
        owner: "reconnect",
        sonar: {
          model: "synthetic",
          research: async () => {
            providerCalls++;
            throw new Error("must reconnect active job");
          },
        },
        fetcher: {
          fetch: async () => {
            throw new Error("no fetch");
          },
        },
        judge: {
          judge: async () => {
            throw new Error("no support call");
          },
        },
      });
      expect(reconnect).toMatchObject({
        status: "busy",
        jobId: researchJobId(requests[0]!),
      });
      expect(providerCalls).toBe(0);
    } finally {
      operations.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it(
  "keeps canonical full-request batch boundaries stable when more than 100 extraction IDs are renamed",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-canonical-batches-"));
    try {
      const artifacts = new GitArtifactStore({
        repoPath: dir,
        repository: "content",
      });
      await artifacts.initialise();
      const assertions = Array.from(
        { length: 101 },
        (_, i) =>
          `The ENMOD Convention synthetic assertion ${"x".repeat(i + 1)} was recorded on 10 December 1976.`,
      );
      const one = await analysis(artifacts, "batches-first", "unused", {
        statements: assertions,
        claimIds: assertions.map(
          (_, i) => `claim-${i.toString(16).padStart(32, "0")}`,
        ),
      });
      const first = librarianFixtures(artifacts).researcher(() => "busy");
      await assessPostCoverage({
        artifacts,
        ...one,
        shortlister: new LexicalShortlister(),
        commission: first.commission,
      });
      const two = await analysis(artifacts, "batches-second", "unused", {
        statements: assertions,
        reverse: true,
        claimIds: assertions.map(
          (_, i) => `claim-${(300 - i).toString(16).padStart(32, "0")}`,
        ),
      });
      const second = librarianFixtures(artifacts).researcher(() => "busy");
      await assessPostCoverage({
        artifacts,
        ...two,
        shortlister: new LexicalShortlister(),
        commission: second.commission,
      });
      // One initial request per theme (#891): the effective cap is
      // MAX_CLAIMS_PER_REQUEST, and every other claim is an explicit gap.
      expect(first.requests.map((r) => r.claims.length)).toEqual([
        MAX_CLAIMS_PER_REQUEST,
      ]);
      expect(first.requests[0]!.omittedClaimRecordIds).toHaveLength(
        101 - MAX_CLAIMS_PER_REQUEST,
      );
      expect(
        new Set([
          ...first.requests[0]!.claims.map((c) => c.claimRecordId),
          ...first.requests[0]!.omittedClaimRecordIds!,
        ]).size,
      ).toBe(101);
      expect(second.requests).toEqual(first.requests);
      expect(second.requests.map(researchJobId)).toEqual(
        first.requests.map(researchJobId),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it(
  "validates actual staged research through coverage and writer archives while retaining semantic scope in discovery and support",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-staged-canonical-"));
    const artifacts = new GitArtifactStore({
      repoPath: dir,
      repository: "content",
    });
    await artifacts.initialise();
    const operations = new OperationStore({ path: join(dir, "state.sqlite") });
    try {
      const {
        discoverStage,
        inventoryStage,
        retrievalIds,
        retrieveOneStage,
        supportStage,
        assembleStage,
      } = await import("../../src/research/staged-research.js");
      let discoveries = 0;
      let supportCalls = 0;
      const discoveryInputs: { user: string }[] = [];
      const findings: { id: string; statement: string }[] = [];
      const deps = {
        artifacts,
        operations,
        owner: "synthetic-staged",
        limits: {
          maxSources: 5,
          maxAttempts: 1,
          timeoutMs: 1000,
          maxSourceChars: 10000,
        },
        sonar: {
          model: "synthetic",
          research: async (input: { user: string }) => {
            discoveries++;
            discoveryInputs.push(input);
            return {
              model: "synthetic",
              report: `# Retained report\n\nIndependent treaty record: ${SHARED}`,
              citations: [SHARED],
            };
          },
        },
        fetcher: {
          fetch: async (url: string) => ({ url, title: "Treaty", text }),
        },
        judge: {
          identity: "synthetic-support-v1",
          judge: async (input: {
            findings: { id: string; statement: string }[];
          }) => {
            supportCalls++;
            findings.push(...input.findings);
            return {
              sourceType: "treaty",
              passages: input.findings.map((f) => ({
                findingId: f.id,
                passage: f.statement.includes("prohibits")
                  ? statements[0]!
                  : statements[1]!,
              })),
            };
          },
        },
      };
      const item = await analysis(
        artifacts,
        "staged-first",
        `claim-${"d".repeat(32)}`,
        {
          qualifier: "allegedly",
          quotedBy: "Synthetic Witness",
        },
      );
      const first = await assessPostCoverage({
        artifacts,
        ...item,
        discoveryAcceptance: operations,
        shortlister: new LexicalShortlister(),
        commission: async (request) => {
          const discovery = await discoverStage(deps, request);
          if (discovery.kind !== "discovered")
            throw new Error("synthetic staged discovery failed");
          const inventory = await inventoryStage(deps, discovery.discovery);
          for (const id of await retrievalIds(deps, inventory)) {
            await retrieveOneStage(deps, inventory, id);
            await supportStage(deps, discovery.discovery, inventory, id);
          }
          return assembleStage(deps, discovery.discovery, inventory);
        },
      });
      expect(
        first.record.claims.every((c) => c.status === "evidence-found"),
      ).toBe(true);
      expect(discoveries).toBe(1);
      expect(supportCalls).toBe(1);
      expect(discoveryInputs[0]!.user).toContain('"kind":"quotation"');
      expect(discoveryInputs[0]!.user).toContain('"qualifiers":["allegedly"]');
      expect(discoveryInputs[0]!.user).toContain(
        '"attribution":{"name":"Synthetic Witness"}',
      );
      expect(
        findings
          .map((f) => JSON.parse(f.statement))
          .every(
            (p) =>
              p.kind === "quotation" &&
              p.attribution.name === "Synthetic Witness",
          ),
      ).toBe(true);
      expect(
        findings
          .map((f) => JSON.parse(f.statement))
          .some((p) => p.qualifiers.includes("allegedly")),
      ).toBe(true);
      const laterId = `claim-${"e".repeat(32)}`;
      const later = await analysis(artifacts, "staged-later", laterId, {
        qualifier: "allegedly",
        quotedBy: "Synthetic Witness",
        reverse: true,
      });
      const reused = await assessPostCoverage({
        artifacts,
        ...later,
        discoveryAcceptance: operations,
        shortlister: new LexicalShortlister(),
        commission: async () => {
          throw new Error("staged cache hit must not commission");
        },
      });
      expect(
        reused.record.claims.every(
          (c) => c.reused && c.status === "evidence-found",
        ),
      ).toBe(true);
      const pkg = await saveWriterPackage({
        content: artifacts,
        coverage: reused.ref,
      });
      const savedManifest = JSON.parse(
        await artifacts.read({
          repository: first.record.jobs[0]!.manifest!.repository,
          commit: first.record.jobs[0]!.manifest!.commit,
          path: first.record.jobs[0]!.manifest!.path,
          sha256: first.record.jobs[0]!.manifest!.hash.slice(7),
        }),
      );
      expect(savedManifest.report.path).toMatch(/\/assembled\/report\.md$/);
      expect(
        pkg.package.claims.find((c) => c.claimRecordId === laterId)!
          .evidence[0]!.archived,
      ).toEqual(savedManifest.citations[0].archivedArtifact);
      const refused = await analysis(
        artifacts,
        "staged-refused",
        `claim-${"f".repeat(32)}`,
        {
          qualifier: "allegedly",
          quotedBy: "Synthetic Witness",
        },
      );
      await expect(
        assessPostCoverage({
          artifacts,
          ...refused,
          discoveryAcceptance: { researchDiscoveryAccepted: () => false },
          shortlister: new LexicalShortlister(),
          commission: async () => {
            throw new Error("must not recall quarantined discovery");
          },
        }),
      ).rejects.toMatchObject({ code: "quarantined" });
      expect(discoveries).toBe(1);
      expect(supportCalls).toBe(1);
    } finally {
      operations.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it(
  "replays a version-3 plan with its original request format, so the job ID reconnects (#828 review)",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-v3-replay-"));
    try {
      const artifacts = new GitArtifactStore({
        repoPath: dir,
        repository: "content",
      });
      await artifacts.initialise();
      const planPath = async (
        postId: string,
        a: {
          themeResult: {
            repository: string;
            commit: string;
            path: string;
            sha256: string;
          };
          claimResult: {
            repository: string;
            commit: string;
            path: string;
            sha256: string;
          };
        },
      ) => {
        const ref = (r: typeof a.themeResult) => ({
          repository: r.repository,
          commit: r.commit,
          path: r.path,
          hash: `sha256:${r.sha256}`,
        });
        const key = createHash("sha256")
          .update(JSON.stringify([ref(a.themeResult), ref(a.claimResult)]))
          .digest("hex")
          .slice(0, 32);
        return `librarian/request-plans/pub/${postId}/${key}.json`;
      };
      // A new plan uses the theme-only execution format (version 4).
      const fresh = await analysis(
        artifacts,
        "fresh",
        `claim-${"7".repeat(32)}`,
      );
      const freshRequests: ResearchRequest[] = [];
      await assessPostCoverage({
        artifacts,
        ...fresh,
        shortlister: new LexicalShortlister(),
        commission: async (request) => {
          freshRequests.push(request);
          return { jobId: researchJobId(request), status: "busy" };
        },
      });
      const freshPlan = JSON.parse(
        await artifacts.read(
          (await artifacts.lookup(await planPath("fresh", fresh)))!,
        ),
      );
      expect(freshPlan.schemaVersion).toBe(4);
      expect(freshRequests[0]!.origin).toBe("theme");
      expect(freshRequests[0]!.post).toBeUndefined();

      // A version-3 plan saved by the earlier implementation keeps its request format.
      const old = await analysis(artifacts, "old", `claim-${"8".repeat(32)}`);
      await artifacts.write(
        await planPath("old", old),
        JSON.stringify({ ...freshPlan, schemaVersion: 3 }),
      );
      const oldRequests: ResearchRequest[] = [];
      await assessPostCoverage({
        artifacts,
        ...old,
        shortlister: new LexicalShortlister(),
        commission: async (request) => {
          oldRequests.push(request);
          return { jobId: researchJobId(request), status: "busy" };
        },
      });
      expect(oldRequests).toHaveLength(1);
      expect(oldRequests[0]!.origin).toBe("extraction");
      expect(oldRequests[0]!.post).toBeDefined();
      expect(oldRequests[0]!.canonicalNeeds).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
