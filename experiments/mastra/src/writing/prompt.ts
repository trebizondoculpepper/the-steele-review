import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * The shared, version-controlled writing prompt (#911 contract). It is loaded
 * from `experiments/shared/prompts/` at run time (the image ships that
 * directory exactly as committed), never copied into this track.
 * Identity: `<id>@sha256:<hash of the file bytes>`.
 */

export interface WritingPrompt {
  id: string;
  identity: string;
  system: string;
  userTemplate: string;
}

export function sharedDir(): string {
  return process.env.STEELE_EXP_SHARED_DIR ?? fileURLToPath(new URL("../../../shared/", import.meta.url));
}

export function loadWritingPrompt(name = "summary-critique-v1"): WritingPrompt {
  const bytes = readFileSync(join(sharedDir(), "prompts", `${name}.md`));
  const text = bytes.toString("utf8");
  const id = /^id:\s*(\S+)/m.exec(text)?.[1];
  const system = /^# System\n([\s\S]*?)\n# User\n/m.exec(text)?.[1]?.trim();
  const userTemplate = /^# User\n([\s\S]*)$/m.exec(text)?.[1]?.trim();
  if (!id || !system || !userTemplate) throw new Error(`prompt ${name} is malformed`);
  return { id, identity: `${id}@sha256:${createHash("sha256").update(bytes).digest("hex")}`, system, userTemplate };
}

/** Fills `{{source.*}}` placeholders. Values are inserted as data inside the prompt's <source> block. */
export function renderUser(template: string, source: { title: string; medium: string; publishedAt: string | null; text: string }): string {
  const values: Record<string, string> = {
    "source.title": source.title,
    "source.medium": source.medium,
    "source.publishedAt": source.publishedAt ?? "unknown",
    // A source cannot close the untrusted block early.
    "source.text": source.text.replaceAll("</source>", "<\\/source>"),
  };
  return template.replace(/\{\{(source\.[a-zA-Z]+)\}\}/g, (_m, key: string) => {
    if (!(key in values)) throw new Error(`unknown placeholder ${key}`);
    return (values[key] ?? "").replaceAll("</source>", "<\\/source>");
  });
}
