# Designer clarification prompt

A designer clarification prompt is a Markdown brief that the owner pastes straight to the designer to unblock work. An implementer writes one at the end of a block of work, whenever some items need clarification and others are waiting on a precondition. The owner asks for it by name: "designer clarification prompt".

The aim: if the designer acts on every item in the prompt, nothing the implementer could pick up is left blocked.

## When to write one

- The pdb queue has no claimable item, and every ready ticket waits on another ticket, a question, a review or a missing status.
- Several open PRs are waiting for review and are holding up dependent tickets.
- The owner asks for one.

## How to build it

1. **Find what's blocked.** For each `status:ready` ticket that pdb refuses, read its open native blockers. Follow each chain to its root: the ticket or PR whose state is what actually blocks it.
2. **Read each root's state.** Check its status label, its open question, any review findings, its assignee, and whether a PR delivers it.
3. **Classify the action each root needs:**
   - **Automatic.** The designer can act alone, by changing a label, reviewing and merging a PR, recording a refinement, or giving a short answer from what they already know.
   - **Human.** Needs the owner: a decision only the owner can make (spend, publishing, infrastructure or image changes), or something done by hand, such as creating a reference draft in a browser.
4. **Order roots by how much they unblock.** Count the tickets downstream of each, so the first action does the most good.
5. **Write each item so it can be acted on alone.** Include the ticket or PR number and title, the exact action, the options with a recommendation where there's a choice, and what it unblocks. Quote any question already posted on the ticket instead of restating it loosely.
6. **Keep it public-safe.** Name tickets, PRs, labels and configuration variable names, never private hosts, paths, credentials or deployment observations.

## Template

```markdown
# Designer clarification prompt: <repository> (<date>)

You are the designer for <repository>. The implementer `<agent>` has no claimable work.
Act on each item below, then record it in pdb (`pdb question resolve`, status labels,
review sign-off or merge). Where an item says Human, pass it to the owner with the
options shown. Do not remove a dependency to unblock work unless it is genuinely wrong;
if it is, say why.

## 1. Automatic: reviews and merges (unblocks N tickets)
- **PR #<n> (#<ticket>): <title>.** <state of review findings>. Action: review and merge,
  or request changes. Unblocks: <chain>.

## 2. Automatic: status, triage and short answers
- **#<ticket>: <title>.** <why it is stuck>. Action: <exact label change or answer>.
  Unblocks: <chain>.

## 3. Human: owner decisions and manual steps
- **#<ticket>: <title>.** <the question as posted>. Options: (A, recommended) …; (B) …
  Unblocks: <chain>.

## Expected result
<which tickets become claimable, and in what order>
```
