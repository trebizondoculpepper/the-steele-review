import { defineConfig } from "vite-plus";

/**
 * Test harness configuration.
 *
 * Much of this suite drives real Git subprocesses, temporary repositories and,
 * in the CLI suites, repeated `tsx` compilations. Measured isolated durations
 * for those cases reach 1.6–29 seconds, while the runner default is 5 seconds,
 * so a loaded full run failed with "Test timed out in 5000ms" on tests that
 * passed alone (#777). Doubling the load reproduced the same timeouts across
 * the CLI, workflow and analysis suites, never assertion failures.
 *
 * A 60-second default gives those measured tests room without hiding a genuinely
 * hung one. Suites that need longer (`editorial-judge-recovery`,
 * `inspect-results`, the Git-backed dashboard cases) keep their explicit
 * timeouts.
 */
export default defineConfig({
  test: {
    testTimeout: 60_000,
  },
});
