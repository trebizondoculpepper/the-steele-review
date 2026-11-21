import { z } from "zod";

/** Bounded writer-generated copy, distinct from source identity and publisher byline. */
export const FIELD_LIMITS = { title: 140, subtitle: 280, excerpt: 500 } as const;
const field = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\r\n]/.test(value) && !value.startsWith("#"), "must be a single plain line");
export const PublicationFieldsSchema = z
  .object({
    title: field(FIELD_LIMITS.title),
    subtitle: field(FIELD_LIMITS.subtitle),
    excerpt: field(FIELD_LIMITS.excerpt),
  })
  .strict();
export type PublicationFields = z.infer<typeof PublicationFieldsSchema>;
