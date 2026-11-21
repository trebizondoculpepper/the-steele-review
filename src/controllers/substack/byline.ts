import { normalisePostAuthor } from "../../content/substack-item.js";

/** Only an explicit single byline can identify one author-voice speaker.
 * Do not pick the first coauthor or guess from a publication/user identifier.
 */
export function postByline(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const entry: unknown = value[0];
  return entry && typeof entry === "object" && "name" in entry
    ? normalisePostAuthor(entry.name)
    : undefined;
}
