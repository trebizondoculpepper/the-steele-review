import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ExtractionModelProvider, ExtractionPrompt } from "../analysis/extraction.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { writeOnce } from "../research/job.js";
import { draftFromPackage, PackageDraftMetadataSchema } from "./package-draft.js";
import { loadPinnedContext } from "./pinned-context.js";
import { DEFAULT_MAX_REVISIONS } from "./revision-policy.js";
import { WriterPackageSchema, type WriterPackage } from "./writer-package.js";
import {
  savePublicationPayload,
  sameArtifact,
  artifactReference,
  publicationManifestHash,
  type PublicationPayload,
} from "./publication-payload.js";
import { ArtifactReferenceSchema, type ArtifactReference } from "../content/artifact-reference.js";
import { promptIdentity } from "./prompt-identity.js";
import { rethrowCreditExhausted } from "../observability/provider-condition.js";

/**
 * Verify a package draft against its exact evidence package (#150).
 *
 * An independent verifier stage (its own prompt) reads the exact saved draft,
 * the exact package it was written from and the same pinned source and
 * themes (#164). Deterministic checks run first: every cited source must be
 * evidence or background the package holds, every claim heading must be a
 * package claim, and every gap claim must stay unresolved. The model then
 * checks attribution, quotations, citation support, overstatement, gaps and
 * historical/wider context, classifying each problem as substantive or minor.
 *
 * The report is saved write-once and bound to the draft's exact content hash:
 * approval applies to that text only, and any edit needs verification again.
 * `verifyWithRevisions` redrafts with the verifier's feedback up to the
 * existing revision limit (two by default) and then saves an honest
 * `unresolved` result rather than overriding the verifier.
 */

export const VERIFICATION_REPORT_SCHEMA_VERSION = 2;

export const DEFAULT_PACKAGE_VERIFY_PROMPT: ExtractionPrompt = {
  version: "package-verifier-v3",
  instructions: readFileSync(
    new URL("../prompts/verifier/package-verifier.md", import.meta.url),
    "utf8",
  ).trim(),
};

const Ref = z
  .object({ repository: z.string(), commit: z.string(), path: z.string(), hash: z.string() })
  .strict();
const Issue = z
  .object({
    passage: z.string().min(1).max(2000),
    reason: z.string().min(1).max(2000),
    severity: z.enum(["substantive", "minor"]),
  })
  .strict();
export type VerificationIssue = z.infer<typeof Issue>;

const ModelVerdictSchema = z
  .object({ verdict: z.enum(["approved", "redraft"]), issues: z.array(Issue).max(50) })
  .strict();

const LegacyPackageVerificationReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    outcome: z.enum(["approved", "redraft"]),
    /** Exact draft verified; approval is valid only for this content hash. */
    draft: Ref,
    package: Ref,
    source: Ref,
    themes: Ref,
    issues: z.array(Issue),
    checks: z.array(z.string()),
    verifierModel: z.string(),
    promptVersion: z.string(),
    verifiedAt: z.string(),
  })
  .strict();
export const PackageVerificationReportSchema = z.discriminatedUnion("schemaVersion", [
  LegacyPackageVerificationReportSchema,
  LegacyPackageVerificationReportSchema.extend({
    schemaVersion: z.literal(VERIFICATION_REPORT_SCHEMA_VERSION),
    publication: ArtifactReferenceSchema,
  }).strict(),
]);
export type PackageVerificationReport = z.infer<typeof PackageVerificationReportSchema>;

const toRef = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});
const toArtifactRef = (r: z.infer<typeof Ref>): ArtifactRef => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  sha256: r.hash.replace(/^sha256:/, ""),
});
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Deterministic checks of the rendered draft against the package; returns substantive issues. */
export function deterministicIssues(pkg: WriterPackage, markdown: string): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const known = new Set<string>([
    ...pkg.claims.flatMap((c) => c.evidence.map((e) => e.url)),
    ...(pkg.context?.background.passages ?? []).map((p) => p.url),
  ]);
  const sources = markdown.split(/^## Sources\s*$/m)[1] ?? "";
  for (const m of sources.matchAll(/^\d+\.\s+(\S+?)(?= \(archived |: ")/gm)) {
    if (!known.has(m[1])) {
      issues.push({
        passage: m[0].trim(),
        reason: "cites a source that is not in the evidence package",
        severity: "substantive",
      });
    }
  }
  const byId = new Map(pkg.claims.map((claim) => [claim.claimRecordId, claim]));
  for (const marker of markdown.matchAll(/^<!-- claim-verdict ([a-f0-9]+) ([a-z]+) -->$/gm)) {
    const claim = byId.get(Buffer.from(marker[1], "hex").toString("utf8"));
    if (!claim || !["supported", "contradicted", "unsupported", "unresolved"].includes(marker[2])) {
      issues.push({
        passage: marker[0],
        reason: "responds to a claim that is not in the package or declares an invalid verdict",
        severity: "substantive",
      });
    } else if (claim.status === "gap" && marker[2] !== "unresolved") {
      issues.push({
        passage: claim.statement,
        reason: "treats a claim with no evidence as settled",
        severity: "substantive",
      });
    }
  }
  // Legacy renderer placed the statement and verdict in the visible prose.
  const claims = new Map(pkg.claims.map((c) => [c.statement, c]));
  for (const m of markdown.matchAll(/^### "(.+)"\s*\n\s*\n\*\*([^*]+)\.\*\*/gm)) {
    const claim = claims.get(m[1]);
    if (!claim) {
      issues.push({
        passage: m[0].split("\n")[0],
        reason: "responds to a claim that is not in the package",
        severity: "substantive",
      });
    } else if (claim.status === "gap" && m[2] !== "Unresolved") {
      issues.push({
        passage: m[0].split("\n")[0],
        reason: "treats a claim with no evidence as settled",
        severity: "substantive",
      });
    }
  }
  return issues;
}

/** True when the report approves exactly this draft text. */
export function approvalValidFor(
  report: PackageVerificationReport,
  markdown: string,
  publication?: { ref: ArtifactReference; payload: PublicationPayload },
): boolean {
  if (report.outcome !== "approved" || report.draft.hash !== `sha256:${sha256(markdown)}`)
    return false;
  // A legacy report approves its body only, never metadata attached afterwards.
  if (report.schemaVersion === 1) return publication === undefined;
  return (
    publication !== undefined &&
    sameArtifact(report.publication, publication.ref) &&
    sameArtifact(report.draft, publication.payload.body) &&
    publicationManifestHash(publication.payload) === publication.ref.hash
  );
}

export type VerifyOutcome =
  | { status: "verified"; report: PackageVerificationReport; ref: ArtifactRef }
  | { status: "context-unavailable"; reason: string }
  | { status: "failed"; reason: "provider-failed" | "malformed-output" };

/** Verify one exact draft against its exact package and pinned context. */
export async function verifyPackageDraft(input: {
  content: GitArtifactStore;
  archive: Pick<GitArtifactStore, "read">;
  /** The draft's metadata (articles/.../<key>.json), which pins draft and package. */
  metadata: ArtifactRef;
  verifier: ExtractionModelProvider;
  prompt?: ExtractionPrompt;
  maxAttempts?: number;
  now?: () => Date;
}): Promise<VerifyOutcome> {
  const prompt = input.prompt ?? DEFAULT_PACKAGE_VERIFY_PROMPT;
  const meta = PackageDraftMetadataSchema.parse(
    JSON.parse(await input.content.read(input.metadata)),
  );
  const draftPath = meta.draft.slice(meta.draft.indexOf(":") + 1);
  const draftRef = await input.content.lookup(draftPath);
  if (!draftRef || `${draftRef.commit}:${draftRef.path}` !== meta.draft) {
    return { status: "context-unavailable", reason: "draft-version-mismatch" };
  }
  const markdown = await input.content.read(draftRef);
  const pkgRef = toArtifactRef(meta.package);
  const pkg = WriterPackageSchema.parse(JSON.parse(await input.content.read(pkgRef)));

  const publication = await savePublicationPayload({
    content: input.content,
    metadata: input.metadata,
    body: draftRef,
    post: pkg.post,
  });

  // Bound to the exact verifier wording, not only its semantic version (#430).
  const promptId = promptIdentity(prompt.version, prompt.instructions);
  const key = sha256(
    JSON.stringify([
      toRef(draftRef),
      artifactReference(publication.ref),
      meta.package,
      input.verifier.modelVersion,
      promptId,
    ]),
  ).slice(0, 32);
  const path = `verifications/${pkg.post.publicationId}/${pkg.post.postId}/${key}.json`;
  const saved = await input.content.lookup(path);
  if (saved) {
    const report = PackageVerificationReportSchema.parse(
      JSON.parse(await input.content.read(saved)),
    );
    if (
      report.schemaVersion !== 2 ||
      !sameArtifact(report.publication, artifactReference(publication.ref)) ||
      !sameArtifact(report.draft, toRef(draftRef)) ||
      !sameArtifact(report.package, meta.package)
    )
      return { status: "context-unavailable", reason: "verification-version-mismatch" };
    return { status: "verified", report, ref: saved };
  }

  const loaded = await loadPinnedContext({
    archive: input.archive,
    content: input.content,
    brief: {
      source: {
        publicationId: pkg.post.publicationId,
        postId: pkg.post.postId,
        url: "https://invalid.example/",
        sourceVersion: pkg.source.sourceVersion,
        artifact: pkg.source.artifact,
        ingestionReason: "backfill",
      },
    },
    themes: toArtifactRef(pkg.themeResult),
  });
  if (loaded.kind !== "loaded") return { status: "context-unavailable", reason: loaded.kind };

  const checks = deterministicIssues(pkg, markdown);
  const user = JSON.stringify({
    draft: markdown,
    publication:
      publication.payload.mode === "structured"
        ? { mode: "structured", ...publication.payload.fields }
        : { mode: "legacy-body-only" },
    post: loaded.context.source.text,
    themes: loaded.context.themes.proposals.map((t) => t.title),
    claims: pkg.claims.map((c) => ({
      statement: c.statement,
      status: c.status,
      // The librarian's outcome and gap reason, so the verifier can check the
      // draft represents e.g. "claimant-only" differently from "research-failed".
      coverage: c.coverage,
      ...(c.reason ? { reason: c.reason } : {}),
      evidence: c.evidence.map((e) => ({ url: e.url, passage: e.passage })),
    })),
    history: pkg.context?.history ?? { status: "gap" },
    background: pkg.context?.background ?? { status: "gap" },
  });
  let verdict: z.infer<typeof ModelVerdictSchema> | undefined;
  let failure: "provider-failed" | "malformed-output" = "malformed-output";
  for (let attempt = 0; attempt < (input.maxAttempts ?? 2) && !verdict; attempt++) {
    let raw: string;
    try {
      raw = await input.verifier.complete(
        { system: prompt.instructions, user, maxOutputChars: 30_000 },
        AbortSignal.timeout(180_000),
      );
    } catch (error) {
      rethrowCreditExhausted(error); // waits for credit; never retried or flattened (#407)
      failure = "provider-failed";
      continue;
    }
    try {
      verdict = ModelVerdictSchema.parse(
        JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)),
      );
    } catch {
      failure = "malformed-output";
    }
  }
  if (!verdict) return { status: "failed", reason: failure };

  const issues = [...checks, ...verdict.issues];
  // Approval needs no substantive problem from either the checks or the model.
  const outcome =
    issues.some((i) => i.severity === "substantive") || verdict.verdict === "redraft"
      ? "redraft"
      : "approved";
  const report = PackageVerificationReportSchema.parse({
    schemaVersion: VERIFICATION_REPORT_SCHEMA_VERSION,
    publication: artifactReference(publication.ref),
    outcome,
    draft: toRef(draftRef),
    package: meta.package,
    source: pkg.source.artifact,
    themes: pkg.themeResult,
    issues,
    checks: ["source-citations", "claim-headings", "gap-claims"],
    verifierModel: input.verifier.modelVersion,
    promptVersion: promptId,
    verifiedAt: (input.now ?? (() => new Date()))().toISOString(),
  });
  const ref = await writeOnce(input.content, path, report);
  return { status: "verified", report, ref };
}

export type RevisionLoopOutcome =
  | {
      outcome: "approved";
      draft: ArtifactRef;
      metadata: ArtifactRef;
      report: ArtifactRef;
      revisions: number;
    }
  | {
      outcome: "unresolved";
      draft: ArtifactRef;
      report: ArtifactRef;
      revisions: number;
      issues: VerificationIssue[];
    }
  | { outcome: "failed"; reason: string; revisions: number };

/**
 * Verify, then redraft with the verifier's substantive feedback, up to the
 * existing revision limit. After that, save an unresolved result.
 */
export async function verifyWithRevisions(input: {
  content: GitArtifactStore;
  archive: GitArtifactStore;
  package: ArtifactRef;
  metadata: ArtifactRef;
  writer: ExtractionModelProvider;
  verifier: ExtractionModelProvider;
  sourceUrl?: string;
  maxRevisions?: number;
  now?: () => Date;
}): Promise<RevisionLoopOutcome> {
  const max = input.maxRevisions ?? DEFAULT_MAX_REVISIONS;
  let metadata = input.metadata;
  for (let revisions = 0; ; revisions++) {
    const verified = await verifyPackageDraft({
      content: input.content,
      archive: input.archive,
      metadata,
      verifier: input.verifier,
      ...(input.now ? { now: input.now } : {}),
    });
    if (verified.status !== "verified")
      return {
        outcome: "failed",
        reason: verified.status === "failed" ? verified.reason : verified.reason,
        revisions,
      };
    const draftRef = toArtifactRef(verified.report.draft);
    if (verified.report.outcome === "approved") {
      return { outcome: "approved", draft: draftRef, metadata, report: verified.ref, revisions };
    }
    const substantive = verified.report.issues.filter((i) => i.severity === "substantive");
    if (revisions >= max) {
      const unresolved = await writeOnce(
        input.content,
        verified.ref.path.replace(/\.json$/, ".unresolved.json"),
        { outcome: "unresolved", revisions, report: toRef(verified.ref), issues: substantive },
      );
      return {
        outcome: "unresolved",
        draft: draftRef,
        report: unresolved,
        revisions,
        issues: substantive,
      };
    }
    // The exact draft the verifier just checked is the article to revise.
    let previousMarkdown: string;
    try {
      previousMarkdown = await input.content.read(draftRef);
    } catch {
      return { outcome: "failed", reason: "draft-unavailable", revisions };
    }
    const redraft = await draftFromPackage({
      content: input.content,
      archive: input.archive,
      package: input.package,
      provider: input.writer,
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      previousDraft: { ref: draftRef, markdown: previousMarkdown },
      revision: {
        number: revisions + 1,
        feedback: substantive.map((i) => ({ passage: i.passage, reason: i.reason })),
      },
      ...(input.now ? { now: input.now } : {}),
    });
    if (redraft.status !== "drafted") {
      return {
        outcome: "failed",
        reason: redraft.status === "failed" ? redraft.reason : redraft.status,
        revisions,
      };
    }
    metadata = redraft.metadata;
  }
}
