# Analysis and verification

## Analysis contract

Produce structured claims and themes before drafting prose. Each claim links to an exact source location and records whether it is a factual assertion, opinion, prediction, or ambiguous statement. Runtime schemas validate model responses; TypeScript types alone do not validate external output.

Historical analysis supplies cited comparisons. Independent research supplies evidence about the factual claims. Findings may be supported, contradicted, unsupported, or unresolved. Lack of evidence is not by itself proof of falsity.

## Drafting

The article briefly summarises the source fairly, identifies its main themes, addresses specific claims using evidence, and includes relevant historical context. Avoid asserting motives or personal misconduct without supporting evidence. Preserve the distinction between quotations, paraphrases, and the system's interpretation.

Version prompts and store the model/provider identifier, generation parameters where relevant, input source versions, retrieved evidence, and output. These records support diagnosis and deliberate reprocessing.

## Automated verification

Verification is a separate stage from writing. Use deterministic checks where possible and model-assisted checks for semantic questions. A second model opinion alone does not establish correctness.

Before publishing, check:

- Quotations match archived text or adequately verified audio.
- Each material factual criticism has evidence that supports the actual wording.
- Links, dates, source identities, and historical comparisons are consistent.
- The draft represents the source's qualifications and context accurately.
- Partial extraction or uncertain transcription does not undermine the argument.
- The article has not already been published for the same source and editorial purpose.

Passing checks enables automatic publication. Failed or inconclusive checks may trigger bounded research or revision attempts; after the configured limit, mark the article skipped and record specific reasons. Attempt limits, costs, and acceptance rules remain to be defined. A model's self-reported confidence is not a sufficient acceptance rule.

## Untrusted source material

Fetched posts and research pages are data, not operational instructions. Their contents cannot change prompts, credentials, tool permissions, or publication rules. Keep the publisher separate from research tooling and validate the structured artifact it receives.

## Deferred capabilities

A human approval queue is deferred. Skipped items remain inspectable through stored records and logs. A correction workflow for already published articles still needs design; retaining source and evidence versions makes it possible.
