import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  MESSAGES,
  STREAMS,
  registryProblems,
  renderRegistryReference,
  streamName,
} from "../../src/events/registry.js";

describe("stream and message registry", () => {
  it("is consistent", () => {
    expect(registryProblems()).toEqual([]);
  });

  it("keeps existing deployed stream names and the analysis destination", () => {
    expect(STREAMS.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        "STEELE_DISCOVERY",
        "STEELE_CONTENT",
        "STEELE_ANALYSIS",
        "STEELE_RESEARCH",
      ]),
    );
    expect(MESSAGES.find((m) => m.subject === "steele.v1.post.analysed")?.stream).toBe(
      "STEELE_ANALYSIS",
    );
  });

  it("catches missing mappings, overlaps and bad names", () => {
    const streams = [
      {
        name: "STEELE_A",
        overrideEnv: "A",
        purpose: "a",
        subjects: ["steele.v1.a.done", "steele.v1.b.done"],
      },
      { name: "steele_bad", overrideEnv: "B", purpose: "b", subjects: ["steele.v1.a.done"] },
    ];
    const messages = [
      { subject: "steele.v1.a.done", stream: "STEELE_A", producer: "x", description: "x" },
      { subject: "Bad.Subject", stream: null, producer: "x", description: "x" },
    ];
    const problems = registryProblems(streams, messages).join("\n");
    expect(problems).toContain("captured by both");
    expect(problems).toContain("does not follow STEELE_");
    expect(problems).toContain("steele.v1.b.done has no message definition");
    expect(problems).toContain("Bad.Subject does not follow");
    const twice = registryProblems(
      [
        { name: "STEELE_A", overrideEnv: "A", purpose: "a", subjects: ["steele.v1.a.done"] },
        { name: "STEELE_A", overrideEnv: "A", purpose: "a", subjects: ["steele.v1.b.done"] },
      ],
      [
        { subject: "steele.v1.a.done", stream: "STEELE_A", producer: "x", description: "x" },
        { subject: "steele.v1.b.done", stream: "STEELE_A", producer: "x", description: "x" },
      ],
    );
    expect(twice.join()).toContain("defined twice");
  });

  it("records the event type of every message with a published contract", () => {
    expect(MESSAGES.filter((m) => !m.eventType)).toEqual([]);
  });

  it("honours a configured stream override", () => {
    const def = STREAMS.find((s) => s.name === "STEELE_ANALYSIS")!;
    expect(streamName(def, { STEELE_ANALYSIS_STREAM: "CUSTOM" })).toBe("CUSTOM");
    expect(streamName(def, {})).toBe("STEELE_ANALYSIS");
    expect(() => streamName(def, { STEELE_ANALYSIS_STREAM: "" })).toThrow("non-empty");
  });

  it("matches the checked-in generated reference", () => {
    const saved = readFileSync("doc/architecture/generated/streams-and-messages.md", "utf8");
    expect(saved, "run npm run events:reference").toBe(renderRegistryReference());
  });

  it("requires every streamed message to state when it is emitted and what consumers can rely on", () => {
    const streams = [{ name: "STEELE_A", overrideEnv: "A", purpose: "a", subjects: ["steele.v1.a.done"] }];
    const bare = [{ subject: "steele.v1.a.done", stream: "STEELE_A", producer: "x", description: "x" }];
    expect(registryProblems(streams, bare).join()).toContain("does not state when it is emitted");
    const full = [{ ...bare[0], emittedWhen: "a happens", guarantees: "stable ID" }];
    expect(registryProblems(streams, full)).toEqual([]);
  });
});
