import { describe, expect, it } from "vite-plus/test";
import { explainTrace, renderExplanation } from "../../src/dashboard/trace-explain.js";

type Input = Parameters<typeof explainTrace>[0];
const base: Input = {
  summary: "completed",
  editorial: "verified",
  stages: [
    { stage: "capture", state: "done" },
    { stage: "themes", state: "done" },
  ],
  research: [],
};

describe("article trace explanation (#525)", () => {
  it("says what is running and what to do next", () => {
    const e = explainTrace({
      ...base,
      summary: "pending",
      editorial: "none",
      stages: [
        { stage: "capture", state: "done" },
        { stage: "research", state: "pending" },
      ],
    });
    expect(e.status).toMatch(/research stage is in progress/);
    expect(e.next).toMatch(/Wait for the stage to finish/);
  });

  it("never calls a rejected verification a success", () => {
    const e = explainTrace({ ...base, editorial: "rejected" });
    expect(e.status).toMatch(/verification rejected the draft/);
    expect(e.status).toMatch(/not a success/);
    expect(e.next).toMatch(/Request a revision/);
  });

  it("distinguishes approval recorded from merely verified", () => {
    expect(explainTrace({ ...base }).status).toBe("Verified and approved.");
    expect(explainTrace({ ...base, approvalRecorded: true }).status).toMatch(
      /approval was recorded for delivery/,
    );
  });

  it("reports an evidence gap as a gap, not a failure", () => {
    const e = explainTrace({ ...base, editorial: "evidence-gap" });
    expect(e.status).toMatch(/evidence gap/);
    expect(e.next).toMatch(/Commission or supply the missing research/);
  });

  it("gives the exact stopping reason for a failed run", () => {
    const e = explainTrace({
      ...base,
      summary: "failed",
      editorial: "none",
      reason: "claims: credit-exhausted",
      stages: [{ stage: "claims", state: "failed", detail: "provider credit" }],
    });
    expect(e.status).toMatch(/Failed/);
    expect(e.stoppedReason).toBe("claims: provider credit");
    // Recovery is not offered unless the action actually supports this failure.
    expect(e.next).toMatch(/Recovery is not available/);
    expect(
      explainTrace({
        ...base,
        summary: "failed",
        editorial: "none",
        reason: "claims: credit-exhausted",
        stages: [{ stage: "claims", state: "failed", detail: "claims: credit-exhausted" }],
        recoveryAvailable: true,
      }),
    ).toMatchObject({ stoppedReason: "claims: credit-exhausted" });
  });

  it("does not present an unreadable state as a stopped process", () => {
    const e = explainTrace({ ...base, summary: "unknown", editorial: "none" });
    expect(e.status).toMatch(/State unknown/);
    expect(e.next).toMatch(/not evidence that the run stopped/);
  });

  it("escapes rendered text", () => {
    const html = renderExplanation(
      explainTrace({ ...base, summary: "failed", editorial: "none", reason: "<script>x</script>" }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
