import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { proposeThemes } from "../../src/analysis/theme-proposals.js";
import { ModelProviderError } from "../../src/controllers/openrouter.js";
import { articleViews, isCreditBlocked, renderTrace } from "../../src/dashboard/article-views.js";
import { summariseRun } from "../../src/dashboard/articles.js";
import { postCorrelationId } from "../../src/observability/post-correlation.js";
import {
  CONDITION_WARNING_WINDOW_MS,
  isCreditExhausted,
  reportCreditExhausted,
  resetConditionWarnings,
} from "../../src/observability/provider-condition.js";

afterEach(() => {
  resetConditionWarnings();
  vi.restoreAllMocks();
});

const post = { publicationId: "pub", postId: "p1" };

describe("provider credit exhaustion (#407)", () => {
  it("records every occurrence locally but warns Sentry at most once per stage per window", () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((l: string) => void lines.push(l));
    let t = 0;
    const now = () => t;
    expect(reportCreditExhausted(post, "claims", undefined, now).warned).toBe(true);
    expect(reportCreditExhausted(post, "claims", undefined, now).warned).toBe(false);
    expect(reportCreditExhausted(post, "draft", undefined, now).warned).toBe(true);
    t = CONDITION_WARNING_WINDOW_MS + 1;
    expect(reportCreditExhausted(post, "claims", undefined, now).warned).toBe(true);
    const conditions = lines.filter((l) => l.includes("provider.condition"));
    expect(conditions).toHaveLength(4);
    expect(JSON.parse(conditions[0]!)).toEqual({
      event: "provider.condition",
      correlation_id: postCorrelationId(post),
      stage: "claims",
      outcome: "credit-exhausted",
    });
  });

  it("stops a model stage at once instead of retrying or calling it a provider failure", async () => {
    let calls = 0;
    const provider = {
      modelVersion: "fake/m",
      complete: async () => {
        calls++;
        throw new ModelProviderError("credit-exhausted", 402);
      },
    };
    const store = {
      write: vi.fn(),
      lookup: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
    };
    const error = await proposeThemes({
      provider,
      artifacts: store as never,
      post,
      source: {
        text: "A post.",
        sourceVersion: `sha256:${"1".repeat(64)}`,
        artifact: {
          repository: "a",
          commit: "a".repeat(40),
          path: "p.json",
          hash: `sha256:${"b".repeat(64)}`,
        },
      },
      maxAttempts: 3,
    }).catch((e: unknown) => e);
    expect(isCreditExhausted(error)).toBe(true);
    expect(calls).toBe(1);
  });

  it("shows an actionable, secret-free dashboard warning", async () => {
    const result = {
      outcome: "failed" as const,
      reason: "claims: credit-exhausted",
      research: [] as [],
    };
    expect(isCreditBlocked(result.reason)).toBe(true);
    expect(isCreditBlocked("claims: provider-failed")).toBe(false);
    const html = renderTrace({
      post,
      correlationId: postCorrelationId(post),
      ...summariseRun({ state: "finished", result }),
      receipts: [],
      receiptsTruncated: false,
    });
    expect(html).toContain("Provider credit exhausted");
    expect(html).toContain("not a finding about any article");
    const [list] = articleViews({
      articles: {
        recent: async () => [{ ...post, sourceVersion: `sha256:${"1".repeat(64)}` }],
        find: async () => undefined,
      },
      runs: { status: async () => ({ state: "finished", result }) },
    });
    const page = await list!.render(new URL("http://x/articles"));
    expect(page).toContain("1 recent run stopped");
    expect(page).toContain('<span class="s-credit-exhausted">credit-exhausted</span>');
  });
});
