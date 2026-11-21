import { createHash } from "node:crypto";

/**
 * Identity of a model-facing prompt (#430): its semantic version plus a hash
 * of the exact text sent to the model. Editing a Markdown prompt without
 * changing the version still changes the identity, so cached drafts,
 * redrafts and verifications made under older wording are never reused.
 * Only the hash is recorded: no prompt text reaches identities or logs.
 */
export function promptIdentity(version: string, instructions: string): string {
  const hash = createHash("sha256").update(instructions, "utf8").digest("hex").slice(0, 16);
  return `${version}+sha256:${hash}`;
}
