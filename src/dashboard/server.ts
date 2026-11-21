import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * LAN-only operator dashboard shell (#375).
 *
 * Owner decision: reachable from the home LAN without a login, so the server
 * keeps service credentials on the server. Exposure is
 * controlled by where Compose binds the port, configured privately.
 *
 * - Server-rendered HTML with no scripts; a strict Content-Security-Policy
 *   forbids scripts, frames and remote resources, so content shown later
 *   (#377/#378) cannot execute even if it contains markup.
 * - GET and HEAD are read-only. Explicitly configured actions require bounded,
 *   same-origin POSTs against the configured dashboard origin and Host.
 * - Pages are registered by later tickets through `views`; the shell has the
 *   Overview and Articles navigation.
 */

export interface DashboardActions {
  /** Explicit configured browser origin; never trust forwarded headers. */
  origin: string;
  routes: Record<string, (form: URLSearchParams) => Promise<{ status: number; location?: string }>>;
}

export interface DashboardView {
  path: string;
  title: string;
  /** Returns trusted HTML for the page body; untrusted text must go through `escapeHtml`. */
  render(url: URL): Promise<string> | string;
  /** Hidden from navigation (detail pages reached by link). */
  hidden?: boolean;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for an HTML text or attribute context. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  // same-origin, not no-referrer: under no-referrer a browser form POST carries
  // "Origin: null", which the same-origin action check (correctly) rejects.
  // Cross-origin requests still receive no referrer.
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};

const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6b6b70; --bg: #fafafa; --line: #d9d9de; --accent: #2b59c3; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececef; --muted: #a0a0a8; --bg: #16161a; --line: #34343a; --accent: #8fb0ff; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
header { display: flex; gap: 1.5rem; align-items: baseline; padding: 0.75rem 1rem; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
header strong { font-size: 1rem; }
nav a { color: var(--muted); text-decoration: none; margin-right: 1rem; }
nav a[aria-current="page"] { color: var(--accent); font-weight: 600; }
main { padding: 1rem; max-width: 72rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
.wrap { overflow-x: auto; }
code { font-size: 0.85em; word-break: break-all; }
.s-done, .s-completed { color: #2e8540; } .s-failed { color: #c0392b; font-weight: 600; }
.s-pending { color: #b7791f; } .s-not-reached, .s-not-started, .s-unknown { color: var(--muted); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
dt { color: var(--muted); }
.empty { color: var(--muted); }
`;

function page(views: DashboardView[], current: DashboardView, body: string): string {
  const nav = views
    .filter((v) => !v.hidden)
    .map(
      (v) =>
        `<a href="${escapeHtml(v.path)}"${v === current || (current.hidden && current.path.startsWith(`${v.path}/`)) ? ' aria-current="page"' : ""}>${escapeHtml(v.title)}</a>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(current.title)} · Steele Review</title>
<style>${STYLE}</style>
</head>
<body>
<header><strong>Steele Review</strong><nav>${nav}</nav></header>
<main>
<h1>${escapeHtml(current.title)}</h1>
${body}
</main>
</body>
</html>
`;
}

export const DEFAULT_VIEWS: DashboardView[] = [
  {
    path: "/overview",
    title: "Overview",
    render: () => '<p class="empty">System status will appear here.</p>',
  },
  {
    path: "/articles",
    title: "Articles",
    render: () => '<p class="empty">Archived articles and their runs will appear here.</p>',
  },
];

export function dashboardHandler(
  views: DashboardView[] = DEFAULT_VIEWS,
  actions?: DashboardActions,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://dashboard.invalid");
    if (method === "POST" && actions?.routes[url.pathname]) {
      const origin = new URL(actions.origin);
      if (
        request.headers.origin !== origin.origin ||
        request.headers.host !== origin.host ||
        (request.headers["sec-fetch-site"] !== undefined &&
          request.headers["sec-fetch-site"] !== "same-origin")
      ) {
        response.writeHead(403, SECURITY_HEADERS).end();
        return;
      }
      if (request.headers["content-type"] !== "application/x-www-form-urlencoded") {
        response.writeHead(415, SECURITY_HEADERS).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 4096) {
          response.writeHead(413, SECURITY_HEADERS).end();
          return;
        }
        chunks.push(bytes);
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      if ([...new Set(form.keys())].some((key) => form.getAll(key).length !== 1)) {
        response.writeHead(400, SECURITY_HEADERS).end();
        return;
      }
      try {
        const result = await actions.routes[url.pathname]!(form);
        response
          .writeHead(result.status, {
            ...SECURITY_HEADERS,
            ...(result.location ? { location: result.location } : {}),
          })
          .end();
      } catch {
        response.writeHead(503, SECURITY_HEADERS).end();
      }
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", ...SECURITY_HEADERS }).end();
      return;
    }
    const path = url.pathname;
    if (path === "/health") {
      response.writeHead(200, { "content-type": "application/json", ...SECURITY_HEADERS });
      response.end(method === "HEAD" ? undefined : JSON.stringify({ ok: true }));
      return;
    }
    if (path === "/") {
      response.writeHead(303, { location: views[0]!.path, ...SECURITY_HEADERS }).end();
      return;
    }
    const view = views.find((v) => v.path === path);
    if (!view) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
      response.end(method === "HEAD" ? undefined : "Not found");
      return;
    }
    let body: string;
    try {
      body = await view.render(url);
    } catch {
      // Never echo internal errors: they may name hosts or paths.
      body = '<p class="empty">This view is unavailable right now.</p>';
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
    response.end(method === "HEAD" ? undefined : page(views, view, body));
  };
}

export function createDashboardServer(
  views: DashboardView[] = DEFAULT_VIEWS,
  actions?: DashboardActions,
): Server {
  const handle = dashboardHandler(views, actions);
  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS);
      res.end();
    });
  });
}
