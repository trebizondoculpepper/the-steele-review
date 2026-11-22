import { describe, expect, it } from "vite-plus/test";
import { PublicImageFetcher, sniffImageType } from "../../src/controllers/research-web.js";

// Synthetic bytes and addresses only (#277).
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const URL_ = "https://images.example.org/cover.png";
const signal = () => new AbortController().signal;

function fetcher(reply: () => Response, addresses = ["93.184.216.34"], maxBytes?: number) {
  return new PublicImageFetcher({
    resolve: async () => addresses,
    fetch: async () => reply(),
    ...(maxBytes ? { maxBytes } : {}),
  });
}
const image = (bytes: Buffer, type: string, status = 200) =>
  new Response(new Uint8Array(bytes), { status, headers: { "content-type": type } });

describe("public image fetcher (#277)", () => {
  it("returns exact bytes when the declared type and signature agree", async () => {
    const out = await fetcher(() => image(PNG, "image/png")).fetch(URL_, signal());
    expect(out.contentType).toBe("image/png");
    expect(Buffer.compare(out.bytes, PNG)).toBe(0);
  });

  it("refuses a mismatched signature, non-image content, redirects and oversized bodies", async () => {
    await expect(
      fetcher(() => image(JPEG, "image/png")).fetch(URL_, signal()),
    ).rejects.toMatchObject({ code: "unsupported-content" });
    await expect(
      fetcher(() => image(Buffer.from("<html></html>"), "text/html")).fetch(URL_, signal()),
    ).rejects.toMatchObject({ code: "unsupported-content" });
    await expect(
      fetcher(() => new Response(null, { status: 302, headers: { location: "https://x/" } })).fetch(
        URL_,
        signal(),
      ),
    ).rejects.toMatchObject({ code: "redirected" });
    await expect(
      fetcher(() => image(PNG, "image/png"), undefined, 4).fetch(URL_, signal()),
    ).rejects.toMatchObject({ code: "too-large" });
  });

  it("refuses non-public hosts and plain HTTP before any request", async () => {
    let called = false;
    const f = new PublicImageFetcher({
      resolve: async () => ["10.0.0.5"],
      fetch: async () => {
        called = true;
        return image(PNG, "image/png");
      },
    });
    await expect(f.fetch(URL_, signal())).rejects.toMatchObject({ code: "not-public" });
    await expect(f.fetch("http://images.example.org/a.png", signal())).rejects.toMatchObject({
      code: "not-public",
    });
    expect(called).toBe(false);
  });

  it("bounds the address lookup by cancellation", async () => {
    const f = new PublicImageFetcher({
      resolve: () => new Promise(() => undefined), // never answers
      fetch: async () => image(PNG, "image/png"),
    });
    const controller = new AbortController();
    const pending = f.fetch(URL_, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("sniffs only allowlisted image signatures", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    // The full eight-byte PNG signature is required.
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0]))).toBeUndefined();
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffImageType(Buffer.from("RIFF0000WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(Buffer.from("<svg/>"))).toBeUndefined();
  });
});
