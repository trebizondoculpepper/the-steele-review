# Inspecting saved theme and claim results

`inspect-post` shows everything saved for one post in the private content repository: theme proposals, accepted claims with their linked themes, exact quotations, locations and dates, refinement candidates with reasons, and rejected candidates with the reason and stage.

```sh
STEELE_PUBLICATION_ID=<publication> STEELE_CONTENT_PATH=<content repository path> STEELE_CONTENT_REPOSITORY=<logical name> \
  npm run inspect-post -- --post-id <slug> [--limit <n>] [--json]
```

The content repository path is private configuration; keep it in the private deployment notes.

- This is deliberate inspection of source content. Do not send its output to public logs; operational logs stay counts and codes only.
- Every saved result version is listed with its logical reference (short commit and repository path), model and prompt versions. A claim result linked to a theme result for different source text is flagged.
- "No saved theme or claim results" means nothing exists for that post. An empty result (for example zero themes) is shown as such.
- Each list is capped by `--limit` (default 50, maximum 500), and truncation is stated.
- Read-only: it never initialises or writes the repository, calls a model or sends events. Exit 0 when shown, 1 when the repository is unavailable, 2 for bad usage.
