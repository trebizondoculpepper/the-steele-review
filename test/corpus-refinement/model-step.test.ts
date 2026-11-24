import * as restate from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { ModelProviderError } from "../../src/controllers/openrouter.js";
import {
  callModel,
  loadStagePrompt,
  modelCallName,
  prepareRequest,
  type RecordedResponse,
} from "../../src/corpus-refinement/model-step.js";

// Fake adapter only: no paid model calls (#835).
const provider = {
  modelVersion: "fake/corpus-model",
  calls: [] as { system: string; user: string }[],
  fail: undefined as ModelProviderError | undefined,
  async complete(request: { system: string; user: string; maxOutputChars: number }) {
    this.calls.push({ system: request.system, user: request.user });
    if (this.fail) throw this.fail;
    return `{"ideas":[],"call":${this.calls.length}}`;
  },
};
const failAfterCallOnce = new Set<string>();
const prompt = loadStagePrompt("map-claims-to-ideas");

const probe = restate.workflow({
  name: "ModelStepProbe",
  handlers: {
    run: async (ctx: restate.WorkflowContext, input: { claims: string[] }) => {
      const request = prepareRequest(prompt, input);
      const first = await callModel(ctx, provider, modelCallName("map-claims-to-ideas"), request);
      const second = await callModel(
        ctx,
        provider,
        modelCallName("map-claims-to-ideas", "second"),
        request,
      );
      // A later failure (for example a save) after the calls were recorded.
      await ctx.run("after-call", async () => {
        if (failAfterCallOnce.delete(ctx.key)) throw new Error("synthetic later failure");
      });
      return { first, second } as { first: RecordedResponse; second: RecordedResponse };
    },
  },
});

let env: RestateTestEnvironment;
let ingress: clients.Ingress;
beforeAll(async () => {
  env = await RestateTestEnvironment.start(
    { services: [probe], serviceEndpointAccess: "docker-host" },
    () => new RestateContainer("1.8.1"),
  );
  ingress = clients.connect({ url: env.baseUrl() });
}, 240_000);
afterAll(async () => {
  await env?.stop();
});
const run = (key: string, input: { claims: string[] }) => {
  const wf = ingress.workflowClient<typeof probe>({ name: "ModelStepProbe" }, key);
  return wf.workflowSubmit(input).then(() => wf.workflowAttach());
};

describe("Corpus Refinement model step (#835)", { timeout: 120_000 }, () => {
  it("loads a feature prompt with a content-hash identity", () => {
    expect(prompt.version).toMatch(/^corpus-refinement-map-claims-to-ideas-sha256:[0-9a-f]{64}$/);
    expect(prompt.instructions).toContain("Return JSON only");
    expect(() => loadStagePrompt("../escape")).toThrow("invalid prompt name");
    expect(() => loadStagePrompt("no-such-prompt")).toThrow("prompt missing: no-such-prompt.md");
  });

  it("prepares requests from pinned data, recording the prompt identity", () => {
    const request = prepareRequest(prompt, { claims: ["a"] });
    expect(request).toMatchObject({
      system: prompt.instructions,
      user: '{"claims":["a"]}',
      promptVersion: prompt.version,
    });
  });

  it("makes one named durable call per request, and replay reuses the recorded response", async () => {
    provider.calls.length = 0;
    failAfterCallOnce.add("replay");
    const out = await run("replay", { claims: ["c1", "c2"] });
    // Two outbound requests, each made once, despite the later failure and retry.
    expect(provider.calls).toHaveLength(2);
    expect(out.first).toEqual({
      text: '{"ideas":[],"call":1}',
      promptVersion: prompt.version,
      model: "fake/corpus-model",
    });
    expect(out.second.text).toBe('{"ideas":[],"call":2}');
    expect(provider.calls[0]!.user).toBe('{"claims":["c1","c2"]}');
  });

  it("ends terminally on a provider failure that retrying cannot fix", async () => {
    provider.calls.length = 0;
    provider.fail = new ModelProviderError("bad-request", 400);
    try {
      await expect(run("terminal", { claims: ["x"] })).rejects.toThrow(
        /model call map-claims-to-ideas:model failed: bad-request/,
      );
      expect(provider.calls).toHaveLength(1);
    } finally {
      provider.fail = undefined;
    }
  });
});
