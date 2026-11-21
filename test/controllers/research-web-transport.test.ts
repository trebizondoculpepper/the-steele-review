import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vite-plus/test";

const transport = vi.hoisted(() => ({ respond: undefined as undefined | (() => Readable) }));
vi.mock("node:https", () => ({
  request: () => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => queueMicrotask(() => req.emit("response", transport.respond!()));
    return req;
  },
}));

import { PublicPageFetcher, WebAdapterError } from "../../src/controllers/research-web.js";

function response(
  status: number | undefined,
  headers: Record<string, string> = { "content-type": "text/plain" },
) {
  const res = Object.assign(Readable.from([Buffer.from("public page")], { objectMode: false }), {
    statusCode: status,
    headers,
  });
  const destroy = vi.spyOn(res, "destroy");
  transport.respond = () => res;
  return { res, destroy };
}
const fetchPage = () =>
  new PublicPageFetcher({ resolve: async () => ["93.184.216.34"] }).fetch(
    "https://source.example/article",
    new AbortController().signal,
  );

describe("pinned research HTTPS transport callback", () => {
  it.each([undefined, 100, 199, 600, 999, NaN])(
    "rejects invalid status %j without an uncaught callback exception",
    async (status) => {
      const { destroy } = response(status);
      await expect(fetchPage()).rejects.toMatchObject({ code: "bad-response" });
      expect(destroy).toHaveBeenCalled();
    },
  );

  it("catches response-construction failures without exposing response values", async () => {
    const { destroy } = response(200, { "bad header": "SENTINEL-private-response" });
    try {
      await fetchPage();
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(WebAdapterError);
      expect((error as Error).message).toBe("web adapter bad-response");
    }
    expect(destroy).toHaveBeenCalled();
  });

  it.each([204, 205])(
    "handles null-body status %i without constructing an illegal body",
    async (status) => {
      response(status);
      expect((await fetchPage()).text).toBe("");
    },
  );

  it("keeps valid page retrieval and redirect refusal unchanged", async () => {
    response(200);
    expect((await fetchPage()).text).toBe("public page");
    response(302);
    await expect(fetchPage()).rejects.toMatchObject({ code: "redirected" });
  });
});
