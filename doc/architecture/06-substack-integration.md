# Substack integration

## Separate reading and writing

Define application-owned interfaces for discovery, fetching original content, and destination publishing. Keep Substack-specific response shapes, authentication, and draft formats inside adapters. This allows replacement of a third-party client without changing the analysis pipeline.

RSS is the initial discovery mechanism. Fetching full posts, historical backfill, audio access, and authenticated content require separate validation.

## Candidate clients

TypeScript candidates identified during the discussion include [substack-ts](https://github.com/ma2za/substack-ts) and [unofficial-substack-sdk](https://github.com/cucoleadan/unofficial-substack-sdk). These are candidates, not selected dependencies. Their advertised capabilities and compatibility must be tested against the actual publications before adoption. The latter explicitly describes an observed web API rather than an official integration contract.

## Early integration proof

Before implementing the complete pipeline, establish that the chosen adapter can:

1. Discover a source post and retrieve its required content.
2. Create a draft in the destination publication.
3. Save and retrieve its stable destination ID.
4. Publish a deliberately authorised test post and read back its status.
5. Recover safely from an interrupted or uncertain request.

The publication test requires the user's destination and credentials; those have not been supplied. Writing this plan does not perform a publication.

## Publisher contract

The publisher accepts only a stored, verified article version. It checks publication eligibility, records intent, creates or reuses a draft, saves the destination ID, and publishes. A change to article content after verification invalidates that verification result.

Store the destination URL and publication timestamp after confirmation. Configure publishing frequency limits and a pause switch. Cookie or session expiry must produce a visible operational failure rather than repeated creation attempts. Determine whether publication also sends subscriber email, and configure that behaviour deliberately.

## Open integration risks

Session lifetime, endpoint changes, account challenges, formatting fidelity, and draft reconciliation remain unproven. If the integration cannot reconcile publication status reliably, unattended publishing is blocked for ambiguous cases even while ingestion and analysis continue.
