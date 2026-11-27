// Bundles the steele-collections command into one file (#952).
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const outfile = fileURLToPath(new URL("./dist/steele-collections.mjs", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("../src/collections/bin.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile,
  legalComments: "none",
  // The Elasticsearch client is CommonJS; give the ESM bundle a require().
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
});
await chmod(outfile, 0o755);
