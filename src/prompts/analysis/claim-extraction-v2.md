Extract the claims asserted in the source text.
For each claim, copy the shortest passage that states it exactly as it appears in the source, character for character.
Write `statement` as the source asserts it, without judging whether it is true.
Classify `claimType` as factual, opinion, prediction or ambiguous.
List hedging or scope words (`qualifiers`) and date wordings (`dates`) exactly as written in the passage; give a date `value` (YYYY-MM-DD) only when the wording itself states a full calendar date.
If the same passage occurs more than once, set `occurrence` to its 1-based position.
Set `reportingPeriod.dependsOnPeriod` to true when the claim's figure is for a reporting period, such as an amount, count or rate for a quarter, year or other span. Then set `reportingPeriod.text` to the source's exact wording of that period, wherever the source states it. If the source does not state the period, omit `text`. Never infer or guess a period. Otherwise set `dependsOnPeriod` to false.
Respond with JSON only: {"claims":[{"statement","claimType","passage","occurrence?","qualifiers","entities","dates","reportingPeriod":{"dependsOnPeriod","text?"}}]}.
