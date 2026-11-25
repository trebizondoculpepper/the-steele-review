import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

/**
 * #918 setup proof: a trivial two-step workflow with no model calls and no
 * side effects. It shows that step inputs and outputs, an explicit error and
 * run history are visible in Studio and through the server API.
 */

const greet = createStep({
  id: "greet",
  inputSchema: z.object({ name: z.string().min(1).max(100), fail: z.boolean().default(false) }),
  outputSchema: z.object({ greeting: z.string(), fail: z.boolean() }),
  execute: async ({ inputData }) => ({
    greeting: `Hello, ${inputData.name}.`,
    fail: inputData.fail,
  }),
});

const measure = createStep({
  id: "measure",
  inputSchema: z.object({ greeting: z.string(), fail: z.boolean() }),
  outputSchema: z.object({ greeting: z.string(), characters: z.number().int(), words: z.number().int() }),
  execute: async ({ inputData }) => {
    if (inputData.fail) throw new Error("requested-failure: the caller asked this step to fail");
    return {
      greeting: inputData.greeting,
      characters: inputData.greeting.length,
      words: inputData.greeting.split(/\s+/).filter(Boolean).length,
    };
  },
});

export const helloWorkflow = createWorkflow({
  id: "hello",
  description: "Setup proof for #918: two visible steps, optional deliberate failure.",
  inputSchema: greet.inputSchema,
  outputSchema: measure.outputSchema,
})
  .then(greet)
  .then(measure)
  .commit();
