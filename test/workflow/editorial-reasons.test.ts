import { describe, expect, it } from "vite-plus/test";
import { safeContinuationReason } from "../../src/content/editorial-continuation-contract.js";
import { safeJudgeRecoveryReason } from "../../src/content/editorial-judge-recovery-contract.js";

describe("editorial public failure reasons", () => {
  it.each([
    ["saved-feedback continuation", safeContinuationReason],
    ["judge recovery", safeJudgeRecoveryReason],
  ] as const)(
    "preserves application formatting failures in %s without accepting raw errors",
    (_name, sanitise) => {
      expect(sanitise("application-format-failed")).toBe("application-format-failed");
      expect(sanitise("unsupported markdown: synthetic untrusted source text")).toBe(
        "stage-stopped",
      );
      expect(sanitise("malformed-output")).toBe("malformed-output");
    },
  );
});
