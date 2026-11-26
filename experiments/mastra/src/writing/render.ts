import { z } from "zod";

/** The contract's article output (experiments/shared/schemas/article-v1.schema.json). */
export const ArticleSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    subtitle: z.string().trim().max(200).optional(),
    summary: z.string().trim().min(1).max(2500),
    critique: z
      .array(
        z
          .object({
            point: z.string().trim().min(1).max(600),
            category: z.enum(["asserted", "established", "not-checked"]),
            why_it_matters: z.string().trim().min(1).max(600),
          })
          .strict(),
      )
      .min(3)
      .max(8),
    conclusion: z.string().trim().min(1).max(1200),
    warnings: z.array(z.string().trim().max(300)).max(10),
  })
  .strict();
export type Article = z.infer<typeof ArticleSchema>;

const LABEL: Record<Article["critique"][number]["category"], string> = {
  asserted: "Asserted by the author",
  established: "Widely established",
  "not-checked": "Not checked",
};

/**
 * Model text fields are prose. Anything the draft service's converter would
 * reject (raw HTML, images, code, tables, quotes, extra headings, rules or
 * non-https links) is refused before the article is saved.
 */
export function unsupportedMarkdown(a: Article): string | null {
  const fields = [a.title, a.subtitle ?? "", a.summary, a.conclusion, ...a.warnings, ...a.critique.flatMap((c) => [c.point, c.why_it_matters])];
  for (const f of fields) {
    if (/<\/?[a-zA-Z][^>]*>/.test(f)) return "html";
    if (/!\[/.test(f)) return "image";
    if (/```|`/.test(f)) return "code";
    if (/\]\((?!https:\/\/)/.test(f)) return "non-https-link";
    for (const line of f.split("\n")) {
      const t = line.trimStart();
      if (/^#{1,6}\s/.test(t)) return "heading";
      if (t.startsWith(">")) return "blockquote";
      if (t.startsWith("|")) return "table";
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(t)) return "rule";
    }
  }
  return null;
}

/** Deterministic Markdown per the contract's rendering rules. */
export function renderArticle(article: Article): string {
  const a = ArticleSchema.parse(article);
  const parts = [
    a.summary.trim(),
    "## Problems with the argument",
    a.critique.map((c) => `- **${LABEL[c.category]}:** ${c.point.trim()} Why it matters: ${c.why_it_matters.trim()}`).join("\n"),
    a.conclusion.trim(),
  ];
  const warnings = a.warnings.map((w) => w.trim()).filter(Boolean);
  if (warnings.length) parts.push(`*Note: ${warnings.join(" ")}*`);
  return `${parts.join("\n\n")}\n`;
}

const words = (s: string) => s.replace(/[*_#`>[\]()-]/g, " ").split(/\s+/).filter(Boolean).length;

/** Advisory length guidance (contract): counts and a warning, never a rejection. */
export function lengthGuidance(a: Article): { summaryWords: number; conclusionWords: number; warning: string | null } {
  const summaryWords = words(a.summary);
  const conclusionWords = words(a.conclusion);
  const outside = summaryWords < 120 || summaryWords > 250 || conclusionWords > 120;
  return { summaryWords, conclusionWords, warning: outside ? "length-outside-guidance" : null };
}
