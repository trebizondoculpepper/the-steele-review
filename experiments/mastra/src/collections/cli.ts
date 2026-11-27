import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { ConfigError } from "../common/config/index.js";
import { GitRepository } from "../common/git/index.js";
import { installHook } from "./hook.js";
import { collectionIndexerFromEnv } from "./index.js";
import { collectionsRoot } from "./paths.js";
import type { ReconcileReport } from "./reconcile.js";

/**
 * `steele-collections`: the collection indexing command (#942, #952).
 *
 *   steele-collections reconcile [--rebuild DIR]... [--rebuild-all] [--json] [--quiet]
 *       One indexing pass over the collections repository. Safe to repeat: it
 *       applies everything committed since the last checkpoint, which is also
 *       the recovery command after a failed or missed pass.
 *   steele-collections install-hook [--repo PATH]
 *       Install the reference-transaction hook that runs `reconcile` after each
 *       branch update, with the current settings saved beside it.
 *
 * Settings come from the environment: STEELE_CONFIG_PATH (Elasticsearch
 * connection, see index.ts), STEELE_APP_DIR or STEELE_COLLECTIONS_ROOT,
 * STEELE_COLLECTIONS_CHECKPOINT, STEELE_INDEX_NAMESPACE.
 *
 * Exit status: 0 success, 1 the pass reported failures, 2 usage or
 * configuration error. Output never includes credentials or raw errors.
 */

const HOOK_SETTINGS = ["STEELE_CONFIG_PATH", "STEELE_APP_DIR", "STEELE_COLLECTIONS_ROOT", "STEELE_COLLECTIONS_CHECKPOINT", "STEELE_INDEX_NAMESPACE"];

export function summarise(report: ReconcileReport): string {
  const lines = [`head ${report.head ?? "(no commits)"}: ${report.ok ? "ok" : "incomplete"}`];
  for (const c of report.collections)
    lines.push(`  ${c.directory} -> ${c.alias} [${c.backing}] ${c.action}: ${c.indexed} indexed, ${c.deleted} deleted${c.failed.length ? `, ${c.failed.length} failed` : ""}`);
  for (const f of report.collections.flatMap((c) => c.failed)) lines.push(`    failed ${f.path}: ${f.reason}`);
  for (const r of report.rejected) lines.push(`  rejected ${r.directory}: ${r.reason}`);
  for (const d of report.removed) lines.push(`  removed from Git (index kept): ${d}`);
  return lines.join("\n");
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "reconcile") {
      const { values } = parseArgs({
        args: rest,
        strict: true,
        options: { rebuild: { type: "string", multiple: true }, "rebuild-all": { type: "boolean" }, json: { type: "boolean" }, quiet: { type: "boolean" } },
      });
      const indexer = collectionIndexerFromEnv(env);
      const report = await indexer.reconcile(values["rebuild-all"] ? "all" : values.rebuild);
      if (values.json) out.write(`${JSON.stringify(report, null, 2)}\n`);
      else if (!values.quiet || !report.ok) (report.ok ? out : err).write(`${summarise(report)}\n`);
      return report.ok ? 0 : 1;
    }
    if (command === "install-hook") {
      const { values } = parseArgs({ args: rest, strict: true, options: { repo: { type: "string" } } });
      const root = values.repo ?? collectionsRoot(env);
      if (!root) throw new UsageError("give --repo, or set STEELE_APP_DIR or STEELE_COLLECTIONS_ROOT");
      const settings: Record<string, string> = Object.fromEntries(HOOK_SETTINGS.map((k) => [k, env[k] ?? ""]));
      // The hook always indexes the repository it is installed in.
      settings.STEELE_COLLECTIONS_ROOT = resolve(root);
      // Saved paths are resolved now: the hook runs from Git's working directory, not this one.
      for (const key of ["STEELE_CONFIG_PATH", "STEELE_APP_DIR", "STEELE_COLLECTIONS_CHECKPOINT"])
        if (settings[key]) settings[key] = resolve(settings[key]!);
      const result = await installHook(new GitRepository(resolve(root)), settings);
      out.write(`${result.replaced ? "replaced" : "installed"} ${result.hookPath}\nsettings ${result.envFile}\n`);
      return 0;
    }
    throw new UsageError("usage: steele-collections reconcile [--rebuild DIR]... [--rebuild-all] [--json] [--quiet] | install-hook [--repo PATH]");
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError) {
      err.write(`steele-collections: ${error.message}\n`);
      return 2;
    }
    if (error instanceof Error && (error.name === "GitError" || error.message.startsWith("set ") || error.message.startsWith("refusing"))) {
      err.write(`steele-collections: ${error.message}\n`);
      return 2;
    }
    err.write("steele-collections: the pass failed unexpectedly; run it again, or see the logs\n");
    return 1;
  }
}

class UsageError extends Error {}
