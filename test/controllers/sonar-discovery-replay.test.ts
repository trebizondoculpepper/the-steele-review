import { describe, expect, it } from "vite-plus/test";
import { replaySonarDiscovery } from "../../src/controllers/sonar-discovery-replay.js";

describe("Sonar retained-response replay", () => {
  it.each([
    ["stop", "completed", "valid"],
    ["length", "length-limit", "length-limit"],
    ["other", "unknown", "valid"],
  ] as const)("classifies %s inside the adapter", (finish_reason, completion, validation) => {
    const result = replaySonarDiscovery(
      JSON.stringify({
        model: "fixture/resolved",
        choices: [{ message: { content: "Retained report" }, finish_reason }],
        citations: ["https://source.example/a"],
        usage: { total_tokens: 12 },
        authorization: "excluded",
      }),
      "fixture/requested",
    );
    expect(result).toMatchObject({
      completion,
      validation,
      data: {
        report: "Retained report",
        model: "fixture/resolved",
        citations: ["https://source.example/a"],
        usage: { totalTokens: 12 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("excluded");
  });
  it("distinguishes malformed bytes from an invalid vendor envelope without network calls", () => {
    expect(replaySonarDiscovery("{", "fixture/requested")).toMatchObject({
      validation: "invalid-json",
      data: undefined,
    });
    expect(
      replaySonarDiscovery(
        JSON.stringify({ choices: [{ message: { content: 17 }, finish_reason: "stop" }] }),
        "fixture/requested",
      ),
    ).toMatchObject({ validation: "invalid-schema", completion: "completed", data: undefined });
  });
});
