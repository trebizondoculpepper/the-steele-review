# Start implementation and surface questions

We have retired the previous implementation and removed its source, tests and
deployment tooling from this working tree to start anew. The old work is safely
archived; retained documents are reference material, not instructions to rebuild
the old system. Its custom orchestration and dashboard accumulated complexity
without delivering the reliability and visibility the owner needed.

The new focus is to rely much more fully on an existing automation platform:
use its native orchestration, state, recovery, integrations and operational
interface wherever they meet our needs. Compare **n8n and Mastra** on the same
small flow: Save Us Now RSS → retained source content → one AI summary and
critique → an unpublished draft on the existing Substack destination. Both call
one narrow shared draft-publishing service. Keep manual triggers, historical
source-version reruns and visible content flow in scope. Do not recreate the
previous research/editorial machinery or custom dashboard for this experiment.

Work through the new n8n/Mastra experiment backlog using PDB. Start at
[#911](https://github.com/trebizondoculpepper/the-steele-review/issues/911),
which links all thirteen tickets (#911–#923).

1. Read `AGENTS.md`, `SECURITY.md`, the confirmed rebuild principles and
   `pdb rules`. Inspect the working tree before editing: the clean-slate reset
   is uncommitted. Preserve it. Do not resume retired tickets or services.
2. Quickly read **every experiment ticket**, its dependencies and existing
   discussion, including tickets you cannot claim yet. Review as much of the
   planned work as possible before getting absorbed in one implementation.
3. Put each genuine unanswered question **on the relevant ticket**. State the
   decision needed, why it matters, your recommendation and whether it blocks
   implementation. Use PDB's question/refinement workflow where applicable so
   blockers are visible. Do not invent questions or reopen settled decisions.
   Resolve ordinary implementation choices yourself within the agreed rules.
4. Claim an eligible ticket through PDB and start promptly. If a question blocks
   it, record the blocker and move to other available work. Do not wait for the
   entire backlog to be answered or interrupt the owner with each question.
5. Keep findings and decisions on their tickets. Recheck PDB as answers and
   dependencies change. Report a short list of question-bearing tickets and
   what you have started so the owner can review decisions together.

Use platform-native patterns, expose inputs/outputs and errors, and keep the
experiment bounded and draft-only. Apply the repository's architecture,
security, review and delivery requirements throughout.
