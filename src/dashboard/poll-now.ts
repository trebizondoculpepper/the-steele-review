import { z } from "zod";
import { escapeHtml } from "./server.js";

/**
 * Poll now on the Articles page (#824).
 *
 * One button per source type. A click polls every configured source of that
 * type immediately, through the same Restate `DiscoveryPoll` handler the
 * schedule uses (#823), so its cursor, deduplication and one-at-a-time
 * guarantee apply: a click right after another poll is coalesced into it,
 * and repeated clicks never duplicate discovery. Results are shown per
 * source, including partial failures. Opening the page polls nothing.
 */

export const SOURCE_TYPES = ["substack", "telegram"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export interface PollSource {
  type: SourceType;
  /** The poll key, e.g. the Substack publication ID. */
  id: string;
}

/** What the page reports for one source. */
export interface SourcePollResult {
  id: string;
  status: "complete" | "coalesced" | "failed" | "still-running" | "unavailable";
  discovered?: number;
  published?: number;
  /** The stage and error class name only, never a message. */
  failure?: string;
}

/** The poll outcome the DiscoveryPoll handler returns. */
export interface PollOutcomeLike {
  status: string;
  discovered: number;
  published: number;
  failure?: { stage: string; errorName: string };
}

export interface PollNowDeps {
  sources: PollSource[];
  /** Poll one source now through the scheduled job's handler. */
  poll(source: PollSource): PromiseLike<PollOutcomeLike>;
}

const ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** Parse `STEELE_POLL_SOURCES`, e.g. `substack:saveusnow,substack:other`. */
export function parsePollSources(value: string | undefined): PollSource[] {
  if (!value) return [];
  return value.split(",").flatMap((entry) => {
    const [type, id] = entry.trim().split(":");
    return (SOURCE_TYPES as readonly string[]).includes(type ?? "") && ID.test(id ?? "")
      ? [{ type: type as SourceType, id: id! }]
      : [];
  });
}

const ResultsSchema = z
  .array(
    z
      .object({
        id: z.string().regex(ID),
        status: z.enum(["complete", "coalesced", "failed", "still-running", "unavailable"]),
        discovered: z.number().int().min(0).max(100_000).optional(),
        published: z.number().int().min(0).max(100_000).optional(),
        failure: z
          .string()
          .regex(/^[a-z]{1,20}:[A-Za-z]{1,60}$/)
          .optional(),
      })
      .strict(),
  )
  .max(50);

const encode = (results: SourcePollResult[]) =>
  Buffer.from(JSON.stringify(results)).toString("base64url");
const decode = (value: string | null): SourcePollResult[] | undefined => {
  if (!value || value.length > 8000) return undefined;
  try {
    const parsed = ResultsSchema.safeParse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const TIMEOUT = /timeout|abort/i;

function toResult(id: string, out: PollOutcomeLike): SourcePollResult {
  const status =
    out.status === "complete" || out.status === "coalesced" || out.status === "failed"
      ? out.status
      : "unavailable";
  return {
    id,
    status,
    discovered: out.discovered,
    published: out.published,
    ...(out.failure &&
    /^[a-z]{1,20}$/.test(out.failure.stage) &&
    /^[A-Za-z]{1,60}$/.test(out.failure.errorName)
      ? { failure: `${out.failure.stage}:${out.failure.errorName}` }
      : {}),
  };
}

export function pollNowAction(deps: PollNowDeps) {
  /** The panel shown on the Articles page; `actionOrigin` prefixes the form target. */
  const panel = (url: URL, actionOrigin = ""): string => {
    const forms = SOURCE_TYPES.map((type) => {
      const count = deps.sources.filter((s) => s.type === type).length;
      return count === 0
        ? `<p><button disabled>Poll ${type} now</button> <span class="empty">no configured ${type} sources</span></p>`
        : `<form method="post" action="${escapeHtml(actionOrigin)}/articles/poll"><input type="hidden" name="type" value="${type}"><button name="confirm" value="yes">Poll ${type} now</button> <span class="empty">${count} configured source${count === 1 ? "" : "s"}</span></form>`;
    }).join("");
    const polled = url.searchParams.get("polled");
    const results = decode(url.searchParams.get("results"));
    let report = "";
    if (polled && (SOURCE_TYPES as readonly string[]).includes(polled) && results) {
      const failed = results.filter((r) => r.status !== "complete" && r.status !== "coalesced");
      const rows = results
        .map(
          (r) =>
            `<tr><td><code>${escapeHtml(r.id)}</code></td><td>${escapeHtml(
              r.status === "coalesced" ? "already polled just now" : r.status,
            )}</td><td>${r.discovered ?? "—"}</td><td>${r.published ?? "—"}</td><td>${
              r.failure ? escapeHtml(r.failure) : "—"
            }</td></tr>`,
        )
        .join("");
      report = `<p>Polled ${escapeHtml(polled)}: ${results.length - failed.length} of ${results.length} source${results.length === 1 ? "" : "s"} succeeded${failed.length ? `; ${failed.length} did not` : ""}.</p><div class="wrap"><table><thead><tr><th>Source</th><th>Result</th><th>Entries seen</th><th>New entries</th><th>Failure</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    } else if (url.searchParams.get("poll-error") === "invalid") {
      report = '<p class="empty">That source type is not valid.</p>';
    }
    return `<section class="poll-now"><h2>Poll now</h2>${forms}${report}</section>`;
  };

  return {
    panel,
    async submit(form: URLSearchParams): Promise<{ status: number; location?: string }> {
      if (form.get("confirm") !== "yes") return { status: 400 };
      const type = form.get("type") ?? "";
      if (!(SOURCE_TYPES as readonly string[]).includes(type))
        return { status: 303, location: "/articles?poll-error=invalid" };
      const sources = deps.sources.filter((s) => s.type === type);
      // Every source is polled; one failing never hides the others.
      const results = await Promise.all(
        sources.map(async (source): Promise<SourcePollResult> => {
          try {
            return toResult(source.id, await deps.poll(source));
          } catch (error) {
            return {
              id: source.id,
              status:
                error instanceof Error && TIMEOUT.test(error.name)
                  ? "still-running"
                  : "unavailable",
            };
          }
        }),
      );
      return {
        status: 303,
        location: `/articles?${new URLSearchParams({ polled: type, results: encode(results) }).toString()}`,
      };
    },
  };
}
