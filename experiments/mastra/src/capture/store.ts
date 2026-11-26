import { createClient, type Client } from "@libsql/client";
import { bundleBytes, bundleHash, SourceBundleSchema, sourceVersionId, type SourceBundle } from "./bundle.js";

/**
 * Immutable retained source versions (#920). This narrow typed owner keeps
 * them in a dedicated LibSQL database on persistent storage, independent of
 * Mastra's prunable run history. No other module issues SQL against it.
 *
 * - A version row is never updated or deleted. Capturing identical content
 *   again reuses the existing version (same ID) and records the observation.
 * - Each version stores its canonical bundle bytes, hash, the original post
 *   JSON (signed links removed), the supplied transcript JSON when used,
 *   capture metadata and warnings.
 */

export interface VersionSummary {
  version: string;
  item: string;
  sha256: string;
  capturedAt: string;
  lastObservedAt: string;
  observations: number;
  textSource: string;
  textChars: number;
  warnings: string[];
}

export interface RetainedVersion extends VersionSummary {
  bundle: SourceBundle;
  /** Exact canonical bytes the version ID was computed from. */
  bundleBytes: string;
  rawPost: string | null;
  rawTranscript: string | null;
  captureMeta: Record<string, unknown>;
}

export const EXPORT_SCHEMA = "source-version-export-v1";

export interface VersionExport {
  schema: typeof EXPORT_SCHEMA;
  version: string;
  bundleBytes: string;
  captureMeta: Record<string, unknown>;
  warnings: string[];
  rawPost: string | null;
  rawTranscript: string | null;
}

export class VersionStoreError extends Error {
  readonly code: "not-found" | "hash-mismatch" | "invalid-export";
  constructor(code: VersionStoreError["code"], message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export class VersionStore {
  private readonly url: string;
  private client: Client | undefined;
  private ready: Promise<void> | undefined;

  constructor(url: string) {
    this.url = url;
  }

  private get db(): Client {
    this.client ??= createClient({ url: this.url });
    return this.client;
  }

  private init() {
    this.ready ??= Promise.resolve()
      .then(() =>
        this.db.batch(
          [
            `CREATE TABLE IF NOT EXISTS source_versions (
              version TEXT PRIMARY KEY, item TEXT NOT NULL, sha256 TEXT NOT NULL,
              bundle_bytes TEXT NOT NULL, raw_post TEXT, raw_transcript TEXT,
              capture_meta TEXT NOT NULL, warnings TEXT NOT NULL,
              text_source TEXT NOT NULL, text_chars INTEGER NOT NULL,
              captured_at TEXT NOT NULL, last_observed_at TEXT NOT NULL, observations INTEGER NOT NULL DEFAULT 1)`,
            `CREATE INDEX IF NOT EXISTS source_versions_item ON source_versions (item, captured_at)`,
            // Immutability is enforced by the database, not only by this class.
            `CREATE TRIGGER IF NOT EXISTS source_versions_immutable BEFORE UPDATE OF version, item, sha256, bundle_bytes, raw_post, raw_transcript, capture_meta, warnings, captured_at ON source_versions
              BEGIN SELECT RAISE(ABORT, 'source versions are immutable'); END`,
            `CREATE TRIGGER IF NOT EXISTS source_versions_no_delete BEFORE DELETE ON source_versions
              BEGIN SELECT RAISE(ABORT, 'source versions are immutable'); END`,
          ],
          "write",
        ),
      )
      .then(() => undefined)
      .catch((e) => {
        this.ready = undefined;
        this.client?.close();
        this.client = undefined;
        throw e;
      });
    return this.ready;
  }

  /** Saves a captured bundle; returns the version and whether it is new. */
  async save(
    bundle: SourceBundle,
    extra: { rawPost: string | null; rawTranscript: string | null; warnings: string[]; captureMeta: Record<string, unknown> },
    now: string,
  ): Promise<{ version: string; created: boolean }> {
    await this.init();
    const bytes = bundleBytes(bundle);
    const sha = bundleHash(bundle);
    const version = sourceVersionId(bundle);
    const r = await this.db.execute({
      sql: `INSERT INTO source_versions (version, item, sha256, bundle_bytes, raw_post, raw_transcript, capture_meta, warnings, text_source, text_chars, captured_at, last_observed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(version) DO UPDATE SET last_observed_at = excluded.last_observed_at, observations = observations + 1`,
      args: [version, bundle.item, sha, bytes, extra.rawPost, extra.rawTranscript, JSON.stringify(extra.captureMeta), JSON.stringify(extra.warnings), bundle.textSource, bundle.text.length, now, now],
    });
    const row = (await this.db.execute({ sql: "SELECT observations FROM source_versions WHERE version = ?", args: [version] })).rows[0];
    return { version, created: r.rowsAffected === 1 && Number(row?.observations) === 1 };
  }

  async listItems(limit: number): Promise<{ item: string; latestVersion: string; latestCapturedAt: string; versions: number }[]> {
    await this.init();
    const r = await this.db.execute({
      sql: `SELECT item, COUNT(*) AS versions, MAX(captured_at) AS latest FROM source_versions GROUP BY item ORDER BY latest DESC LIMIT ?`,
      args: [bound(limit, 50)],
    });
    const out = [];
    for (const row of r.rows) {
      const latest = (
        await this.db.execute({ sql: "SELECT version FROM source_versions WHERE item = ? ORDER BY captured_at DESC LIMIT 1", args: [row.item] })
      ).rows[0];
      out.push({ item: String(row.item), latestVersion: String(latest?.version), latestCapturedAt: String(row.latest), versions: Number(row.versions) });
    }
    return out;
  }

  async listVersions(item: string, limit = 50): Promise<VersionSummary[]> {
    await this.init();
    const r = await this.db.execute({
      sql: "SELECT * FROM source_versions WHERE item = ? ORDER BY captured_at DESC LIMIT ?",
      args: [item, bound(limit, 100)],
    });
    return r.rows.map(summary);
  }

  /** Reads one version from storage, never from the source; verifies its hash. */
  async read(version: string): Promise<RetainedVersion> {
    await this.init();
    const row = (await this.db.execute({ sql: "SELECT * FROM source_versions WHERE version = ?", args: [version] })).rows[0];
    if (!row) throw new VersionStoreError("not-found", "no such source version");
    const bytes = String(row.bundle_bytes);
    const bundle = SourceBundleSchema.parse(JSON.parse(bytes));
    if (bundleHash(bundle) !== String(row.sha256) || sourceVersionId(bundle) !== version)
      throw new VersionStoreError("hash-mismatch", "stored bundle does not match its version ID");
    return {
      ...summary(row),
      bundle,
      bundleBytes: bytes,
      rawPost: (row.raw_post as string | null) ?? null,
      rawTranscript: (row.raw_transcript as string | null) ?? null,
      captureMeta: JSON.parse(String(row.capture_meta)),
    };
  }

  async export(version: string): Promise<VersionExport> {
    const v = await this.read(version);
    return {
      schema: EXPORT_SCHEMA,
      version: v.version,
      bundleBytes: v.bundleBytes,
      captureMeta: v.captureMeta,
      warnings: v.warnings,
      rawPost: v.rawPost,
      rawTranscript: v.rawTranscript,
    };
  }

  /** Imports an exported version; rejected unless the recomputed hash matches its ID. */
  async import(exported: unknown, now: string): Promise<{ version: string; created: boolean }> {
    const e = exported as Partial<VersionExport> | null;
    if (!e || e.schema !== EXPORT_SCHEMA || typeof e.bundleBytes !== "string" || typeof e.version !== "string")
      throw new VersionStoreError("invalid-export", "not a source-version-export-v1 document");
    const bundle = SourceBundleSchema.parse(JSON.parse(e.bundleBytes));
    if (bundleBytes(bundle) !== e.bundleBytes || sourceVersionId(bundle) !== e.version)
      throw new VersionStoreError("hash-mismatch", "exported bytes do not reproduce the version ID");
    return this.save(
      bundle,
      {
        rawPost: e.rawPost ?? null,
        rawTranscript: e.rawTranscript ?? null,
        warnings: Array.isArray(e.warnings) ? e.warnings.map(String) : [],
        captureMeta: { ...(e.captureMeta ?? {}), importedAt: now },
      },
      now,
    );
  }

  close() {
    this.client?.close();
    this.client = undefined;
  }
}

function bound(n: number, max: number) {
  return Math.min(Math.max(Math.trunc(n) || 20, 1), max);
}

function summary(row: Record<string, unknown>): VersionSummary {
  return {
    version: String(row.version),
    item: String(row.item),
    sha256: String(row.sha256),
    capturedAt: String(row.captured_at),
    lastObservedAt: String(row.last_observed_at),
    observations: Number(row.observations),
    textSource: String(row.text_source),
    textChars: Number(row.text_chars),
    warnings: JSON.parse(String(row.warnings)),
  };
}
