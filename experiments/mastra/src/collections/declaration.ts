import { z } from "zod";

import { parseSection, type ConfigSection } from "../common/config/index.js";

/**
 * A collection's declaration (#942): `<collection>/collection.json`, committed
 * with the collection. It declares the document mapping and its version. A
 * changed mapping must come with a higher version; the indexer then builds a
 * new backing index and switches the alias once it is complete.
 *
 *   {
 *     "mappingVersion": 1,
 *     "mapping": { "dynamic": "strict", "properties": { "title": { "type": "text" } } }
 *   }
 *
 * The indexer adds a `provenance` object (collection, path, Git revision and
 * blob) to every document and to the mapping, so the declared mapping must
 * not define that field itself. A collection without a valid declaration is
 * reported and left unindexed rather than indexed with a guessed mapping.
 */

export const DECLARATION_FILE = "collection.json";

const PROVENANCE_FIELD = "provenance";

export const ProvenanceMapping = {
  type: "object",
  properties: {
    collection: { type: "keyword" },
    path: { type: "keyword" },
    revision: { type: "keyword" },
    blob: { type: "keyword" },
  },
} as const;

const Declaration = z.strictObject({
  mappingVersion: z.number().int().min(1).max(9999),
  mapping: z.looseObject({
    properties: z
      .record(z.string(), z.unknown())
      .refine((p) => !(PROVENANCE_FIELD in p), "must not define the provenance field, which the indexer adds")
      .optional(),
  }),
});

export interface CollectionDeclaration {
  mappingVersion: number;
  /** The declared mapping with the provenance field added. */
  mapping: Record<string, unknown>;
}

export function parseDeclaration(directory: string, text: string): CollectionDeclaration {
  const section: ConfigSection<z.infer<typeof Declaration>> = { file: `${directory}/${DECLARATION_FILE}`, schema: Declaration };
  const declared = parseSection(section, text);
  return {
    mappingVersion: declared.mappingVersion,
    mapping: {
      ...declared.mapping,
      properties: { ...(declared.mapping.properties ?? {}), [PROVENANCE_FIELD]: ProvenanceMapping },
    },
  };
}
