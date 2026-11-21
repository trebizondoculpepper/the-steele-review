import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";

// #425: static audit of the prompt-file migration. Every Markdown prompt that
// source code references must exist, and every Markdown prompt must be
// referenced, so a renamed or orphaned file fails here, not at runtime.
const SRC = join(process.cwd(), "src");
const PROMPTS = join(SRC, "prompts");

function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return path.endsWith(ext) ? [path] : [];
  });
}

const sources = files(SRC, ".ts").map((f) => readFileSync(f, "utf8"));
const referenced = new Set<string>();
for (const source of sources) {
  // new URL("../prompts/<service>/<name>.md", import.meta.url)
  for (const m of source.matchAll(/prompts\/([a-z0-9-]+)\/([a-z0-9-]+)\.md/g)) {
    referenced.add(`${m[1]}/${m[2]}.md`);
  }
  // loadPromptFile("<service>", "<name>") and loadAnalysisPrompt("<name>")
  for (const m of source.matchAll(/loadPromptFile\(\s*"([a-z0-9-]+)",\s*"([a-z0-9-]+)",?\s*\)/g)) {
    referenced.add(`${m[1]}/${m[2]}.md`);
  }
  for (const m of source.matchAll(/loadAnalysisPrompt\(\s*"([a-z0-9-]+)",?\s*\)/g)) {
    referenced.add(`analysis/${m[1]}.md`);
  }
  // Writer prompts loaded by name: loadWriterPrompt("<name>")
  for (const m of source.matchAll(/loadWriterPrompt\(\s*"([a-z0-9-]+)",?\s*\)/g)) {
    referenced.add(`writer/${m[1]}.md`);
  }
}
const present = new Set(files(PROMPTS, ".md").map((f) => relative(PROMPTS, f)));

describe("prompt file inventory (#425)", () => {
  it("every referenced prompt file exists", () => {
    expect([...referenced].filter((p) => !present.has(p)).sort()).toEqual([]);
  });

  it("every prompt file is referenced by source code", () => {
    expect([...present].filter((p) => !referenced.has(p)).sort()).toEqual([]);
  });

  it("no prompt file is empty", () => {
    for (const p of present) {
      expect(readFileSync(join(PROMPTS, p), "utf8").trim().length, p).toBeGreaterThan(0);
    }
  });
});
