/**
 * Restate admin API adapter (#874): the one place that speaks Restate's
 * admin query protocol for reconciliation. Callers get plain values; a
 * failure is reported by category only, never with the endpoint.
 */

export class RestateAdminError extends Error {
  constructor(readonly category: "unreachable" | "rejected" | "malformed") {
    super(`restate admin ${category}`);
    this.name = "RestateAdminError";
  }
}

/** Every ArticleRun workflow key Restate still records, base and suffixed. */
export async function articleRunKeys(
  adminUrl: string,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<string[]> {
  const f = options.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${adminUrl.replace(/\/+$/, "")}/query`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        query:
          "SELECT DISTINCT target_service_key AS key FROM sys_invocation WHERE target_service_name = 'ArticleRun' AND target_handler_name = 'run'",
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch {
    throw new RestateAdminError("unreachable");
  }
  if (!res.ok) throw new RestateAdminError("rejected");
  let body: { rows?: { key?: unknown }[] };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new RestateAdminError("malformed");
  }
  return (body.rows ?? []).flatMap((r) => (typeof r.key === "string" ? [r.key] : []));
}
