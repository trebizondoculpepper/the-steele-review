# Model prompt inventory (#425, for #238)

This is the state of every model-facing prompt after the migration slices (#421–#424), checked against the code rather than inferred from file existence. Prompts live under `src/prompts/<service>/`, one Markdown file per prompt (#237). The shared loader `src/prompt-files.ts` adds a content hash to each prompt's identity, so editing a file changes the cache keys and the `promptVersion` saved with new results. Older results keep their recorded identity.

## Checks

- **Static:** `test/prompts/inventory.test.ts` requires every referenced prompt file to exist, every prompt file to be referenced, and no prompt to be empty.
- **Missing files:** `test/analysis/prompt-files.test.ts` covers missing and empty files. The loader fails with the prompt's name, never its filesystem path.
- **Compiled build:** `npm run build` copies `src/prompts` to `dist/prompts`. All 18 prompt-loading modules imported successfully from `dist/` (checked 2026-11-21).
- **Container:** the runtime image copies `dist`, prompts included, from the build stage.
- **Stale reuse:** package drafts, redrafts and verifications key on the content-hashed identity (#430). The librarian prompts now use the shared loader (this change).

## Complete: loaded from Markdown, with a content-hashed identity

| Stage                                  | Prompt file                                                              | Loaded by                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Theme proposals                        | `analysis/theme-proposals-v2.md`                                         | `analysis/theme-proposals.ts`                                                  |
| Theme catalogue                        | `analysis/theme-catalogue-v2.md`                                         | `analysis/theme-catalogue.ts`                                                  |
| Theme extraction (legacy)              | `analysis/theme-extraction-v1.md`                                        | `analysis/theme-extraction.ts`                                                 |
| Grounded claims                        | `analysis/grounded-claims-v6.md`                                         | `analysis/grounded-claims.ts`                                                  |
| Claim extraction (legacy)              | `analysis/claim-extraction-v1.md`                                        | `analysis/extraction.ts`                                                       |
| Claim equivalence                      | `analysis/claim-equivalence-v1.md`                                       | `analysis/claim-equivalence.ts`                                                |
| Historical comparison                  | `analysis/historical-comparison-v1.md`                                   | `analysis/historical-comparison.ts`                                            |
| Same-speaker matching                  | `librarian/same-speaker-match.md`                                        | `analysis/same-speaker-history.ts`                                             |
| Speaker evolution                      | `librarian/speaker-evolution.md`                                         | `analysis/speaker-evolution.ts`                                                |
| Cross-speaker parallels                | `librarian/cross-speaker-parallel.md`                                    | `analysis/cross-speaker-parallels.ts`                                          |
| Research applicability                 | `research/applicability-v1.md`                                           | `research/applicability.ts`                                                    |
| Research query plan                    | `research/query-plan-v1.md`                                              | `research/query-plan.ts`                                                       |
| Gap research                           | `research/gap-research-v1.md`                                            | `research/gap-research.ts`                                                     |
| Draft writer (legacy)                  | `writer/explainer.md`, `writer/explainer-with-source.md`                 | `drafting/draft.ts`                                                            |
| Draft verifier (legacy)                | `verifier/draft-verifier-v1.md`, `verifier/draft-verifier-context-v1.md` | `drafting/verify.ts`                                                           |
| Package writer                         | `writer/package-explainer.md`                                            | `drafting/package-draft.ts` (identity from `drafting/prompt-identity.ts`)      |
| Package redraft                        | `writer/package-revision.md`                                             | `drafting/package-draft.ts` (identity from `drafting/prompt-identity.ts`)      |
| Package verifier                       | `verifier/package-verifier.md`                                           | `drafting/package-verify.ts` (identity from `drafting/prompt-identity.ts`)     |
| Article assessor (findings only, #598) | `verifier/article-assessor.md`                                           | `drafting/article-assessment.ts` (identity from `drafting/prompt-identity.ts`) |

## Remaining

| Prompt                         | Where                                                       | Gap                                                                                  |
| ------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Support judge system prompt    | `research/support-judge.ts` (`SYSTEM`)                      | Inline in TypeScript; not editable as Markdown and not hashed into an identity.      |
| Sonar research system prompt   | `research/runner.ts` (`researchPrompt`)                     | Inline. Research job identity covers the request, not this wording.                  |
| Research-subject system prompt | `controllers/sonar.ts`                                      | Inline, used by the `research-subject` CLI.                                          |
| Transcription prompts          | `transcription/english.md`, `transcription/english-user.md` | Loaded from Markdown, but transcripts don't record a content-hashed prompt identity. |

Fixed framing lines in user messages, such as the boundary-token line, are part of the data binding and stay in TypeScript by design. Their meaning is stated in each Markdown prompt.
