import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore, type ArtifactRef } from "../../src/controllers/artifact-store.js";
import {
  parsePublishRequest,
  verifyApprovedArtifact,
  type PublishRequest,
} from "../../src/publishing/approval.js";

const reference = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

let dir: string;
let artifacts: GitArtifactStore;
let draft: ArtifactRef;
let report: ArtifactRef;
const reportFor = (d: ArtifactRef, verdict = "approve") => ({
  schemaVersion: 1,
  verdict,
  draft: { path: d.path, commit: d.commit, hash: `sha256:${d.sha256}` },
  brief: { path: "briefs/pub/p/b.json", commit: "b".repeat(40), hash: `sha256:${"c".repeat(64)}` },
  issues: [],
  attempt: 1,
  maxAttempts: 3,
  rejectedIssues: 0,
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-approval-"));
  await mkdir(join(dir, "drafts"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "drafts"), repository: "drafts" });
  await artifacts.initialise();
  draft = await artifacts.write(
    "drafts/pub/p/d.md",
    "Original post: https://pub.substack.com/p/p\n\nA synthetic draft.\n",
  );
  report = await artifacts.write(
    "verifications/pub/p/r.json",
    `${JSON.stringify(reportFor(draft))}\n`,
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const event = (over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
  specversion: "1.0",
  id: "evt-verified",
  source: "urn:steele:drafting:verifier",
  type: "org.steele.draft.verified.v1",
  time: "2026-11-01T00:00:00Z",
  subject: "substack/pub/p",
  datacontenttype: "application/json",
  data: {
    publicationId: "pub",
    postId: "p",
    ingestionReason: "live",
    verdict: "approve",
    draft: reference(draft),
    report: reference(report),
    ...data,
  },
  ...over,
});
const request = (): PublishRequest => {
  const r = parsePublishRequest(event(), { destination: "example-destination" });
  if (!r.ok) throw new Error(r.reason);
  return r.request;
};

describe("parsePublishRequest", () => {
  it("turns a valid approval into a publish request keyed by destination, commit and path", () => {
    expect(request()).toMatchObject({
      key: `publish:example-destination:drafts:${draft.commit}:${draft.path}`,
      draft: reference(draft),
      ingestionReason: "live",
      approvalEventId: "evt-verified",
    });
  });

  it("rejects anything but an approval, malformed events and disabled backfill", () => {
    expect(parsePublishRequest(event({}, { verdict: "redraft" }), { destination: "d" })).toEqual({
      ok: false,
      reason: "not-approved",
    });
    expect(parsePublishRequest(event({}, { verdict: "skip" }), { destination: "d" })).toEqual({
      ok: false,
      reason: "not-approved",
    });
    expect(
      parsePublishRequest(event({ subject: "substack/pub/other" }), { destination: "d" }),
    ).toEqual({ ok: false, reason: "malformed-event" });
    expect(parsePublishRequest({}, { destination: "d" })).toEqual({
      ok: false,
      reason: "malformed-event",
    });
    const backfill = event({}, { ingestionReason: "backfill" });
    expect(parsePublishRequest(backfill, { destination: "d" })).toEqual({
      ok: false,
      reason: "backfill-disabled",
    });
    expect(parsePublishRequest(backfill, { destination: "d", allowBackfill: true }).ok).toBe(true);
  });
});

describe("verifyApprovedArtifact", () => {
  it("accepts the exact approved draft", async () => {
    const r = await verifyApprovedArtifact(request(), artifacts);
    expect(r).toMatchObject({ ok: true, markdown: expect.stringContaining("A synthetic draft.") });
  });

  it("rejects tampered content and missing artifacts", async () => {
    const tampered = {
      ...request(),
      draft: { ...request().draft, hash: `sha256:${"0".repeat(64)}` },
    };
    expect(await verifyApprovedArtifact(tampered, artifacts)).toEqual({
      ok: false,
      reason: "tampered-content",
      retryable: false,
    });
    const missing = { ...request(), draft: { ...request().draft, path: "drafts/pub/p/none.md" } };
    expect(await verifyApprovedArtifact(missing, artifacts)).toEqual({
      ok: false,
      reason: "missing-artifact",
      retryable: false,
    });
  });

  it("refuses an approval for a different (earlier) draft", async () => {
    const changed = await artifacts.write(
      "drafts/pub/p/d2.md",
      "Original post: https://pub.substack.com/p/p\n\nA changed draft.\n",
    );
    // The report still approves the earlier draft.
    const stale = { ...request(), draft: reference(changed) };
    expect(await verifyApprovedArtifact(stale, artifacts)).toEqual({
      ok: false,
      reason: "stale-approval",
      retryable: false,
    });
  });

  it("refuses a report that does not approve", async () => {
    const redraft = await artifacts.write(
      "verifications/pub/p/redraft.json",
      `${JSON.stringify(reportFor(draft, "redraft"))}\n`,
    );
    const r = { ...request(), report: reference(redraft) };
    expect(await verifyApprovedArtifact(r, artifacts)).toEqual({
      ok: false,
      reason: "not-approved",
      retryable: false,
    });
  });
});
