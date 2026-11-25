# Rebuild principles

Status: confirmed by the owner on 25 November 2026. This document governs the clean-slate rebuild. The earlier implementation is archived under Git tag `archive/pre-rebuild-2026-11-25`. Existing architecture, research and operations documents are retained as historical reference; their implementation-specific choices do not select the replacement platform or imply that the archived system is running.

## Purpose and minimum demonstration

Automatically review and respond to conspiracy-theory content. Multiple sources feed durable original-content storage. Newly identified content triggers a writing workflow. Saved articles can be delivered through multiple publisher adapters. Prove a single observable source-to-unpublished-draft path before expanding the editorial machinery. Normal operation is autonomous; inspection and intervention are available without requiring routine human checkpoints.

No replacement platform has been selected. Evaluate candidates against the whole intake-to-delivery path, artifact inspection, recovery and operating cost. Prefer an existing operational interface to a custom dashboard.

## Confirmed architectural principles

1. **Follow the platform's native patterns.** Understand its execution, state, deployment, recovery and visibility model first. Use its supported mechanisms; add custom orchestration, queues, state stores or dashboards only for an identified gap with a documented reason.
2. **Keep the outer workflow predictable.** Define explicit intake, storage, writing and delivery stages. Agents perform bounded tasks inside those stages; autonomy does not require a model to control every handoff.
3. **Make visibility part of the minimum demonstration.** From the first run, expose each stage's status, inputs, outputs or artifact references, duration and model cost when available. Make failures and stopping reasons inspectable. Use the platform's interface where it suffices.
4. **Save progress and resume safely.** Preserve original content and source provenance. Keep durable, versioned stage outputs with stable identities and clear handoff contracts. Recovery should reuse completed paid work. Deduplicate delivery and reconcile uncertain external outcomes before retrying.
5. **Represent partial results explicitly.** Distinguish incomplete material, work not attempted, unsupported claims and technical failures. Pass useful partial material onward with warnings; absence of research is not proof a claim is false. Storage or integrity failures need visible recovery.
6. **Bound autonomous work.** Apply explicit budgets, deadlines and correction limits. Define the outcome when a limit is reached. Keep retry behavior and delivery authority explicit and inspectable. The replacement's editorial release policy remains to be specified.
7. **Prove recovery early.** Exercise interruption, restart, duplicate delivery and partial dependency failure as well as the successful end-to-end path. Add complexity only when it demonstrably improves the result.

## Boundaries that remain in force

Keep external integrations behind clear adapters, validate external inputs, and treat fetched content and model output as untrusted. Separate editorial content from internal operational commentary. Never leak private configuration or credentials. Canonical configuration remains the authority; do not create copied key files or application configuration caches. Preserve independent evidence separately from assertions in monitored material.

## Supporting guidance

These project rules are our application of the sources, rather than a claim that a platform guarantees the editorial outcome.

- [Anthropic: Building effective agents](https://www.anthropic.com/research/building-effective-agents): simple composable workflows, bounded autonomy and measured evaluation.
- [Restate: Key concepts](https://docs.restate.dev/foundations/key-concepts): durable execution and platform-managed state and communication. This is supporting guidance, not a platform selection.
- [Temporal: Pre-production testing](https://docs.temporal.io/best-practices/pre-production-testing): observability and recovery testing under partial failure.
