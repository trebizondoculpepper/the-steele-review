import { describe, expect, it } from "vite-plus/test";
import { inspectSettings, resolveSettings, SETTINGS } from "../../src/config/settings.js";
import { renderConfig } from "../../src/dashboard/config-view.js";

describe("read-only config page (#544)", () => {
  it("shows state and origin for every registered setting", () => {
    const html = renderConfig(inspectSettings(resolveSettings({} as NodeJS.ProcessEnv)));
    expect(html).toContain("<table>");
    for (const spec of SETTINGS) expect(html).toContain(spec.domain);
  });

  it("never renders a value for a non-public setting", () => {
    const secret = {
      key: "example.secret" as never,
      domain: "runtime" as const,
      description: "A private connection setting",
      sensitivity: "secret" as const,
      activation: "restart" as const,
      source: "environment" as const,
      state: "configured" as const,
      value: "should-not-render",
    };
    const html = renderConfig([secret]);
    expect(html).not.toContain("should-not-render");
    expect(html).toContain("configured");
  });

  it("escapes untrusted labels", () => {
    const html = renderConfig([
      {
        key: "<script>" as never,
        domain: "runtime" as const,
        description: "d",
        sensitivity: "public" as const,
        activation: "restart" as const,
        source: "environment" as const,
        state: "configured" as const,
      },
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
