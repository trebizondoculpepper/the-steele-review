import { z } from "zod";
/** Whitelisted provider data only: never the request, connection settings, headers or credentials. */
export const DiscoveryDataSchema = z
  .object({
    report: z.string().max(2_000_000),
    citations: z.array(z.string()).max(10_000),
    annotationUrls: z.array(z.string()).max(10_000).default([]),
    searchResultUrls: z.array(z.string()).max(10_000).default([]),
    model: z.string().min(1).max(200),
    citationProvenance: z.enum(["provider-original", "adapter-return-only"]),
    usage: z
      .object({
        costUsd: z.number().nonnegative().optional(),
        promptTokens: z.number().int().nonnegative().optional(),
        completionTokens: z.number().int().nonnegative().optional(),
        totalTokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DiscoveryData = z.infer<typeof DiscoveryDataSchema>;
export interface PartialDiscoveryBody {
  representation: "provider-json";
  body: string;
  transport: "incomplete" | "resource-limit";
}
export type DiscoveryCapture = (data: unknown) => Promise<void>;

/** Select only returned report/citation/usage fields. No request, header or connection object is copied. */
export function selectDiscoveryData(payload: unknown, requestedModel: string): unknown {
  const object = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const root = object(payload),
    first = Array.isArray(root.choices) ? object(root.choices[0]) : {},
    message = object(first.message);
  const annotations = message.annotations;
  const usage = object(root.usage),
    numbers: Record<string, number> = {};
  for (const [key, target] of [
    ["cost", "costUsd"],
    ["prompt_tokens", "promptTokens"],
    ["completion_tokens", "completionTokens"],
    ["total_tokens", "totalTokens"],
  ]) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) numbers[target] = value;
  }
  return {
    report: message.content ?? "",
    citations: root.citations ?? [],
    annotationUrls:
      annotations === undefined
        ? []
        : Array.isArray(annotations)
          ? annotations
              .map((v) => object(object(v).url_citation).url)
              .filter((v) => v !== undefined)
          : annotations,
    searchResultUrls:
      root.search_results === undefined
        ? []
        : Array.isArray(root.search_results)
          ? root.search_results.map((v) => object(v).url)
          : root.search_results,
    model: root.model ?? requestedModel,
    citationProvenance: "provider-original",
    ...(Object.keys(numbers).length ? { usage: numbers } : {}),
  };
}

/** Compatibility for adapters without raw capture; explicitly not the original provider envelope. */
export function discoveryFromAdapterReport(report: {
  report: string;
  citations: string[];
  model: string;
  costUsd?: number;
}): DiscoveryData {
  return {
    report: report.report,
    citations: report.citations,
    annotationUrls: [],
    searchResultUrls: [],
    model: report.model,
    citationProvenance: "adapter-return-only",
    ...(report.costUsd === undefined ? {} : { usage: { costUsd: report.costUsd } }),
  };
}
