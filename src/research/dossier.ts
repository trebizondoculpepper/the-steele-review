import { z } from "zod";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";

/**
 * Versioned theme dossiers (#146): readable Markdown with validated
 * structured metadata, stored at `dossier/<theme-id>.md` in the private
 * content repository and revised only through the artifact controller's
 * expected-prior-version operation.
 *
 * File format: a JSON metadata block between `---json` and `---` lines,
 * then the Markdown body. Metadata records theme identity and scope,
 * per-claim coverage (covered with citations, or a gap with a reason), the
 * cited sources with source and checked-at dates, and open gaps.
 */

export const DOSSIER_SCHEMA_VERSION = 1;

const ThemeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/, "theme ID must be a lower-case slug");
const IsoDate = z.iso.datetime({ offset: true }).or(z.iso.date());

export const DossierCitationSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    url: z.url({ protocol: /^https$/ }),
    title: z.string().min(1).max(500),
    passage: z.string().min(1).max(4000),
    sourceDate: IsoDate.optional(),
    checkedAt: IsoDate,
  })
  .strict();

export const ClaimCoverageSchema = z.discriminatedUnion("status", [
  z
    .object({
      claimId: z.string().min(1).max(200),
      status: z.literal("covered"),
      citations: z.array(z.string()).min(1).max(50),
    })
    .strict(),
  z
    .object({
      claimId: z.string().min(1).max(200),
      status: z.literal("gap"),
      reason: z.string().min(1).max(1000),
    })
    .strict(),
]);

export const DossierMetadataSchema = z
  .object({
    schemaVersion: z.literal(DOSSIER_SCHEMA_VERSION),
    themeId: ThemeId,
    title: z.string().min(1).max(200),
    scope: z.string().min(1).max(2000),
    claims: z.array(ClaimCoverageSchema).max(1000),
    citations: z.array(DossierCitationSchema).max(1000),
    gaps: z.array(z.string().min(1).max(1000)).max(200),
    updatedAt: IsoDate,
  })
  .strict()
  .superRefine((m, ctx) => {
    const ids = new Set<string>();
    for (const c of m.citations) {
      if (ids.has(c.id)) ctx.addIssue({ code: "custom", message: `duplicate citation ${c.id}` });
      ids.add(c.id);
    }
    const claims = new Set<string>();
    for (const c of m.claims) {
      if (claims.has(c.claimId)) {
        ctx.addIssue({ code: "custom", message: `duplicate claim ${c.claimId}` });
      }
      claims.add(c.claimId);
      if (c.status === "covered") {
        for (const id of c.citations) {
          if (!ids.has(id)) ctx.addIssue({ code: "custom", message: `unknown citation ${id}` });
        }
      }
    }
  });
export type DossierMetadata = z.infer<typeof DossierMetadataSchema>;

export interface Dossier {
  metadata: DossierMetadata;
  /** Readable Markdown body. */
  body: string;
}

export interface StoredDossier extends Dossier {
  ref: ArtifactRef;
}

export class InvalidDossierError extends Error {
  constructor(reason: string) {
    super(`invalid dossier: ${reason}`);
    this.name = "InvalidDossierError";
  }
}

/** The dossier changed since the caller read it; reload and retry. */
export class StaleDossierError extends Error {
  constructor() {
    super("dossier changed since it was read");
    this.name = "StaleDossierError";
  }
}

export function dossierPath(themeId: string): string {
  return `dossier/${ThemeId.parse(themeId)}.md`;
}

export function renderDossier(dossier: Dossier): string {
  const metadata = DossierMetadataSchema.parse(dossier.metadata);
  const body = dossier.body.trim();
  if (!body) throw new InvalidDossierError("empty body");
  return `---json\n${JSON.stringify(metadata, null, 2)}\n---\n\n${body}\n`;
}

export function parseDossier(text: string): Dossier {
  const match = /^---json\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
  if (!match) throw new InvalidDossierError("missing metadata block");
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    throw new InvalidDossierError("metadata is not JSON");
  }
  const parsed = DossierMetadataSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidDossierError(parsed.error.issues[0]?.message ?? "metadata");
  return { metadata: parsed.data, body: match[2].trim() };
}

export class DossierStore {
  constructor(private readonly artifacts: GitArtifactStore) {}

  /** Current dossier for a theme, or undefined if none exists yet. */
  async current(themeId: string): Promise<StoredDossier | undefined> {
    const ref = await this.artifacts.lookup(dossierPath(themeId));
    return ref ? this.at(ref) : undefined;
  }

  /** The exact version a reference pins, hash-verified. */
  async at(ref: ArtifactRef): Promise<StoredDossier> {
    return { ...parseDossier(await this.artifacts.read(ref)), ref };
  }

  /**
   * Save a new version. `expected` is the version the caller read (undefined
   * when creating). An unchanged dossier returns the current reference.
   */
  async save(dossier: Dossier, expected: ArtifactRef | undefined): Promise<StoredDossier> {
    const path = dossierPath(dossier.metadata.themeId);
    if (expected && expected.path !== path)
      throw new InvalidDossierError("reference for another theme");
    const content = renderDossier(dossier);
    try {
      const ref = await this.artifacts.revise(path, content, expected?.sha256 ?? null);
      return { ...parseDossier(content), ref };
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.code === "stale-revision") {
        throw new StaleDossierError();
      }
      throw error;
    }
  }
}
