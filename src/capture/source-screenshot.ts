import { createHash } from "node:crypto";
import { z } from "zod";
import {
  sha256,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";

/**
 * Optional source screenshot (#892): a separate composable block, no model
 * calls and no events.
 *
 * A headless browser in its own container renders the public post at an
 * 800 × 600 viewport. The PNG is saved content-addressed beside the source
 * (`substack/<publication>/<post>/images/<sha256>.png`, as retained preview
 * images are), and one stable record, `screenshot.json`, names the current
 * screenshot or says why none is available. A failed render is recorded as
 * unavailable and never throws to ingestion. The block publishes nothing, so
 * a refresh can never start an article run. The publisher-provided preview
 * image stays the Substack featured image.
 */

export const SCREENSHOT_VIEWPORT = { width: 800, height: 600 } as const;
const MAX_BYTES = 5 * 1024 * 1024;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface ScreenshotRenderer {
  /** Identity of the renderer, recorded with every result. */
  readonly name: string;
  render(url: string, signal?: AbortSignal): Promise<Uint8Array>;
}

export const ScreenshotRecordSchema = z.discriminatedUnion("status", [
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("captured"),
      url: z.string().min(1).max(2000),
      renderer: z.string().min(1).max(200),
      viewport: z
        .object({ width: z.number().int(), height: z.number().int() })
        .strict(),
      image: z
        .object({
          repository: z.string().min(1),
          commit: z.string().min(1),
          path: z.string().regex(/\/images\/[0-9a-f]{64}\.png$/),
          hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        })
        .strict(),
      bytes: z.number().int().positive(),
      capturedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("unavailable"),
      url: z.string().min(1).max(2000),
      renderer: z.string().min(1).max(200),
      reason: z.enum([
        "render-failed",
        "not-png",
        "too-large",
        "empty",
        "not-allowed",
      ]),
      attemptedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);
export type ScreenshotRecord = z.infer<typeof ScreenshotRecordSchema>;

export const screenshotPath = (post: {
  publicationId: string;
  postId: string;
}) => `substack/${post.publicationId}/${post.postId}/screenshot.json`;

/** A structurally complete PNG: signature, IHDR first, IEND last. */
export function isCompletePng(bytes: Uint8Array): boolean {
  const ascii = (from: number) =>
    String.fromCharCode(...bytes.slice(from, from + 4));
  return (
    bytes.length >= 57 &&
    PNG.every((b, i) => bytes[i] === b) &&
    ascii(12) === "IHDR" &&
    ascii(bytes.length - 8) === "IEND"
  );
}

/**
 * Only public post pages on allowed hosts are rendered (SECURITY.md public
 * destinations): an exact host, or a suffix such as ".substack.com".
 */
export function allowedPostUrl(
  url: string,
  allowedHosts: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port ||
    parsed.username ||
    parsed.password
  )
    return false;
  const host = parsed.hostname.toLowerCase();
  return allowedHosts.some((h) =>
    h.startsWith(".") ? host.endsWith(h) && host.length > h.length : host === h,
  );
}

export async function captureSourceScreenshot(
  post: { publicationId: string; postId: string; url: string },
  deps: {
    renderer: ScreenshotRenderer;
    /** Hosts the browser may be sent to (default: Substack publications). */
    allowedHosts?: readonly string[];
    artifacts: Pick<
      GitArtifactStore,
      "lookup" | "read" | "revise" | "writeBinary"
    >;
    now?: () => Date;
    signal?: AbortSignal;
  },
): Promise<{ record: ScreenshotRecord; ref: ArtifactRef }> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const base = {
    schemaVersion: 1 as const,
    url: post.url,
    renderer: deps.renderer.name,
  };
  let record: ScreenshotRecord;
  let bytes: Uint8Array | undefined;
  const allowed = allowedPostUrl(
    post.url,
    deps.allowedHosts ?? [".substack.com"],
  );
  if (allowed) {
    try {
      bytes = await deps.renderer.render(post.url, deps.signal);
    } catch {
      bytes = undefined;
    }
  }
  const reason = !allowed
    ? "not-allowed"
    : !bytes
      ? "render-failed"
      : bytes.length === 0
        ? "empty"
        : bytes.length > MAX_BYTES
          ? "too-large"
          : !isCompletePng(bytes)
            ? "not-png"
            : undefined;
  if (reason) {
    record = { ...base, status: "unavailable", reason, attemptedAt: now };
  } else {
    const digest = createHash("sha256").update(bytes!).digest("hex");
    const image = await deps.artifacts.writeBinary(
      `substack/${post.publicationId}/${post.postId}/images/${digest}.png`,
      bytes!,
      digest,
    );
    record = {
      ...base,
      status: "captured",
      viewport: { ...SCREENSHOT_VIEWPORT },
      image: {
        repository: image.repository,
        commit: image.commit,
        path: image.path,
        hash: `sha256:${image.sha256}`,
      },
      bytes: bytes!.length,
      capturedAt: now,
    };
  }
  const path = screenshotPath(post);
  const existing = await deps.artifacts.lookup(path);
  const content = `${JSON.stringify(ScreenshotRecordSchema.parse(record), null, 2)}\n`;
  // An identical screenshot keeps its existing record (no commit).
  if (existing && record.status === "captured") {
    const saved = ScreenshotRecordSchema.safeParse(
      JSON.parse(await deps.artifacts.read(existing)),
    );
    if (
      saved.success &&
      saved.data.status === "captured" &&
      saved.data.image.hash === record.image.hash
    )
      return { record: saved.data, ref: existing };
  }
  const ref = await deps.artifacts.revise(
    path,
    content,
    existing?.sha256 ?? null,
  );
  return { record, ref };
}

/**
 * A renderer backed by a browserless Chromium container's screenshot API.
 * The container runs separately, so the application image stays small.
 */
/** Requests the browser must refuse: plain HTTP, and private or internal hosts. */
export const REFUSED_REQUESTS = [
  "^http://",
  "^https?://(localhost|[^/]*\\.local|[^/]*\\.internal)([:/]|$)",
  "^https?://(127\\.|10\\.|0\\.|169\\.254\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.)",
  "^https?://\\[",
];

/** Hides consent banners and brings the headline to the top before capture. */
const PREPARE_STYLE =
  "[class*=cookie],[id*=cookie],[class*=consent],[id*=consent],[aria-label*=ookie]{display:none!important}";
const PREPARE_SCRIPT =
  "(()=>{const h=document.querySelector('h1');if(h){h.scrollIntoView({block:'start'});window.scrollBy(0,-16);}})();";

/**
 * A renderer backed by a browserless Chromium container's screenshot API.
 * The container runs separately, so the application image stays small. It
 * must run on an isolated network with no route to internal services: the
 * refused-request patterns below are defence in depth, applied to the
 * navigation, its redirects and every subrequest.
 */
export function browserlessRenderer(config: {
  endpoint: string;
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): ScreenshotRenderer {
  const endpoint = new URL("/screenshot", config.endpoint);
  if (config.token) endpoint.searchParams.set("token", config.token);
  const timeoutMs = config.timeoutMs ?? 30_000;
  return {
    name: "browserless-chromium",
    async render(url, signal) {
      if (new URL(url).protocol !== "https:")
        throw new Error("screenshot: https only");
      const deadline = AbortSignal.timeout(timeoutMs + 5_000);
      const response = await (config.fetch ?? fetch)(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          viewport: SCREENSHOT_VIEWPORT,
          options: { type: "png", fullPage: false },
          gotoOptions: { waitUntil: "networkidle2", timeout: timeoutMs },
          rejectRequestPattern: REFUSED_REQUESTS,
          addStyleTag: [{ content: PREPARE_STYLE }],
          addScriptTag: [{ content: PREPARE_SCRIPT }],
        }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        redirect: "error",
      });
      if (!response.ok) throw new Error(`screenshot: ${response.status}`);
      // Browserless answers 200 even when the site does not; the site's own
      // status is in X-Response-Code. Absent, the render is accepted (older
      // Browserless versions omit it), and PNG validation still applies.
      const site = response.headers.get("x-response-code");
      if (site && !/^2\d\d$/.test(site))
        throw new Error(`screenshot: site ${site}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
