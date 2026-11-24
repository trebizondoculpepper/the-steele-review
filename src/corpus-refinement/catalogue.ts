import { z } from "zod";

/**
 * The reviewed catalogue of underlying ideas (#852). An underlying idea is an
 * assertion that can recur across objects, technologies or events. Each entry
 * has a stable ID, a definition and sourced examples. The labels describe
 * allegations, not facts.
 *
 * The second mapping reads one exact, pinned version of the catalogue and
 * proposes, per group, to reuse an entry, add a new idea, or flag an uncertain
 * match. Proposals are saved with their rationale; the catalogue itself
 * changes only through review, so a later batch sees only reviewed entries.
 */

const CatalogueId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);

export const UnderlyingCatalogueSchema = z
  .object({
    version: z.string().min(1).max(100),
    entries: z
      .array(
        z
          .object({
            id: CatalogueId,
            definition: z.string().min(1).max(1000),
            examples: z
              .array(
                z
                  .object({
                    text: z.string().min(1).max(1000),
                    /** Where the example comes from: a claim, post or review note. */
                    source: z.string().min(1).max(400),
                  })
                  .strict(),
              )
              .min(1)
              .max(20),
          })
          .strict(),
      )
      .max(500)
      .refine((entries) => new Set(entries.map((e) => e.id)).size === entries.length, {
        message: "duplicate catalogue ID",
      }),
  })
  .strict();
export type UnderlyingCatalogue = z.infer<typeof UnderlyingCatalogueSchema>;

/** Where the reviewed catalogue lives in the experiment repository. */
export const CATALOGUE_PATH = "corpus-refinement/catalogue/underlying-ideas.json";

const SEED = "seed example approved for evaluation (#852)";

/**
 * Seed entries approved for evaluation (#852). Each keeps its mechanism and
 * intent: deliberate concealment is a different idea from incidental harm.
 */
export const SEED_CATALOGUE: UnderlyingCatalogue = {
  version: "seed-2026-11-24",
  entries: [
    {
      id: "hidden-weapons-in-transport-infrastructure",
      definition:
        "Transport infrastructure is alleged to conceal weapons deliberately aimed at the public.",
      examples: [{ text: "Hidden weapons in transport infrastructure.", source: SEED }],
    },
    {
      id: "government-conceals-everyday-object-harms",
      definition:
        "Government is alleged to know that an everyday object causes harm and to hide it.",
      examples: [{ text: "Government concealment of everyday-object harms.", source: SEED }],
    },
    {
      id: "safety-measures-as-pretext-for-monitoring",
      definition:
        "A measure presented as improving safety is alleged to exist really to monitor people.",
      examples: [{ text: "Safety measures as a pretext for monitoring.", source: SEED }],
    },
    {
      id: "evidence-altered-or-deleted",
      definition:
        "Documents or records are alleged to have been altered or deleted to hide evidence.",
      examples: [{ text: "Documents altered or deleted to hide evidence.", source: SEED }],
    },
    {
      id: "transport-infrastructure-causes-illness",
      definition:
        "Transport infrastructure is alleged to cause illness or cognitive harm, without any claim that the harm is intended.",
      examples: [
        {
          text: "Illness or cognitive harm from transport infrastructure without presuming intent.",
          source: SEED,
        },
      ],
    },
    {
      id: "staged-incidents-conceal-covert-operations",
      definition: "Traffic incidents are alleged to be staged to conceal covert operations.",
      examples: [{ text: "Traffic incidents staged to conceal covert operations.", source: SEED }],
    },
  ],
};
