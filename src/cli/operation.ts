/**
 * Read-only inspection of one recorded operation (#173).
 *
 *   operation <operation-key> [--json]
 *
 * Configuration (environment): STEELE_STATE_PATH, the absolute path of the
 * application's SQLite state file. Read-only: never opens a writable
 * connection, migrates, claims, refreshes a lease, reopens, replays or
 * acknowledges. Output is allowlisted: no owner, payload, physical path or raw
 * exception text.
 *
 * Exit: 0 inspected, including a failed operation (its domain status is shown);
 * 1 not-found or state unavailable; 2 invalid invocation or missing
 * configuration.
 */
import { stateProbeFor } from "../diagnostics/runtime-status.js";
import {
  inspectOperation,
  operationExitCode,
  parseOperationArguments,
  renderOperation,
} from "../diagnostics/operation-detail.js";

const USAGE = "Usage: operation <operation-key> [--json]";

async function main(argv: string[]): Promise<number> {
  const parsed = parseOperationArguments(argv);
  if (!parsed.ok) {
    console.error(USAGE);
    return 2;
  }
  if (parsed.args.help) {
    console.log(USAGE);
    return 0;
  }
  const key = parsed.args.key;
  if (key === undefined) {
    console.error(USAGE);
    return 2;
  }
  const statePath = process.env.STEELE_STATE_PATH;
  if (!statePath) {
    console.error("operation: missing configuration: STEELE_STATE_PATH");
    return 2;
  }
  const report = await inspectOperation(stateProbeFor(statePath), key);
  console.log(parsed.args.json ? JSON.stringify(report) : renderOperation(report));
  return operationExitCode(report);
}

process.exitCode = await main(process.argv.slice(2));
