# The Steele Review architecture

The Steele Review monitors selected Substack publications, archives and indexes their content, and automatically publishes evidence-based criticism to a separate Substack publication. Historical coverage helps explain recurring themes, changing narratives, and inconsistencies in specific claims.

## Document map

| Document                                                           | Theme                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| [System overview](01-system-overview.md)                           | Scope, boundaries, and event flow                           |
| [Ingestion and archiving](02-ingestion-and-archiving.md)           | Detection, extraction, audio, and historical imports        |
| [Storage and retrieval](03-storage-and-retrieval.md)               | Elasticsearch, source records, and historical comparison    |
| [Analysis and verification](04-analysis-and-verification.md)       | Research, drafting, automated checks, and skips             |
| [Events and reliability](05-events-and-reliability.md)             | NATS subjects, retries, idempotency, and workflow state     |
| [Substack integration](06-substack-integration.md)                 | Reading, authenticated publishing, and reconciliation       |
| [Runtime and operations](07-runtime-and-operations.md)             | TypeScript tooling, Docker, Raspberry Pi, and observability |
| [Decisions and open questions](08-decisions-and-open-questions.md) | Agreed direction and unresolved implementation details      |
| [Suggested software choices](09-software-choices.md)               | Candidate libraries and workflow tooling to evaluate        |

These documents capture the architecture discussion, not a claim that the system is implemented. “Proposed” choices are implementation recommendations awaiting validation; agreed direction is listed in the decisions document.

See [processing stages](10-processing-stages.md) for the agreed collection-through-publication flow and proof-of-concept boundaries.

See the [implementation preparation brief](11-implementation-brief.md) for the ticket map, readiness and unresolved live-integration inputs.

See [failure handling](12-failure-handling.md) for retry ownership, error classification and JetStream delivery limits.

The [milestone sequence](13-milestones.md) is the current acceptance scope. See [search indices and claim timelines](14-search-indices-and-timeline.md) for content, claims, research and passage boundaries. Technical investigations live in [doc/research](../research/README.md).
See the [manual research and drafting demo](15-manual-research-demo.md) for the agreed three-post acceptance slice, epic hierarchy and small delivery contracts.

See [runtime diagnostic CLI](16-diagnostic-cli.md) for the incremental troubleshooting-tool principle and initial read-only command contracts.
