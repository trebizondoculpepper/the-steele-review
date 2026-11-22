import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vite-plus/test";
import { GitArtifactStore, ArtifactStoreError } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  artifactRef,
  artifactReference,
  savePublicationPayload,
} from "../../src/drafting/publication-payload.js";
import {
  readEditorialContinuation,
  type EditorialContinuationInput,
} from "../../src/drafting/editorial-continuation.js";
import { editorialStages } from "../../src/workflow/editorial-stages.js";
import { editorialAttemptIdentity } from "../../src/workflow/editorial-attempt-identity.js";
import { recordArticleAttempt } from "../../src/workflow/article-attempt.js";
import { ArticleRunInputSchema } from "../../src/workflow/article-run.js";
import { PackageVerificationReportSchema } from "../../src/drafting/package-verify.js";
import { draftFromPackage } from "../../src/drafting/package-draft.js";
import { saveSourceContext, sourceContextFor } from "../../src/content/source-context.js";
import { parseSourceMetadata, postAttribution } from "../../src/content/source-metadata.js";
import {
  approvedReport,
  archive as fixtureArchive,
  WRITER,
} from "../publishing/approval-fixtures.js";
let dir: string, content: GitArtifactStore, operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-continuation-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});
const REVISE =
  "## Reasons\nA synthetic material scope correction remains.\n## Required corrections\nNarrow the claim to the supplied source.\n## Accepted minor observations\nKeep the supported tone.\nDECISION: REVISE";
async function seed(
  modern = false,
  historicalInputOrder = false,
  metadataOnlyBase = false,
  revisionCount = 0,
) {
  const report = PackageVerificationReportSchema.parse(
    JSON.parse(await content.read(await approvedReport(content))),
  );
  if (report.schemaVersion !== 2) throw new Error("fixture report");
  let pkgRef = artifactRef(report.package),
    draft = artifactRef(report.draft);
  const pkg = JSON.parse(await content.read(pkgRef));
  const sourceMetadata = modern
    ? parseSourceMetadata([
        {
          sourceId: "pub",
          sourceType: "substack",
          displayName: "Synthetic Publication",
          defaultAuthor: "Configured Person",
        },
      ])
    : undefined;
  const capture = JSON.parse(await fixtureArchive.read(artifactRef(pkg.source.artifact)));
  const archive = {
    read: async (r: Parameters<GitArtifactStore["read"]>[0]) => {
      expect(artifactReference(r)).toEqual(pkg.source.artifact);
      return JSON.stringify(capture);
    },
    lookup: async (path: string) =>
      path === pkg.source.artifact.path ? artifactRef(pkg.source.artifact) : undefined,
  };
  if (modern) {
    const context = await saveSourceContext(
      content,
      sourceContextFor(
        capture,
        artifactRef(pkg.source.artifact),
        postAttribution(sourceMetadata, capture.item),
      ),
    );
    pkg.source.context = artifactReference(context);
    pkgRef = await content.write(
      "writer-packages/synthetic-modern-context.json",
      JSON.stringify(pkg),
    );
    const generated = await draftFromPackage({
      operations,
      content,
      archive,
      package: pkgRef,
      sourceUrl: capture.item.url,
      provider: { modelVersion: "fake/fixture-writer", complete: async () => WRITER },
    });
    if (generated.status !== "drafted") throw new Error(generated.status);
    draft = generated.draft;
  }
  const stages = editorialStages({
    content,
    operations,
    archive,
    assessor: {
      modelVersion: "fake/assessor",
      complete: async () => "No faults found.\nEND OF ASSESSMENT",
    },
    judge: { modelVersion: "fake/judge", complete: async () => REVISE },
    writer: {
      modelVersion: "fake/writer-unused",
      complete: async () => {
        throw new Error("reader has no writer capability");
      },
    },
  });
  let version = await stages.prepare(draft, pkgRef);
  if (metadataOnlyBase) {
    const meta = JSON.parse(await content.read(version.metadata));
    const next = await content.revise(
      version.metadata.path,
      JSON.stringify({
        ...meta,
        fields: { ...meta.fields, title: "A valid metadata-only version" },
      }),
      version.metadata.sha256,
    );
    version = { draft: { ...version.draft, commit: next.commit }, metadata: next };
  }
  const input = ArticleRunInputSchema.parse({
    publicationId: "pub",
    postId: "p1",
    sourceVersion: pkg.source.sourceVersion,
    sourceUrl: capture.item.url,
    researchDeadlineMs: 30_000,
    editorial: { version: "assess-judge-v1", maxRevisions: revisionCount, deadlineMs: 30_000 },
    operatorRequestId: "synthetic-parent",
  });
  const savedInput = historicalInputOrder
    ? (Object.fromEntries(Object.entries(input).reverse()) as typeof input)
    : input;
  const identity = historicalInputOrder
    ? operations.recordArticleAttempt({
        publicationId: input.publicationId,
        postId: input.postId,
        sourceVersion: input.sourceVersion,
        requestId: input.operatorRequestId!,
        inputHash: createHash("sha256").update(JSON.stringify(savedInput)).digest("hex"),
      })
    : recordArticleAttempt(operations, input, input.operatorRequestId!).identity;
  const attempt = editorialAttemptIdentity(input).attemptId;
  const initial = version;
  const assessments = [],
    judgments = [],
    revisions: (typeof version)[] = [];
  const history: EditorialContinuationInput["history"] = [];
  for (let round = 0; round <= revisionCount; round++) {
    const assessment = await stages.assess(version, pkgRef, `${attempt}:assessment:${round}`);
    const judgment = await stages.judge(assessment.ref, `${attempt}:judgment:${round}`, undefined, [
      ...history,
    ]);
    assessments.push(assessment.ref);
    judgments.push(judgment.ref);
    history.push({
      judgment: artifactReference(judgment.ref),
      assessment: artifactReference(assessment.ref),
      body: artifactReference(version.draft),
      metadata: artifactReference(version.metadata),
    });
    if (round < revisionCount) {
      const meta = JSON.parse(await content.read(version.metadata));
      const next = await content.revise(
        version.metadata.path,
        JSON.stringify({
          ...meta,
          fields: { ...meta.fields, title: `Synthetic linked version ${round + 1}` },
        }),
        version.metadata.sha256,
      );
      version = { draft: { ...version.draft, commit: next.commit }, metadata: next };
      revisions.push(version);
    }
  }
  const assessment = { ref: assessments.at(-1)! },
    judgment = { ref: judgments.at(-1)! };
  const decision = JSON.parse(await content.read(judgment.ref));
  let summary = {
    version: "assess-judge-v1",
    initial,
    assessments,
    judgments,
    revisions,
    mechanicalRuns: [],
    diagnostics: [],
    terminal: "unresolved",
    input: savedInput,
  };
  const saveSummary = async () => {
    const key = createHash("sha256").update(JSON.stringify(summary)).digest("hex");
    return content.write(`editorial-loops/pub/p1/${key}.json`, JSON.stringify(summary));
  };
  const summaryRef = await saveSummary();
  const request: EditorialContinuationInput = {
    version: "editorial-continuation-v1",
    parent: { workflowKey: identity.workflowKey, summary: artifactReference(summaryRef) },
    package: artifactReference(pkgRef),
    body: artifactReference(version.draft),
    metadata: artifactReference(version.metadata),
    publication: decision.publication,
    assessment: artifactReference(assessment.ref),
    judgment: artifactReference(judgment.ref),
    history,
  };
  const read = (overrides: Partial<Parameters<typeof readEditorialContinuation>[0]> = {}) =>
    readEditorialContinuation({
      request,
      content,
      archive,
      operations,
      sourceMetadata,
      ...overrides,
    });
  const changeSummary = async (edit: (s: any) => void) => {
    summary = structuredClone(summary);
    edit(summary);
    request.parent.summary = artifactReference(await saveSummary());
  };
  const changeJudgment = async (edit: (j: any) => void) => {
    const next = structuredClone(decision);
    edit(next);
    const ref = await content.write(
      `judgments/pub/p1/synthetic-${createHash("sha256").update(JSON.stringify(next)).digest("hex")}.json`,
      JSON.stringify(next),
    );
    request.judgment = artifactReference(ref);
    request.history[0]!.judgment = artifactReference(ref);
    await changeSummary((s) => {
      s.judgments[0] = ref;
    });
  };
  return {
    read,
    request,
    version,
    archive,
    pkg,
    pkgRef,
    sourceMetadata,
    summary,
    changeSummary,
    changeJudgment,
  };
}
describe("read-only exact editorial continuation seed", { timeout: 60_000 }, () => {
  it("validates a complete chain without writing or supplying a paid capability", async () => {
    const f = await seed(true);
    const write = vi.spyOn(content, "write"),
      revise = vi.spyOn(content, "revise"),
      record = vi.spyOn(operations, "recordArticleAttempt");
    const out = await f.read();
    expect(out.initial).toEqual(f.version);
    expect(out.history).toEqual(f.request.history);
    expect(out.priorCounts).toEqual({ assessments: 1, judgments: 1, revisions: 0 });
    // This is artifact validation, not proof that the Restate parent finished.
    expect(out.parentCompletionRequired).toEqual(f.request.parent);
    expect(write).not.toHaveBeenCalled();
    expect(revise).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
  it("matches the original serialized parent input without reordering it through a newer schema", async () => {
    const f = await seed(false, true);
    expect((await f.read()).initial).toEqual(f.version);
  });
  it("accepts unchanged body bytes pinned at a valid metadata-only pair commit", async () => {
    const f = await seed(false, false, true);
    expect((await f.read()).initial).toEqual(f.version);
  });
  it.each(["context", "publication"])(
    "propagates a nested %s storage failure and permits the same read on retry",
    async (target) => {
      const f = await seed();
      const path = target === "context" ? f.pkg.themeResult.path : f.request.publication.path;
      const read = content.read.bind(content);
      let failed = false;
      vi.spyOn(content, "read").mockImplementation(async (ref) => {
        if (!failed && ref.path === path) {
          failed = true;
          throw new ArtifactStoreError("git-failed");
        }
        return read(ref);
      });
      await expect(f.read()).rejects.toMatchObject({ code: "git-failed" });
      expect((await f.read()).initial).toEqual(f.version);
    },
  );
  it("validates all three linked reviewed versions while retaining prior counts", async () => {
    const f = await seed(false, false, false, 2);
    const out = await f.read();
    expect(out.history).toHaveLength(3);
    expect(out.priorCounts).toEqual({ assessments: 3, judgments: 3, revisions: 2 });
    const changed = structuredClone(f.request);
    changed.history[0]!.metadata.repository = "different-corpus";
    await expect(f.read({ request: changed })).rejects.toMatchObject({ code: "history-mismatch" });
  });
  it("accepts a direct original-body reference with newer valid metadata, but refuses later edit/revert", async () => {
    const f = await seed();
    const originalBody = f.request.body;
    const metadata = JSON.parse(await content.read(artifactRef(f.request.metadata)));
    metadata.draft = `${originalBody.commit}:${originalBody.path}`;
    metadata.fields.title = "An independently reviewed metadata-only title";
    const next = await content.revise(
      f.request.metadata.path,
      JSON.stringify(metadata),
      f.request.metadata.hash.slice(7),
    );
    const publication = await savePublicationPayload({
      content,
      metadata: next,
      body: artifactRef(originalBody),
      post: { publicationId: "pub", postId: "p1" },
    });
    const assessment = JSON.parse(await content.read(artifactRef(f.request.assessment)));
    assessment.publication = artifactReference(publication.ref);
    const ar = await content.write(
      "assessments/pub/p1/synthetic-direct-body.json",
      JSON.stringify(assessment),
    );
    const judgment = JSON.parse(await content.read(artifactRef(f.request.judgment)));
    judgment.publication = artifactReference(publication.ref);
    judgment.assessment = artifactReference(ar);
    const jr = await content.write(
      "judgments/pub/p1/synthetic-direct-body.json",
      JSON.stringify(judgment),
    );
    f.request.metadata = artifactReference(next);
    f.request.publication = artifactReference(publication.ref);
    f.request.assessment = artifactReference(ar);
    f.request.judgment = artifactReference(jr);
    f.request.history[0] = {
      judgment: artifactReference(jr),
      assessment: artifactReference(ar),
      body: originalBody,
      metadata: artifactReference(next),
    };
    await f.changeSummary((s) => {
      s.initial.metadata = next;
      s.assessments[0] = ar;
      s.judgments[0] = jr;
    });
    expect((await f.read()).initial).toEqual({ draft: artifactRef(originalBody), metadata: next });
    const text = await content.read(artifactRef(originalBody));
    const edited = await content.revise(
      originalBody.path,
      `${text}\nLater edit.`,
      originalBody.hash.slice(7),
    );
    await content.revise(originalBody.path, text, edited.sha256);
    await expect(f.read()).rejects.toMatchObject({ code: "stale-base" });
  });
  it.each(["body", "metadata", "package", "publication"] as const)(
    "refuses a mismatched %s reference",
    async (field) => {
      const f = await seed();
      f.request[field] = { ...f.request[field], hash: `sha256:${"f".repeat(64)}` };
      await expect(f.read()).rejects.toThrow(/editorial continuation:/);
    },
  );
  it("refuses a repository mismatch even when path, commit and hash are unchanged", async () => {
    const f = await seed();
    f.request.package = { ...f.request.package, repository: "different-corpus" };
    await expect(f.read()).rejects.toMatchObject({ code: "unreadable" });
  });
  it.each(["body", "metadata"] as const)(
    "refuses a stale canonical %s base before any revision",
    async (part) => {
      const f = await seed();
      const r = f.request[part];
      const value = await content.read(artifactRef(r));
      const next =
        part === "body"
          ? `${value}\nA later edit.\n`
          : JSON.stringify({
              ...JSON.parse(value),
              fields: { ...JSON.parse(value).fields, title: "A later title" },
            });
      await content.revise(r.path, next, r.hash.slice(7));
      await expect(f.read()).rejects.toMatchObject({ code: "stale-base" });
    },
  );
  it("refuses changed current source configuration or capture", async () => {
    const f = await seed(true);
    const changed = parseSourceMetadata([
      {
        sourceId: "pub",
        sourceType: "substack",
        displayName: "Synthetic Publication",
        defaultAuthor: "Different Person",
      },
    ]);
    await expect(f.read({ sourceMetadata: changed })).rejects.toMatchObject({
      code: "source-mismatch",
    });
    await expect(
      f.read({
        archive: {
          ...f.archive,
          lookup: async () => ({ ...artifactRef(f.pkg.source.artifact), commit: "f".repeat(40) }),
        },
      }),
    ).rejects.toMatchObject({ code: "source-mismatch" });
  });
  it.each(["approved", "operational-stop", "deadline"])(
    "refuses a non-resumable %s parent summary",
    async (terminal) => {
      const f = await seed();
      await f.changeSummary((s) => {
        s.terminal = terminal;
      });
      await expect(f.read()).rejects.toMatchObject({ code: "parent-not-resumable" });
    },
  );
  it("refuses an unfinished summary or wrong recorded parent intent", async () => {
    const f = await seed();
    await f.changeSummary((s) => {
      s.input.editorial.maxRevisions = 2;
    });
    await expect(f.read()).rejects.toMatchObject({ code: "parent-not-resumable" });
    const other = await seed();
    other.request.parent.workflowKey += "-other";
    await expect(other.read()).rejects.toMatchObject({ code: "parent-mismatch" });
  });
  it.each(["approve", "none"])("refuses a non-REVISE %s judgment", async (decision) => {
    const f = await seed();
    await f.changeJudgment((j) => {
      j.decision = decision;
    });
    await expect(f.read()).rejects.toMatchObject({ code: "judgment-invalid" });
  });
  it("refuses missing/hash-invalid or incomplete judgment documents", async () => {
    const f = await seed();
    await f.changeJudgment((j) => {
      j.document.hash = `sha256:${"f".repeat(64)}`;
    });
    await expect(f.read()).rejects.toMatchObject({ code: "unreadable" });
    const other = await seed();
    const doc = await content.write("judgments/pub/p1/incomplete.md", "## Reasons\nCut off.");
    await other.changeJudgment((j) => {
      j.document = artifactReference(doc);
    });
    await expect(other.read()).rejects.toMatchObject({ code: "judgment-invalid" });
  });
  it("refuses unlinked/duplicate history and propagates operational Git failures", async () => {
    const f = await seed();
    await expect(f.read({ request: { ...f.request, history: [] } })).rejects.toMatchObject({
      code: "history-mismatch",
    });
    await expect(
      f.read({ request: { ...f.request, history: [f.request.history[0], f.request.history[0]] } }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    const read = content.read.bind(content);
    vi.spyOn(content, "read")
      .mockImplementationOnce(async () => {
        throw new ArtifactStoreError("git-failed");
      })
      .mockImplementation(read);
    await expect(f.read()).rejects.toMatchObject({ code: "git-failed" });
    expect((await f.read()).initial).toEqual(f.version);
  });
});
