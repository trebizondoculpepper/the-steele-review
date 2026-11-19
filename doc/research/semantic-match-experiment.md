# Semantic match experiment

**Status:** the harness exists and is tested with a deterministic toy embedder. **No real embedding provider has been run.** This note reports no real vectors, scores or findings; those wait until a configured provider runs on a bounded sample of captured text.

## Purpose

To show, on a small inspectable sample, what embedding similarity can and can't tell us. The experiment compares four labelled synthetic probes on one topic against captured passages:

- a claim
- a paraphrase
- a negation
- an evidence-backed correction

A keyword-overlap ranking runs alongside for comparison.

It's an educational experiment. Production hybrid retrieval belongs to #31, and the experiment doesn't block milestone one.

## How it works

`src/research/semantic-experiment.ts` (`runSemanticExperiment`, `renderExperimentReport`):

- **Reuse:** it uses the deterministic passage splitter (#27) and the embedding controller (#28). It doesn't add another embedding framework.
- **Bounds:** at most 20 sources, 200 passages and 12 probes, embedded in **one** controller call.
- **Recorded settings:** the report records the model's vector space, dimensions and chunking settings.
- **Probes:** marked `synthetic: true` and labelled `[SYNTHETIC <kind>]` in the report. They're embedded only in memory and never written to the archive or any index, so they can't contaminate the evidence corpus.
- **Passages:** quoted exactly, with origin (`monitored` publication text or `independent` research), source ID, URL and offsets.
- **Output:** the top passages per probe by cosine similarity and by keyword overlap, plus probe-to-probe similarity.

## What to expect, and why it matters

Semantic similarity is neither a truth probability nor logical entailment. A false assertion, its negation and its correction are about the same subject, so they can sit very close together in embedding space. The toy embedder in the tests ignores "not" completely, which makes the effect obvious; real models often only weaken it.

So a high-ranking passage is a **candidate to read**, never a statement to label true:

- **Retrieval surfaces candidates,** including potentially contradictory material.
- **The writing step** receives the candidate evidence, citations and the source claim.
- **Its prose** is then checked against that same evidence.

Monitored publication text and independent research stay distinguishable throughout. No separate contradiction classifier is planned.

Keyword overlap fails differently. It rewards shared vocabulary and misses paraphrase, and it has the same blind spot for negation and attribution: "X said the towers are dangerous" and "the towers are dangerous" share almost every word.

## Running it for real

This needs captured text and a configured embedding provider, both supplied through private configuration and neither committed here:

1. Choose a small sample of captured posts.
2. Write the four probes for a topic those posts actually cover.
3. Call `runSemanticExperiment` with an `EmbeddingController` for the configured provider.
4. Record the rendered report's public-safe observations here, especially about negation, attribution and same-topic, opposite-meaning matches, with the model and chunking identity it prints.
