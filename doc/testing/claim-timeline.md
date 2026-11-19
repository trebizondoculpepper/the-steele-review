# Claim timeline report

`npm run claim-timeline -- <filters>` prints the observed timeline and speaker frequency of one claim, grouping or theme, read from the claim-occurrence index. It's a query over occurrences, not another source of truth.

## Usage

```sh
ELASTICSEARCH_URL=... npm run claim-timeline -- --statement "The towers are watching everyone."
npm run claim-timeline -- --theme surveillance --publication example-pub --from 2026-01-01T00:00:00Z --to 2026-06-30T23:59:59Z --bucket month
npm run claim-timeline -- --grouping-key sha256:... --speaker "Dr Synthetic" --json
```

You need one of `--statement` (normalised into a grouping key), `--grouping-key`, `--claim-id` or `--theme`. Optional filters: `--publication`, `--speaker`, `--speaker-kind` (`author-voice`, `quoted`, `unknown`, `uncertain`), `--from` and `--to` (inclusive ISO timestamps), `--bucket` (`month` or `year`) and `--limit` (at most 50). `STEELE_CLAIM_OCCURRENCE_INDEX` overrides the default index alias.

## Reading the report

- **Occurrences and distinct posts** are counted separately, over unique occurrence IDs, so reprocessing never inflates either count.
- **Earliest and latest observed** use the post publication date. They aren't the date a claim was first made.
- **Undated occurrences** are listed with "date unknown" and counted separately. A date range excludes them.
- **Speakers** are shown as indexed. "unknown speaker" means the source gives no evidence, and the report never fills it in.
- **Sources:** each occurrence shows its URL, exact passage, and archive reference with span.
- **Truncated** means the bounded query hit its limit and more occurrences may exist.
- **Coverage:** every report ends with a reminder that it covers the collected corpus only.

## Tests

`test/analysis/claim-timeline.test.ts` covers repeated claims, two speakers, quote attribution, unknown speakers and dates, date boundaries and truncation. Its Elasticsearch case runs when `STEELE_TEST_ES_URL` is set (see `scripts/es-test-server.sh`).
