import { describe, expect, it } from "vite-plus/test";
import { abortableSleep } from "../../../src/controllers/substack/http.js";

describe("abortableSleep", () => {
  it("detaches its abort listener after completing", async () => {
    const abort = new AbortController();
    let added = 0;
    let removed = 0;
    const signal = abort.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof add>) => {
      added++;
      add(...args);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      removed++;
      remove(...args);
    }) as typeof signal.removeEventListener;
    for (let i = 0; i < 3; i++) await abortableSleep(1, signal);
    expect(added).toBe(3);
    expect(removed).toBe(3);
  });

  it("rejects when aborted", async () => {
    const abort = new AbortController();
    const pending = abortableSleep(10_000, abort.signal);
    abort.abort();
    await expect(pending).rejects.toBeDefined();
  });
});
