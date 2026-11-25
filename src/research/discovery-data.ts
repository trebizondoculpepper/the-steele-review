import type { AppliedResearchTokens } from "../config/research-tokens.js";
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
  transport: "complete" | "incomplete" | "resource-limit";
  encoding: "base64";
  appliedTokens?: AppliedResearchTokens;
}
export type DiscoveryCapture = (data: unknown) => Promise<void>;

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
    ...(report.costUsd === undefined
      ? {}
      : { usage: { costUsd: report.costUsd } }),
  };
}
