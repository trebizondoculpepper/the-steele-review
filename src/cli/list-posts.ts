/**
 * Read-only inventory of captured posts (#186).
 *
 *   list-posts [--publication <id>] [--limit <n>] [--after <publication/post>]
 *              [--complete-only] [--json]
 *
 * Configuration (environment): STEELE_ARCHIVE_PATH, STEELE_ARCHIVE_REPOSITORY.
 * Prints post identity, title, public URL, publication date, completeness,
 * text length and capture method. Never prints filesystem paths, service
 * URLs or credentials, and never creates or modifies the archive.
 *
 * Exit: 0 listed (possibly empty); 1 archive unavailable; 2 invalid usage.
 */
import { z } from "zod";
import { MAX_INVENTORY_LIMIT, listCapturedPosts } from "../collection/inventory.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";

const USAGE =
  "Usage: list-posts [--publication <id>] [--limit <n>] [--after <publication/post>] [--complete-only] [--json]";

const EnvSchema = z.object({
  STEELE_ARCHIVE_PATH: z.string().min(1),
  STEELE_ARCHIVE_REPOSITORY: z.string().min(1),
});

export function parseListArgs(argv: string[]) {
  const out: {
    publicationId?: string;
    limit: number;
    after?: string;
    completeOnly: boolean;
    json: boolean;
  } = {
    limit: 50,
    completeOnly: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = argv[i + 1];
    if (a === "--complete-only") out.completeOnly = true;
    else if (a === "--json") out.json = true;
    else if (a === "--publication" && value && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) {
      out.publicationId = value;
      i++;
    } else if (
      a === "--limit" &&
      value &&
      /^\d+$/.test(value) &&
      +value >= 1 &&
      +value <= MAX_INVENTORY_LIMIT
    ) {
      out.limit = +value;
      i++;
    } else if (
      a === "--after" &&
      value &&
      /^[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9-]{0,299}$/.test(value)
    ) {
      out.after = value;
      i++;
    } else throw new Error(USAGE);
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  let args;
  try {
    args = parseListArgs(argv);
  } catch {
    console.error(USAGE);
    return 2;
  }
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`list-posts: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const archive = new GitArtifactStore({
    repoPath: env.data.STEELE_ARCHIVE_PATH,
    repository: env.data.STEELE_ARCHIVE_REPOSITORY,
  });
  let result;
  try {
    result = await listCapturedPosts(archive, args);
  } catch {
    console.error("list-posts: archive unavailable");
    return 1;
  }
  if (args.json) {
    console.log(
      JSON.stringify({ schemaVersion: 1, observedAt: new Date().toISOString(), ...result }),
    );
    return 0;
  }
  for (const p of result.posts) {
    const date = p.publishedAt?.slice(0, 10) ?? "date unknown";
    const state = p.complete ? "complete" : "INCOMPLETE";
    console.log(
      `${p.publicationId}/${p.postId}  ${date}  ${state}  ${p.textChars} chars  ${p.method}\n    ${p.title}\n    ${p.url}`,
    );
  }
  console.log(
    `${result.posts.length} post(s)${result.malformed.length ? `, ${result.malformed.length} unreadable record(s): ${result.malformed.map((m) => `${m.publicationId}/${m.postId}`).join(", ")}` : ""}`,
  );
  if (result.truncated) console.log(`More posts exist: rerun with --after ${result.next}`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
