import { escapeHtml } from "./server.js";

/**
 * Links from the console to Restate's own execution UI (#561), an external
 * workflow-inspection view. The UI base URL is private configuration; links
 * are built only from a validated base and a validated invocation ID, never
 * from caller-controlled URLs, and the console never proxies the UI.
 *
 * A run is linked to its exact invocation, resolved from its exact workflow
 * key (original or recovery) through the admin query API; an ID is never
 * guessed from a post slug, and a run is never sent to an unrelated latest
 * invocation. When no exact invocation can be established, only the UI home
 * link is offered, with that limitation stated.
 */

const INVOCATION_ID = /^inv_[A-Za-z0-9]{10,100}$/;

export interface RestateUiLinks {
  home: string;
  invocation(id: string): string | undefined;
}

/** A validated UI base (http/https, no credentials, no query/fragment), or undefined. */
export function restateUiLinks(base: string | undefined): RestateUiLinks | undefined {
  if (!base) return undefined;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }
  const home = `${url.origin}${url.pathname.replace(/\/+$/, "")}/`;
  return {
    home,
    invocation: (id) => (INVOCATION_ID.test(id) ? `${home}invocations/${id}` : undefined),
  };
}

/** Resolves the exact invocation of one workflow key; undefined when it cannot be established. */
export interface InvocationLookupPort {
  invocationFor(workflowKey: string): Promise<string | undefined>;
}

/**
 * The run handler invocation of an ArticleRun workflow key, through the
 * Restate admin query API (private URL). Exactly one match is required.
 */
export function restateInvocations(
  adminUrl: string,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): InvocationLookupPort {
  const f = options.fetch ?? fetch;
  const base = adminUrl.replace(/\/+$/, "");
  return {
    async invocationFor(workflowKey) {
      // The key goes in as a SQL string literal: quotes are doubled, and keys
      // are already restricted to workflow-key characters by their builders.
      if (!/^[A-Za-z0-9/@~:._-]{1,600}$/.test(workflowKey)) return undefined;
      const literal = workflowKey.replace(/'/g, "''");
      try {
        const res = await f(`${base}/query`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            query: `SELECT id FROM sys_invocation WHERE target_service_name = 'ArticleRun' AND target_handler_name = 'run' AND target_service_key = '${literal}'`,
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
        });
        if (!res.ok) return undefined;
        const body = (await res.json()) as { rows?: { id?: unknown }[] };
        const ids = (body.rows ?? [])
          .map((r) => r.id)
          .filter((id): id is string => typeof id === "string");
        // Exactly one run invocation per workflow key; anything else is not established.
        return ids.length === 1 && INVOCATION_ID.test(ids[0]!) ? ids[0] : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** The trace page's external-inspection section for an original and optional recovery run. */
export async function restateRunLinksHtml(input: {
  links: RestateUiLinks;
  lookup?: InvocationLookupPort;
  runs: { label: string; workflowKey: string }[];
}): Promise<string> {
  const items: string[] = [];
  for (const run of input.runs) {
    const id = input.lookup ? await input.lookup.invocationFor(run.workflowKey) : undefined;
    const href = id ? input.links.invocation(id) : undefined;
    items.push(
      href
        ? `<li>${escapeHtml(run.label)}: <a href="${escapeHtml(href)}" rel="noopener noreferrer">open this invocation in Restate</a></li>`
        : `<li>${escapeHtml(run.label)}: <span class="empty">no exact invocation could be established</span></li>`,
    );
  }
  return `<h2>Workflow inspection</h2><p class="empty">Restate's own execution UI is an external, administrative view.</p><ul>${items.join("")}</ul><p><a href="${escapeHtml(input.links.home)}" rel="noopener noreferrer">Open the Restate UI</a></p>`;
}

/** An ArticleRun workflow key: `pub/post@<32 hex>`, optionally an attempt or recovery suffix. */
const RUN_KEY =
  /^([a-z0-9][a-z0-9-]{0,199})\/([a-z0-9][a-z0-9-]{0,199})@([0-9a-f]{32})(?:~[a-z0-9-]{1,80})*$/;

/**
 * Discover recent article runs from Restate's admin query API (#479), newest
 * first, so the Activity page sees a run on any post, not only the newest
 * articles. Each key's 32-character revision prefix is matched to the post's
 * indexed revision to recover the exact source version; a run whose revision
 * is not the indexed one is skipped rather than guessed. Read-only and
 * bounded; failures yield an empty index (the page says discovery is limited).
 */
export function restateRunIndex(
  adminUrl: string,
  articles: {
    find(publicationId: string, postId: string): Promise<{ sourceVersion: string } | undefined>;
  },
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): {
  recent(
    limit: number,
  ): Promise<{ publicationId: string; postId: string; sourceVersion: string }[]>;
} {
  const f = options.fetch ?? fetch;
  const base = adminUrl.replace(/\/+$/, "");
  return {
    async recent(limit) {
      const n = Math.max(1, Math.min(Math.trunc(limit), 200));
      let keys: string[];
      try {
        const res = await f(`${base}/query`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            // Unfinished runs first, then the most recently created.
            query: `SELECT target_service_key AS key FROM sys_invocation WHERE target_service_name = 'ArticleRun' AND target_handler_name = 'run' ORDER BY (completed_at IS NULL) DESC, created_at DESC LIMIT ${n}`,
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
        });
        if (!res.ok) return [];
        const body = (await res.json()) as { rows?: { key?: unknown }[] };
        keys = (body.rows ?? [])
          .map((r) => r.key)
          .filter((k): k is string => typeof k === "string");
      } catch {
        return [];
      }
      const out: { publicationId: string; postId: string; sourceVersion: string }[] = [];
      const seen = new Set<string>();
      for (const key of keys) {
        const m = RUN_KEY.exec(key);
        if (!m) continue;
        const [, publicationId, postId, prefix] = m as unknown as [string, string, string, string];
        const id = `${publicationId}/${postId}@${prefix}`;
        if (seen.has(id)) continue;
        seen.add(id);
        let indexed;
        try {
          indexed = await articles.find(publicationId, postId);
        } catch {
          continue;
        }
        if (indexed && indexed.sourceVersion.slice(7, 39) === prefix)
          out.push({ publicationId, postId, sourceVersion: indexed.sourceVersion });
      }
      return out;
    },
  };
}
