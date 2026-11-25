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
      url: z.url({ protocol: /^https$/ }),
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
      url: z.url({ protocol: /^https$/ }),
      renderer: z.string().min(1).max(200),
      reason: z.enum(["render-failed", "not-png", "too-large", "empty"]),
      attemptedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);
export type ScreenshotRecord = z.infer<typeof ScreenshotRecordSchema>;

export const screenshotPath = (post: {
  publicationId: string;
  postId: string;
}) => `substack/${post.publicationId}/${post.postId}/screenshot.json`;

export async function captureSourceScreenshot(
  post: { publicationId: string; postId: string; url: string },
  deps: {
    renderer: ScreenshotRenderer;
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
  try {
    bytes = await deps.renderer.render(post.url, deps.signal);
  } catch {
    bytes = undefined;
  }
  const reason = !bytes
    ? "render-failed"
    : bytes.length === 0
      ? "empty"
      : bytes.length > MAX_BYTES
        ? "too-large"
        : PNG.some((b, i) => bytes![i] !== b)
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
export function browserlessRenderer(config: {
  endpoint: string;
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): ScreenshotRenderer {
  const endpoint = new URL("/screenshot", config.endpoint);
  if (config.token) endpoint.searchParams.set("token", config.token);
  return {
    name: "browserless-chromium",
    async render(url, signal) {
      if (new URL(url).protocol !== "https:")
        throw new Error("screenshot: https only");
      const response = await (config.fetch ?? fetch)(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          viewport: SCREENSHOT_VIEWPORT,
          options: { type: "png", fullPage: false },
          gotoOptions: {
            waitUntil: "networkidle2",
            timeout: config.timeoutMs ?? 30_000,
          },
        }),
        signal:
          signal ?? AbortSignal.timeout((config.timeoutMs ?? 30_000) + 5_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`screenshot: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
