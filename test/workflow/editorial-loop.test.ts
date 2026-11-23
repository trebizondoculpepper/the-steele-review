import { ArtifactStoreError } from "../../src/controllers/artifact-store.js";
import { describe, expect, it, vi } from "vite-plus/test";
import { runEditorialLoop } from "../../src/workflow/editorial-loop.js";
import {
  DEFAULT_EDITORIAL_POLICY,
  type EditorialStages,
  type EditorialHistory,
} from "../../src/workflow/editorial-contract.js";
const ref = (path: string) => ({
  repository: "content",
  commit: "a".repeat(40),
  path,
  sha256: "b".repeat(64),
});
function fixture(alwaysRevise = false) {
  let clock = 0,
    assessed = 0,
    judged = 0,
    revised = 0,
    approved = 0;
  const stages: EditorialStages = {
    prepare: async (draft) => ({ draft, metadata: ref(draft.path + ".json") }),
    assess: async () => ({ ref: ref(`assessments/${++assessed}.json`), state: "no-faults" }),
    judge: async () => ({
      ref: ref(`judgments/${++judged}.json`),
      state: "decided",
      decision: alwaysRevise || judged === 1 ? "revise" : "approve",
    }),
    revise: async () => ({
      version: {
        draft: ref(`articles/revision${++revised}.md`),
        metadata: ref(`articles/revision${revised}.json`),
      },
      mechanicalRun: ref(`mechanical/${revised}.json`),
    }),
    approve: async () => {
      approved++;
      return { eventId: "one-approval" };
    },
  };
  const journal = new Map<string, unknown>();
  let crashAfter: string | undefined;
  const step = async <T>(name: string, work: () => Promise<T>) => {
    if (journal.has(name)) return journal.get(name) as T;
    const value = await work();
    journal.set(name, value);
    if (name === crashAfter) {
      crashAfter = undefined;
      throw new Error("synthetic post-journal crash");
    }
    return value;
  };
  let saved: Omit<EditorialHistory, "summary"> | undefined;
  const args = {
    stages,
    policy: DEFAULT_EDITORIAL_POLICY,
    draft: ref("articles/initial.md"),
    package: ref("packages/one.json"),
    sourceUrl: "https://source.example/post",
    attemptId: "fixture-request",
    now: async () => clock,
    step,
    progress: async () => {},
    save: async (value: Omit<EditorialHistory, "summary">) => {
      saved = value;
      return ref("editorial-loops/summary.json");
    },
  };
  return {
    args,
    stages,
    journal,
    crash: (name: string) => {
      crashAfter = name;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    counts: () => ({ assessed, judged, revised, approved }),
    saved: () => saved,
  };
}
describe("versioned journaled editorial loop", () => {
  it("threads the same explicit recovery token into revision writer work", async () => {
    const f = fixture();
    const revise = vi.spyOn(f.stages, "revise");
    await runEditorialLoop({ ...f.args, recoveryId: "dashboard-recovery-fixture" });
    expect(revise.mock.calls[0]?.[5]).toBe("dashboard-recovery-fixture");
  });
  it("replays committed assessment/judgment/revision steps without duplicate paid work or approval", async () => {
    const f = fixture();
    f.crash("editorial-assess-0");
    await expect(runEditorialLoop(f.args)).rejects.toThrow("post-journal");
    const completed = await runEditorialLoop(f.args);
    expect(completed.history.terminal).toBe("approved");
    expect(f.counts()).toEqual({ assessed: 2, judged: 2, revised: 1, approved: 1 });
    expect(completed.history.assessments).toHaveLength(2);
    expect(completed.history.judgments).toHaveLength(2);
    await runEditorialLoop(f.args);
    expect(f.counts()).toEqual({ assessed: 2, judged: 2, revised: 1, approved: 1 });
  });
  it("passes only exact earlier reviewed versions and judgments to the next journaled judge", async () => {
    const f = fixture(),
      judge = vi.spyOn(f.stages, "judge");
    await runEditorialLoop(f.args);
    expect(judge.mock.calls[0]?.[3]).toEqual([]);
    expect(judge.mock.calls[1]?.[3]).toEqual([
      {
        judgment: {
          ...ref("judgments/1.json"),
          hash: `sha256:${"b".repeat(64)}`,
          sha256: undefined,
        },
        assessment: {
          ...ref("assessments/1.json"),
          hash: `sha256:${"b".repeat(64)}`,
          sha256: undefined,
        },
        body: {
          ...ref("articles/initial.md"),
          hash: `sha256:${"b".repeat(64)}`,
          sha256: undefined,
        },
        metadata: {
          ...ref("articles/initial.md.json"),
          hash: `sha256:${"b".repeat(64)}`,
          sha256: undefined,
        },
      },
    ]);
    await runEditorialLoop(f.args);
    expect(judge).toHaveBeenCalledTimes(2);
  });
  it("keeps every pass and an unresolved stop after the bounded editorial revisions", async () => {
    const f = fixture(true);
    const out = await runEditorialLoop(f.args);
    expect(out.history.terminal).toBe("unresolved");
    expect(f.counts()).toEqual({ assessed: 3, judged: 3, revised: 2, approved: 0 });
    expect(f.saved()?.initial.draft.path).toBe("articles/initial.md");
    expect(f.saved()?.mechanicalRuns).toHaveLength(2);
  });
  it.each(["assess", "judge"])(
    "records a credit operational stop at %s with its failed attempt reference",
    async (phase) => {
      const f = fixture();
      const no = vi.fn(async () => ({ eventId: "never" }));
      f.stages.approve = no;
      if (phase === "assess")
        f.stages.assess = async () => ({
          ref: ref("assessments/credit-failed.json"),
          state: "provider-failed",
          operationalFailure: "credit-exhausted",
        });
      else
        f.stages.judge = async () => ({
          ref: ref("judgments/credit-failed.json"),
          state: "provider-failed",
          decision: "none",
          operationalFailure: "credit-exhausted",
        });
      const out = await runEditorialLoop(f.args);
      expect(out.history.terminal).toBe("operational-stop");
      expect(out.reason).toContain("credit-exhausted");
      expect(out.history.assessments).toHaveLength(1);
      expect(out.history.judgments).toHaveLength(phase === "judge" ? 1 : 0);
      expect(no).not.toHaveBeenCalled();
    },
  );
  it("keeps a returned assessment when the shared deadline stops the next paid step", async () => {
    const f = fixture();
    f.args.policy = { ...DEFAULT_EDITORIAL_POLICY, deadlineMs: 1000 };
    f.stages.assess = async () => {
      f.advance(1001);
      return { ref: ref("assessments/returned.json"), state: "findings" };
    };
    const out = await runEditorialLoop(f.args);
    expect(out.history.terminal).toBe("deadline");
    expect(out.history.assessments).toHaveLength(1);
    expect(out.history.judgments).toHaveLength(0);
  });
  it("does not confuse failed mechanical correction with another editorial judgment", async () => {
    const f = fixture();
    f.stages.revise = async () => ({
      failure: "mechanical-limit",
      mechanicalRun: ref("mechanical/failed.json"),
      diagnostics: [ref("diagnostics/one.json")],
    });
    const out = await runEditorialLoop(f.args);
    expect(out.history.terminal).toBe("operational-stop");
    expect(out.history.judgments).toHaveLength(1);
    expect(out.history.mechanicalRuns).toHaveLength(1);
    expect(out.history.diagnostics).toHaveLength(1);
  });
  it("does not count an initial assessment as reused when the new window already expired", async () => {
    const f = fixture();
    const out = await runEditorialLoop({
      ...f.args,
      initialAssessment: ref("saved-assessment.json"),
      lineage: { intent: ref("recovery-intent.json"), parentSummary: ref("failed-parent.json") },
      deadlineAt: 0,
    });
    expect(out.history.terminal).toBe("deadline");
    expect(out.history.assessments).toEqual([]);
    expect(out.history.reusedAssessments).toEqual([]);
    expect(out.history.assessments.length - out.history.reusedAssessments!.length).toBe(0);
    expect(f.counts()).toEqual({ assessed: 0, judged: 0, revised: 0, approved: 0 });
  });
  it("propagates new-path typed storage failure instead of caching a terminal review failure", async () => {
    const f = fixture();
    f.stages.judge = async () => {
      throw new ArtifactStoreError("git-failed");
    };
    await expect(
      runEditorialLoop({
        ...f.args,
        initialAssessment: ref("saved-assessment.json"),
        lineage: { intent: ref("recovery-intent.json"), parentSummary: ref("failed-parent.json") },
      }),
    ).rejects.toMatchObject({ code: "git-failed" });
    expect(f.saved()).toBeUndefined();
    expect(f.counts()).toEqual({ assessed: 0, judged: 0, revised: 0, approved: 0 });
  });
});

describe("explicit live-policy editorial contract", () => {
  const observation = (maxRevisions: number, onExhausted: "stop" | "create-unpublished-draft") => ({
    version: "live-editorial-policy-v1" as const,
    revision: "config-sha256:" + "a".repeat(32),
    policy: { ...DEFAULT_EDITORIAL_POLICY, maxRevisions, onExhausted },
  });
  it("applies a changed exhaustion action at the next decision without another revision", async () => {
    const f = fixture(true);
    let current = observation(1, "stop");
    const judge = f.stages.judge;
    f.stages.judge = async (...args) => {
      const result = await judge(...args);
      if (f.counts().judged === 2) current = observation(1, "create-unpublished-draft");
      return result;
    };
    const authorize = vi.fn(async () => ({ eventId: "draft-only-event" }));
    const result = await runEditorialLoop({
      ...f.args,
      livePolicy: { read: async () => current, authorize },
    });
    expect(f.counts()).toEqual({ assessed: 2, judged: 2, revised: 1, approved: 0 });
    expect(result.history.terminal).toBe("unresolved");
    expect(result.draftAuthorizationEvent).toBe("draft-only-event");
    expect(authorize.mock.calls).toHaveLength(1);
    expect(result.history.policyObservations).toHaveLength(6);
    current = observation(0, "stop");
    await runEditorialLoop({ ...f.args, livePolicy: { read: async () => current, authorize } });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(f.counts().revised).toBe(1);
  });
  it("applies a reduced revision limit and stop at the next decision", async () => {
    const f = fixture(true);
    let current = observation(3, "create-unpublished-draft");
    const judge = f.stages.judge;
    f.stages.judge = async (...args) => {
      const result = await judge(...args);
      current = observation(0, "stop");
      return result;
    };
    const authorize = vi.fn(async () => ({ eventId: "never" }));
    const result = await runEditorialLoop({
      ...f.args,
      livePolicy: { read: async () => current, authorize },
    });
    expect(result.history.terminal).toBe("unresolved");
    expect(f.counts()).toEqual({ assessed: 1, judged: 1, revised: 0, approved: 0 });
    expect(authorize).not.toHaveBeenCalled();
  });
  it("authorizes only a draft on initial approval when draft mode is active, preserving verdict", async () => {
    const f = fixture();
    f.stages.judge = async () => ({
      ref: ref("judgments/approved.json"),
      state: "decided",
      decision: "approve",
    });
    const authorize = vi.fn(async () => ({ eventId: "draft-only-event" }));
    const result = await runEditorialLoop({
      ...f.args,
      livePolicy: { read: async () => observation(1, "create-unpublished-draft"), authorize },
    });
    expect(result.history.terminal).toBe("approved");
    expect(result.approvalEvent).toBeUndefined();
    expect(result.draftAuthorizationEvent).toBe("draft-only-event");
    expect(f.counts().revised).toBe(0);
    expect(f.counts().approved).toBe(0);
  });
  it("never treats provider failure as exhaustion or drafts after invalid live configuration", async () => {
    const f = fixture(true);
    f.stages.judge = async () => ({
      ref: ref("judgments/failed.json"),
      state: "provider-failed",
      decision: "none",
    });
    const authorize = vi.fn(async () => ({ eventId: "never" }));
    const result = await runEditorialLoop({
      ...f.args,
      livePolicy: { read: async () => observation(0, "create-unpublished-draft"), authorize },
    });
    expect(result.history.terminal).toBe("operational-stop");
    expect(authorize).not.toHaveBeenCalled();
    const fresh = fixture(true);
    await expect(
      runEditorialLoop({
        ...fresh.args,
        livePolicy: {
          read: async () => {
            throw new Error("configuration unavailable");
          },
          authorize,
        },
      }),
    ).rejects.toThrow("configuration unavailable");
    expect(fresh.counts().assessed).toBe(0);
    expect(authorize).not.toHaveBeenCalled();
  });
  it("refuses a delayed fresh revision after its live allowance was reduced without a model call", async () => {
    const f = fixture(true);
    let current = observation(1, "create-unpublished-draft");
    let writerCalls = 0;
    f.stages.revise = async (...args) => {
      current = observation(0, "stop");
      await args[7]!();
      writerCalls++;
      throw new Error("unreachable writer");
    };
    const authorize = vi.fn(async () => ({ eventId: "never" }));
    const result = await runEditorialLoop({
      ...f.args,
      livePolicy: { read: async () => current, now: () => 0, authorize },
    });
    expect(result.history.terminal).toBe("operational-stop");
    expect(result.reason).toBe("live-policy-policy-changed");
    expect(writerCalls).toBe(0);
    expect(result.history.revisions).toHaveLength(0);
    expect(authorize).not.toHaveBeenCalled();
  });
  it("journals a fixed deadline refusal before delayed paid dispatch, without losing the control category", async () => {
    const f = fixture(true);
    let calls = 0;
    f.stages.assess = async (...args) => {
      await args[5]!();
      calls++;
      return { ref: ref("never.json"), state: "no-faults" };
    };
    const authorize = vi.fn(async () => ({ eventId: "never" }));
    const result = await runEditorialLoop({
      ...f.args,
      livePolicy: {
        read: async () => ({
          ...observation(1, "create-unpublished-draft"),
          policy: { ...observation(1, "create-unpublished-draft").policy, deadlineMs: 1000 },
        }),
        now: () => 2000,
        authorize,
      },
    });
    expect(result.reason).toBe("live-policy-deadline");
    expect(result.history.terminal).toBe("operational-stop");
    expect(result.history.assessments).toHaveLength(0);
    expect(calls).toBe(0);
    expect(authorize).not.toHaveBeenCalled();
  });
});

describe("legacy clock journal and fresh live deadline boundaries", () => {
  it.each([undefined, 1000])(
    "preserves the historical step/clock sequence with deadlineAt=%s",
    async (deadlineAt) => {
      const f = fixture();
      const trace: string[] = [];
      await runEditorialLoop({
        ...f.args,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        now: async () => {
          trace.push("clock");
          return 0;
        },
        step: async (name, work) => {
          trace.push(name);
          return work();
        },
      });
      expect(trace).toEqual([
        ...(deadlineAt === undefined ? ["clock"] : []),
        "editorial-prepare",
        "clock",
        "editorial-assess-0",
        "clock",
        "editorial-judge-0",
        "clock",
        "editorial-revise-1",
        "clock",
        "editorial-assess-1",
        "clock",
        "editorial-judge-1",
        "clock",
        "editorial-record-approval",
        "editorial-save-summary",
      ]);
    },
  );
  it.each(["assessment", "judgment"])(
    "uses a deadline extension made during %s before deciding that time expired",
    async (phase) => {
      const f = fixture(true);
      let deadlineMs = 1000;
      const read = async () => ({
        version: "live-editorial-policy-v1" as const,
        revision: "config-sha256:" + "a".repeat(32),
        policy: {
          ...DEFAULT_EDITORIAL_POLICY,
          maxRevisions: 0,
          deadlineMs,
          onExhausted: "stop" as const,
        },
      });
      const advance = () => {
        f.advance(1500);
        deadlineMs = 5000;
      };
      if (phase === "assessment") {
        const original = f.stages.assess;
        f.stages.assess = async (...args) => {
          const result = await original(...args);
          advance();
          return result;
        };
      } else {
        const original = f.stages.judge;
        f.stages.judge = async (...args) => {
          const result = await original(...args);
          advance();
          return result;
        };
      }
      const result = await runEditorialLoop({
        ...f.args,
        livePolicy: {
          read,
          authorize: async () => {
            throw new Error("stop mode");
          },
        },
      });
      expect(result.history.terminal).toBe("unresolved");
      expect(f.counts().judged).toBe(1);
      expect(result.history.policyObservations?.at(-1)?.policy.deadlineMs).toBe(5000);
    },
  );
  it("applies a shortened current deadline before starting the next judge", async () => {
    const f = fixture(true);
    let deadlineMs = 5000;
    const original = f.stages.assess;
    f.stages.assess = async (...args) => {
      const result = await original(...args);
      f.advance(1500);
      deadlineMs = 1000;
      return result;
    };
    const result = await runEditorialLoop({
      ...f.args,
      livePolicy: {
        read: async () => ({
          version: "live-editorial-policy-v1",
          revision: "config-sha256:" + "a".repeat(32),
          policy: { ...DEFAULT_EDITORIAL_POLICY, maxRevisions: 0, deadlineMs, onExhausted: "stop" },
        }),
        authorize: async () => {
          throw new Error("deadline stop");
        },
      },
    });
    expect(result.history.terminal).toBe("deadline");
    expect(f.counts().judged).toBe(0);
  });
});

describe("publish after one completed correction cycle (#820)", () => {
  const cycleFixture = (alwaysRevise: boolean) => {
    const f = fixture(alwaysRevise);
    let released = 0;
    f.stages.approveCompletedCycle = async () => {
      released++;
      return { eventId: "one-release" };
    };
    return { ...f, released: () => released };
  };
  const onePass = {
    ...DEFAULT_EDITORIAL_POLICY,
    maxRevisions: 1,
    onExhausted: "publish-after-cycle" as const,
  };

  it("releases a run whose single correction cycle completed with the judge still revising", async () => {
    const f = cycleFixture(true);
    const out = await runEditorialLoop({ ...f.args, policy: onePass });
    expect(f.counts()).toMatchObject({ judged: 2, revised: 1, approved: 0 });
    expect(f.released()).toBe(1);
    expect(f.saved()).toMatchObject({ terminal: "unresolved" });
    expect(out.approvalEvent).toBe("one-release");
    expect(out.reason).toMatch(/completed cycle released for publication/);
    expect(f.journal.has("editorial-release-completed-cycle")).toBe(true);
    // A replay reuses the journaled release: never a second one.
    await runEditorialLoop({ ...f.args, policy: onePass });
    expect(f.released()).toBe(1);
  });

  it("uses the ordinary approval when the judge approves, never a cycle release", async () => {
    const f = cycleFixture(false);
    await runEditorialLoop({ ...f.args, policy: onePass });
    expect(f.counts().approved).toBe(1);
    expect(f.released()).toBe(0);
  });

  it("never releases a run without a completed cycle, or under another policy", async () => {
    // No revision allowed: no correction cycle ever completed.
    const none = cycleFixture(true);
    await runEditorialLoop({ ...none.args, policy: { ...onePass, maxRevisions: 0 } });
    expect(none.released()).toBe(0);
    // The default stop policy never releases.
    const stop = cycleFixture(true);
    await runEditorialLoop({
      ...stop.args,
      policy: { ...DEFAULT_EDITORIAL_POLICY, maxRevisions: 1 },
    });
    expect(stop.released()).toBe(0);
    // A failed revision is an operational stop, never a release.
    const failed = cycleFixture(true);
    failed.stages.revise = async () => ({ failure: "writer-failed" });
    await runEditorialLoop({ ...failed.args, policy: onePass });
    expect(failed.released()).toBe(0);
    expect(failed.saved()).toMatchObject({ terminal: "operational-stop" });
  });
});
