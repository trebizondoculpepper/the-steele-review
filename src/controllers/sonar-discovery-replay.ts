import { DiscoveryDataSchema, type DiscoveryData } from "../research/discovery-data.js";

/** Typed replay of retained Sonar/OpenRouter bytes; never performs a provider call. */
export interface SonarDiscoveryReplay {
  validation: "valid" | "invalid-json" | "invalid-schema" | "length-limit";
  completion: "completed" | "length-limit" | "unknown";
  data: DiscoveryData | undefined;
}

export function replaySonarDiscovery(body: string, requestedModel: string): SonarDiscoveryReplay {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { validation: "invalid-json", completion: "unknown", data: undefined };
  }
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const choice = Array.isArray(root.choices)
    ? (root.choices[0] as { finish_reason?: unknown } | undefined)
    : undefined;
  const completion =
    choice?.finish_reason === "length"
      ? "length-limit"
      : choice?.finish_reason === "stop"
        ? "completed"
        : "unknown";
  const parsed = DiscoveryDataSchema.safeParse(selectDiscoveryData(payload, requestedModel));
  if (!parsed.success || !parsed.data.report.trim()) {
    return { validation: "invalid-schema", completion, data: undefined };
  }
  return {
    validation: completion === "length-limit" ? "length-limit" : "valid",
    completion,
    data: parsed.data,
  };
}

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
