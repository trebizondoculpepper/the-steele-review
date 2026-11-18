pdb rules: the represented policy, compiled to English from its Datalog clauses
Policy: version 1, rulesHash 0e25b69a67ff95c6f4c0d9e0a6b6fae00769f7e6c434439c76c12e615b27a471
Sources: policy/schema.edn, policy/rules.edn, policy/ordering.edn, policy/queries.edn, policy/decisions.edn (bundled; English model 2)
Scope: Complete represented policy: every decision rule, denial, ordering rule, query and predicate in the bundled artifact.
Effective policy: the shipped default only (project preferences disabled: rules.project.enabled is false)
See also: pdb process prints the short workflow guide; pdb rules prints the compiled policy. Neither replaces the other.
Reading: ?t is the ticket or pull request, ?r a decision rule; name(?x) is a predicate defined in the glossary; "no match for" means no fact matches, which is not proof of the opposite.

== Defaults ==
Bundled defaults (declared by pdb, not read from any repository):
  briefing.engine = "datalog"  (repository setting registry)
  complexity.enabled = true  (repository setting registry)
  impact.enabled = true  (repository setting registry)
  review.policy = null  (repository setting registry)
  rules.project.enabled = false  (repository setting registry)
  processGuide = false  (repository setting registry)
  --role = "implementer"  (briefing, when --role is omitted)
  --order = "impact"  (briefing, when --order is omitted)
  --platform = ""  (briefing, when --platform is omitted; the viewer platform is then unknown)
This repository's effective settings: unknown. pdb rules reads no project configuration, so this repository's effective settings are not known here and are not assumed to equal the defaults. Use pdb config list inside the project.

== Decision rules (38) ==
Each rule proposes its action for every ?t its conditions match.

Band 1
  D-ATTENTION: action addressed-response; preference 0; codes addressed
    When all of:
      - foreground(?t)
      - open(?t)
      - addressed(?t)
    Evidence shown:
      addressedAgent (rule): the viewer's agent name is ?value and ?t has agent whose attention is requested ?value
  D-HUMAN-ASK-YOU: action answer-questions; preference 0; codes explicit, addressed
    When all of:
      - foreground(?t)
      - the viewer's role is "human"
      - open-question(?t)
      - asks-viewer(?t)
    Evidence shown:
      routedTo (rule): asking-record(?t, ?r) and ?r's addressee is ?value
  D-HUMAN-ORPHANED-YOU: action orphaned-question; preference 1; codes explicit, addressed
    When all of:
      - foreground(?t)
      - the viewer's role is "human"
      - orphan-asks-viewer(?t)
    Evidence shown:
      routedTo (rule): orphaned-record(?t, ?r) and ?r's addressee is ?value

Band 2
  D-PR-FAIL: action pr-follow-up; preference 0; codes pr-follow-up, pr-failed-checks
    When all of:
      - foreground(?t)
      - pr-action(?t)
      - pr-failure(?t)
    Evidence shown:
      failedChecks (rule): ?t has check run ?c and ?c's name is ?name and ?c's outcome is ?o and ?o is in the constant set "failure" and ?value is the text joining ?name, ":", ?o
  D-PR-REVIEW: action pr-follow-up; preference 0; codes pr-follow-up, pr-review-findings
    When all of:
      - foreground(?t)
      - pr-action(?t)
      - pr-review(?t)
    Evidence shown:
      reviewDecision (rule): ?t's review decision is ?value
      unresolvedThreads (rule): ?t has review thread ?c and ?c's resolved flag is false and ?value is the text "unresolved"
  D-PR-CONFLICT: action pr-follow-up; preference 1; codes pr-follow-up, pr-conflicts
    When all of:
      - foreground(?t)
      - pr-action(?t)
      - ?t's mergeability is "CONFLICTING"
    Evidence shown:
      mergeable (rule): ?t's mergeability is ?value
  D-PR-MERGE: action pr-follow-up; preference 2; codes pr-follow-up, pr-inspect-merge
    When all of:
      - foreground(?t)
      - pr-action(?t)
      - clean-pr(?t)
    Evidence shown:
      requiredChecksComplete (rule): ?t's completeness of target required-check evidence is ?value
      complete (rule): ?t's completeness of pull request evidence is ?value
      draft (rule): ?t's draft flag is ?value
      mergeState (rule): ?t has merge state ?value
  D-PR-INTEGRATE: action pr-follow-up; preference 3; codes pr-follow-up, pr-integrate
    When all of:
      - foreground(?t)
      - pr-action(?t)
      - integrate-pr(?t)
    Evidence shown:
      mergeable (rule): ?t's mergeability is ?value
      mergeState (rule): ?t has merge state ?value
      requiredChecksComplete (rule): ?t's completeness of target required-check evidence is ?value

Band 3
  D-DECIDE: action decide; preference 0; codes designer-duty
    When all of:
      - foreground(?t)
      - the viewer's role is "designer"
      - ?t has label "design:decision-needed"
    Evidence shown:
      decisionLabel (rule): ?t has label "design:decision-needed" and ?value is the text "design:decision-needed"
  D-OWN-RESUME: action resume-claim; preference 0; codes own-claim, resume-required
    When all of:
      - foreground(?t)
      - the viewer's role is "implementer"
      - own-issue(?t)
      - ?t's activity of your retained claim (active, waiting, resume-required or unknown) is "resume-required"
    Evidence shown:
      waitReason (rule): ?t's what your retained claim waits on, or why its activity is unknown is ?value
  D-HUMAN-ASK: action answer-questions; preference 0; codes explicit
    When all of:
      - foreground(?t)
      - the viewer's role is "human"
      - open-question(?t)
      - no match for: asks-viewer(?t)
    Evidence shown:
      routedTo (rule): asking-record(?t, ?r) and ?r's addressee is ?value
  D-HUMAN-ORPHANED: action orphaned-question; preference 0; codes explicit
    When all of:
      - foreground(?t)
      - the viewer's role is "human"
      - has-orphaned(?t)
      - no match for: orphan-asks-viewer(?t)
    Evidence shown:
      routedTo (rule): orphaned-record(?t, ?r) and ?r's addressee is ?value
  D-DOCUMENT: action document; preference 1; codes designer-duty
    When all of:
      - foreground(?t)
      - the viewer's role is "designer"
      - ?t has label "design:documentation-needed"
    Evidence shown:
      documentationLabel (rule): ?t has label "design:documentation-needed" and ?value is the text "design:documentation-needed"
  D-REVIEW-OWNED: action review-owned-work; preference 1; codes own-claim, review-owned-work
    When all of:
      - foreground(?t)
      - the viewer's role is "implementer"
      - the context records the claim the owned-work review is attached to ?t
      - own-issue(?t)
      - the context records number of implementation claims you retain ?n
      - ?n > 1
      - the context records completeness of your claim inventory true
    Evidence shown:
      ownedClaims (rule): the context records number of implementation claims you retain ?value
  D-REVIEW-OWNED-PARTIAL: action review-owned-work; preference 1; codes own-claim, review-owned-work, inspection
    When all of:
      - foreground(?t)
      - the viewer's role is "implementer"
      - the context records the claim the owned-work review is attached to ?t
      - own-issue(?t)
      - the context records number of implementation claims you retain ?n
      - ?n > 1
      - the context records completeness of your claim inventory false
    Evidence shown:
      ownedClaims (rule): the context records number of implementation claims you retain ?value
  D-HUMAN-UNVERIFIED: action decide; preference 1; codes inferred
    When all of:
      - foreground(?t)
      - the viewer's role is "human"
      - open-unrecorded(?t)
      - unverified-record(?t)
    Evidence shown:
      questionLabel (rule): ?t has label ?value and ?value is in the constant set "question-label"
  D-HUMAN-ORPHANED-UNKNOWN: action orphaned-question; preference 1; codes explicit, resolution-unknown
    When all of:
      - foreground(?t)
      - the viewer's role is "human"
      - has-orphan-unknown(?t)
    Evidence shown:
      routedTo (rule): orphan-unknown(?t, ?r) and ?r's addressee is ?value
  D-DESIGN-REVIEW: action design-review; preference 2; codes designer-duty
    When all of:
      - foreground(?t)
      - the viewer's role is "designer"
      - design-pr(?t)
      - no match for: own-follow-up(?t)
    Evidence shown:
      designEvidence (rule): at least one of (joined on ?t, ?value): (1) ?t has label ?value and ?value is in the constant set "design-label"; (2) ?t has issue it closes ?i and ?i has label ?value and ?value is in the constant set "design-label"
  D-OWN-UNKNOWN: action inspect; preference 2; codes own-claim, inspection
    When all of:
      - foreground(?t)
      - the viewer's role is "implementer"
      - own-issue(?t)
      - ?t's activity of your retained claim (active, waiting, resume-required or unknown) is "unknown"
    Evidence shown:
      waitReason (rule): ?t's what your retained claim waits on, or why its activity is unknown is ?value
  D-HUMAN-DECIDE: action decide; preference 2; codes inferred
    When all of:
      - foreground(?t)
      - the viewer's role is "human"
      - open-unrecorded(?t)
    Evidence shown:
      questionLabel (rule): ?t has label ?value and ?value is in the constant set "question-label"
  D-INVENTORY-UNKNOWN: action inspect-ownership; preference 3; codes inspection, inventory-unknown
    When all of:
      - foreground(?t)
      - the viewer's role is "implementer"
      - ?t's repository ownership inventory context is true
      - the context records number of implementation claims you retain 0
      - the context records completeness of your claim inventory false
  D-OWNED-INCOMPLETE: action inspect; preference 3; codes own-claim, inspection
    When all of:
      - foreground(?t)
      - the viewer's role is "implementer"
      - the context records the claim the owned-work review is attached to ?t
      - own-issue(?t)
      - the context records number of implementation claims you retain 1
      - the context records completeness of your claim inventory false
  D-HUMAN-SIGNOFF: action sign-off; preference 3; codes inferred
    When all of:
      - foreground(?t)
      - the viewer's role is "human"
      - open(?t)
      - accepted-pr(?t)
      - clean-pr(?t)

Band 4
  D-EASY: action implement; preference 0; codes easy-win
    When all of:
      - foreground(?t)
      - the viewer's role is "implementer"
      - eligible(?t)
      - easy(?t)
      - the viewer's requested order is "impact"
    Declared override: D-EASY wins over D-ORDINARY when both match.
  D-OWN-EASY: action continue-implementation; preference 0; codes easy-win, own-claim
    When all of:
      - foreground(?t)
      - the viewer's role is "implementer"
      - own-active(?t)
      - easy(?t)
    Declared override: D-OWN-EASY wins over D-OWN when both match.

Band 5
  D-COMPLEXITY-BOOST: action estimate-complexity; preference 0; codes assessment, cross-role-boost
    When all of:
      - foreground(?t)
      - the viewer's role is "implementer"
      - issue(?t)
      - needs-complexity(?t)
      - large-impact(?t)
  D-IMPACT-BOOST: action assess-impact; preference 0; codes assessment, cross-role-boost
    When all of:
      - foreground(?t)
      - the viewer's role is "designer"
      - issue(?t)
      - needs-impact(?t)
      - small-complexity(?t)
  D-COMPLEXITY: action estimate-complexity; preference 1; codes assessment
    When all of:
      - foreground(?t)
      - the viewer's role is "implementer"
      - issue(?t)
      - needs-complexity(?t)
  D-IMPACT: action assess-impact; preference 1; codes assessment
    When all of:
      - foreground(?t)
      - the viewer's role is "designer"
      - issue(?t)
      - needs-impact(?t)
  D-BAD-COMPLEXITY: action inspect-assessment; preference 1; codes assessment, inspection
    When all of:
      - foreground(?t)
      - the viewer's role is "implementer"
      - issue(?t)
      - bad-complexity(?t)
  D-BAD-IMPACT: action inspect-assessment; preference 1; codes assessment, inspection
    When all of:
      - foreground(?t)
      - the viewer's role is "designer"
      - issue(?t)
      - bad-impact(?t)

Band 6
  D-ORDINARY: action implement; preference 0; codes ordinary
    When all of:
      - foreground(?t)
      - the viewer's role is "implementer"
      - eligible(?t)
    Declared override: D-EASY, D-UNFAVORABLE win(s) over D-ORDINARY when both match.
  D-OWN: action continue-implementation; preference 0; codes ordinary, own-claim
    When all of:
      - foreground(?t)
      - the viewer's role is "implementer"
      - own-active(?t)
    Declared override: D-OWN-EASY, D-OWN-UNFAVORABLE win(s) over D-OWN when both match.
  D-DESIGN: action design; preference 0; codes ordinary
    When all of:
      - foreground(?t)
      - the viewer's role is "designer"
      - design-eligible(?t)
    Evidence shown:
      designLabel (rule): ?t has label "status:needs-design" and ?value is the text "status:needs-design"
  D-INSPECT: action inspect; preference 0; codes ordinary, inspection
    When all of:
      - foreground(?t)
      - issue(?t)
      - possible(?t)
      - uncertain(?t)
      - the viewer's role is ?role
      - ?role is not "human"
    Evidence shown:
      uncertainty (rule): at least one of (joined on ?t, ?value): (1) ?t's completeness of label evidence is false and ?value is the text "labels incomplete"; (2) ?t's completeness of native dependency evidence is false and ?value is the text "native dependencies incomplete"; (3) (no match for: closing-complete(?t)) and ?value is the text "closing PR evidence incomplete"; (4) platform-unknown(?t) and ?value is the text "viewer platform unknown"

Band 7
  D-UNFAVORABLE: action implement; preference 0; codes unfavorable
    When all of:
      - foreground(?t)
      - the viewer's role is "implementer"
      - eligible(?t)
      - unfavorable(?t)
      - the viewer's requested order is "impact"
    Declared override: D-UNFAVORABLE wins over D-ORDINARY when both match.
  D-OWN-UNFAVORABLE: action continue-implementation; preference 0; codes unfavorable, own-claim
    When all of:
      - foreground(?t)
      - the viewer's role is "implementer"
      - own-active(?t)
      - unfavorable(?t)
    Declared override: D-OWN-UNFAVORABLE wins over D-OWN when both match.

Band 8
  D-OWN-WAIT: action wait-claim; preference 0; codes own-claim, waiting
    When all of:
      - foreground(?t)
      - the viewer's role is "implementer"
      - own-issue(?t)
      - ?t's activity of your retained claim (active, waiting, resume-required or unknown) is "waiting"
    Evidence shown:
      waitReason (rule): ?t's what your retained claim waits on, or why its activity is unknown is ?value

== Eligibility and denials (9) ==
Denials query:
  denials: find ?t, ?r given $ % (predicates from rules.edn)
    - implementation-permit(?t)
    - implementation-deny(?t, ?r)
  D-DENY-CLAIM (from implementation-deny) when all of:
      - issue(?t)
      - claimed(?t)
  D-DENY-PREREQUISITE (from implementation-deny) when all of:
      - issue(?t)
      - prerequisite(?t)
  D-DENY-OPEN-PR (from implementation-deny) when all of:
      - issue(?t)
      - has-closing(?t)
  D-DENY-BLOCKER (from implementation-deny) when all of:
      - issue(?t)
      - blocked(?t)
  D-DENY-LABELS-UNKNOWN (from implementation-deny) when all of:
      - issue(?t)
      - ?t's completeness of label evidence is false
  D-DENY-NATIVE-UNKNOWN (from implementation-deny) when all of:
      - issue(?t)
      - ?t's completeness of native dependency evidence is false
  D-DENY-CLOSING-UNKNOWN (from implementation-deny) when all of:
      - issue(?t)
      - no match for: closing-complete(?t)
  D-DENY-PLATFORM (from implementation-deny) when all of:
      - issue(?t)
      - no match for: platform-ok(?t)
  D-DENY-INVENTORY-UNKNOWN (from implementation-deny) when all of:
      - issue(?t)
      - open(?t)
      - available(?t)
      - no match for: claimed(?t)
      - the context records completeness of your claim inventory false

== Ordering ==
Sort keys, compared in this sequence, smaller first: band, group, primary, urgency, unlocks, own, incomplete, created, number, target, kind.
Declared overrides (winner over loser, when both match the same ?t):
  D-EASY over D-ORDINARY
  D-UNFAVORABLE over D-ORDINARY
  D-OWN-EASY over D-OWN
  D-OWN-UNFAVORABLE over D-OWN
Override query q0: find ?t, ?r
    - ?t has matched decision rule ?r
    - ?t has matched decision rule ?o
    - ?r's kind is ?k
    - ?o's kind is ?k
    - at least one of (joined on ?r, ?o):
        (1) all of:
            - ?r's band is ?b
            - ?o's band is ?b
            - ?r's preference is ?p
            - ?o's preference is ?p
            - ?o < ?r
        (2) all of:
            - ?r's band is ?b
            - ?o's band is ?b
            - ?r's preference is ?p
            - ?o's preference is ?op
            - ?op < ?p
Override query declared-overrides: find ?t, ?r given $ [[?winner ?loser]]
    - ?t has matched decision rule ?r
    - ?t has matched decision rule ?o
    - ?r's kind is ?k
    - ?o's kind is ?k
    - ?r's rule ID is ?loser
    - ?o's rule ID is ?winner
Sort query q4: find ?t, ?r, ?b, ?g, ?p, ?u, ?un, ?own, ?inc, ?created, ?n, ?target, ?kind given $ % (predicates from ordering.edn)
    - keys(?t, ?r, ?b, ?g, ?p, ?u, ?un, ?own, ?inc, ?created)
    - ?t's number is ?n
    - ?t's target is ?target
    - ?r's kind is ?kind
Sort key query own-key: find ?t, ?k given $ % (predicates from rules.edn)
    - ?t has some kind
    - at least one of (joined on ?t, ?k):
        (1) all of:
            - mine(?t)
            - ?k = 0 - 1
        (2) all of:
            - no match for: mine(?t)
            - ?k = 0 + 0
Sort key query linked-key: find ?t, ?k given $ % (predicates from rules.edn)
    - ?t has some kind
    - at least one of (joined on ?t, ?k):
        (1) all of:
            - mine-linked(?t)
            - ?k = 0 - 1
        (2) all of:
            - no match for: mine-linked(?t)
            - ?k = 0 + 0
Sort key query incomplete-key: find ?t, ?k
    - ?t has some kind
    - at least one of (joined on ?t, ?k):
        (1) all of:
            - ?t has label "status:incomplete"
            - ?k = 0 - 1
        (2) all of:
            - no match for: ?t has label "status:incomplete"
            - ?k = 0 + 0
Sort key query urgency-key: find ?t, ?k
    - ?t has some kind
    - at least one of (joined on ?t, ?k):
        (1) all of:
            - ?t has label "urgency:high"
            - no match for: ?t has label "urgency:low"
            - ?k = 0 + 0
        (2) all of:
            - ?t has label "urgency:low"
            - no match for: ?t has label "urgency:high"
            - ?k = 1 + 1
        (3) all of:
            - no match for: ?t has label "urgency:high"
            - no match for: ?t has label "urgency:low"
            - ?k = 0 + 1
        (4) all of:
            - ?t has label "urgency:high"
            - ?t has label "urgency:low"
            - ?k = 0 + 1

== Other engine queries (15) ==
  check-ready: find ?t given $ % (predicates from rules.edn)
      - requirements-satisfied(?t)
  check-blockers: find ?t, ?code, ?reason given $ % (predicates from rules.edn)
      - check-blocker(?t, ?code, ?reason)
  pr-blockers: find ?t, ?code, ?reason given $ % (predicates from rules.edn)
      - pr-blocker(?t, ?code, ?reason)
  human-sections: find ?t, ?section, ?code, ?reason given $ % (predicates from rules.edn)
      - human-attention-section(?t, ?section, ?code, ?reason)
  q1: find ?t, ?d given $ % (predicates from rules.edn)
      - ?t has native dependent ?d
      - otherwise(?d)
      - ?d's completeness of native dependency evidence is true
      - ?d's number of open blockers is 1
      - ?d has native blocker ?t
      - open(?t)
  q2: find ?t, count of distinct ?d
      - ?t has dependent it would unlock ?d
  q3: find ?t
      - ?t has some kind
      - no match for: ?t has some number of dependents it unlocks
  q5: find ?id given $ ?t
      - ?t has overridden decision rule ?r
      - ?r's rule ID is ?id
  q6: find ?n given $ ?t
      - ?t's number of dependents it unlocks is ?n
  q7: find ?reason given $ ?t
      - ?t has reason the unlock count is unknown ?reason
  unknown-unlocks: find ?t, ?reason given $ % (predicates from rules.edn)
      - ?t's kind is "issue"
      - at least one of (joined on ?t, ?reason):
          (1) all of:
              - ?t's completeness of dependent coverage is false
              - ?reason is the text "direct dependent coverage incomplete"
          (2) all of:
              - ?t has native dependent ?d
              - ?d's state is "OPEN"
              - no match for: ?d's kind is "issue"
              - ?reason is the text "dependent absent from collected repository"
          (3) all of:
              - ?t has native dependent ?d
              - ?d's state is "OPEN"
              - ?d's completeness of native dependency evidence is false
              - ?reason is the text "dependent native evidence incomplete"
          (4) all of:
              - ?t has native dependent ?d
              - ?d's state is "OPEN"
              - uncertain(?d)
              - ?reason is the text "dependent eligibility evidence incomplete"
  active-dependents: find ?t, ?d given $ % (predicates from rules.edn)
      - ?t has native dependent ?d
      - open(?d)
      - at least one of (joined on ?d):
          (1) all of:
              - claimed(?d)
          (2) all of:
              - has-closing(?d)
  other-claims: find ?t, ?other given $ % (predicates from rules.edn)
      - ?t's kind is "issue"
      - own-issue(?other)
      - ?t is not ?other
      - no match for: ?other's activity of your retained claim (active, waiting, resume-required or unknown) is "waiting"
  active-count: find ?t, count of distinct ?d
      - ?t's active dependent is ?d
  missing-active-count: find ?t
      - ?t has some kind
      - no match for: ?t has some number of active dependents

== Predicate glossary (83) ==
Each numbered definition is sufficient on its own; within one, every condition must hold.
  issue(?t)
    (1) all of:
        - ?t's kind is "issue"
    Used by: D-COMPLEXITY-BOOST, D-COMPLEXITY, D-IMPACT-BOOST, D-IMPACT, D-BAD-COMPLEXITY, D-BAD-IMPACT, D-INSPECT, D-DENY-CLAIM, D-DENY-PREREQUISITE, D-DENY-OPEN-PR, D-DENY-BLOCKER, D-DENY-LABELS-UNKNOWN, D-DENY-NATIVE-UNKNOWN, D-DENY-CLOSING-UNKNOWN, D-DENY-PLATFORM, D-DENY-INVENTORY-UNKNOWN, own-issue(), otherwise(), implementation-permit(), implementation-deny(), design-eligible(), open-question(), open-unrecorded(), orphaned-record(), orphan-unknown()
  pr(?t)
    (1) all of:
        - ?t's kind is "pr"
    Used by: design-pr(), clean-pr(), follow-up(), pr-action()
  open(?t)
    (1) all of:
        - ?t's state is "OPEN"
    Used by: D-ATTENTION, D-HUMAN-SIGNOFF, D-DENY-INVENTORY-UNKNOWN, foreground(), own-issue(), has-closing(), otherwise(), implementation-permit(), implementation-deny(), design-eligible(), open-question(), open-unrecorded(), query q1, query active-dependents
  claimed(?t)
    (1) all of:
        - ?t has claiming agent ?a
    Used by: D-DENY-CLAIM, D-DENY-INVENTORY-UNKNOWN, otherwise(), implementation-deny(), design-eligible(), possible(), query active-dependents
  mine(?t)
    (1) all of:
        - the viewer's agent name is ?a
        - ?t has claiming agent ?a
    Used by: mine-linked(), own-issue(), query own-key
  mine-linked(?t)
    (1) all of:
        - mine(?t)
    (2) all of:
        - the viewer's agent name is ?a
        - ?t has responsible agent ?a
    (3) all of:
        - ?t has issue it closes ?i
        - mine(?i)
    Used by: own-follow-up(), pr-action(), query linked-key
  addressed(?t)
    (1) all of:
        - the viewer's agent name is ?a
        - ?t has agent whose attention is requested ?a
    Used by: D-ATTENTION, foreground()
  parked(?t)
    (1) all of:
        - ?t has label "status:parked"
    Used by: foreground()
  foreground(?t)
    (1) all of:
        - open(?t)
        - no match for: parked(?t)
    (2) all of:
        - ?t's repository ownership inventory context is true
    (3) all of:
        - open(?t)
        - addressed(?t)
    (4) all of:
        - open(?t)
        - the viewer's role is "human"
    (5) all of:
        - the viewer's role is "human"
        - orphan-source(?t)
    Used by: D-ATTENTION, D-PR-FAIL, D-PR-REVIEW, D-PR-CONFLICT, D-PR-MERGE, D-PR-INTEGRATE, D-DECIDE, D-DOCUMENT, D-DESIGN-REVIEW, D-EASY, D-OWN-EASY, D-COMPLEXITY-BOOST, D-COMPLEXITY, D-IMPACT-BOOST, D-IMPACT, D-BAD-COMPLEXITY, D-BAD-IMPACT, D-ORDINARY, D-OWN, D-DESIGN, D-UNFAVORABLE, D-OWN-UNFAVORABLE, D-OWN-RESUME, D-REVIEW-OWNED, D-REVIEW-OWNED-PARTIAL, D-INVENTORY-UNKNOWN, D-OWNED-INCOMPLETE, D-OWN-UNKNOWN, D-OWN-WAIT, D-INSPECT, D-HUMAN-ASK-YOU, D-HUMAN-ASK, D-HUMAN-UNVERIFIED, D-HUMAN-DECIDE, D-HUMAN-ORPHANED-YOU, D-HUMAN-ORPHANED, D-HUMAN-ORPHANED-UNKNOWN, D-HUMAN-SIGNOFF
  own-issue(?t)
    (1) all of:
        - issue(?t)
        - open(?t)
        - mine(?t)
        - no match for: ?t's activity of your retained claim (active, waiting, resume-required or unknown) is "not-owned"
    Used by: D-OWN-RESUME, D-REVIEW-OWNED, D-REVIEW-OWNED-PARTIAL, D-OWNED-INCOMPLETE, D-OWN-UNKNOWN, D-OWN-WAIT, own-active(), query other-claims
  own-active(?t)
    (1) all of:
        - own-issue(?t)
        - no match for: ?t has some activity of your retained claim (active, waiting, resume-required or unknown)
    (2) all of:
        - own-issue(?t)
        - ?t's activity of your retained claim (active, waiting, resume-required or unknown) is "active"
    Used by: D-OWN-EASY, D-OWN, D-OWN-UNFAVORABLE
  platform-ok(?t)
    (1) all of:
        - ?t's completeness of label evidence is true
        - no match for: ?t has some required platform
    (2) all of:
        - the viewer's platform is ?p
        - ?t has required platform ?p
    Used by: D-DENY-PLATFORM, otherwise(), implementation-deny(), design-eligible()
  platform-unknown(?t)
    (1) all of:
        - ?t has some required platform
        - the viewer's platform is ""
    Used by: uncertain()
  available(?t)
    (1) all of:
        - ?t has label "status:ready"
    (2) all of:
        - ?t has label "status:incomplete"
    Used by: D-DENY-INVENTORY-UNKNOWN, otherwise(), implementation-permit(), implementation-deny(), possible()
  prerequisite(?t)
    (1) all of:
        - ?t has label ?l
        - ?l is in the constant set "prerequisite"
    Used by: D-DENY-PREREQUISITE, otherwise(), implementation-deny(), possible()
  has-closing(?t)
    (1) all of:
        - ?t has closing pull request ?p
    (2) all of:
        - ?p has issue it closes ?t
        - open(?p)
    Used by: D-DENY-OPEN-PR, otherwise(), implementation-deny(), design-eligible(), possible(), query active-dependents
  closing-complete(?t)
    (1) all of:
        - ?t's completeness of reverse closing-PR evidence is true
    (2) all of:
        - ?t has some kind
        - the context records completeness of forward closing-PR evidence true
    Used by: D-DENY-CLOSING-UNKNOWN, otherwise(), implementation-deny(), design-eligible(), uncertain()
  otherwise(?t)
    (1) all of:
        - issue(?t)
        - open(?t)
        - available(?t)
        - ?t's completeness of label evidence is true
        - platform-ok(?t)
        - closing-complete(?t)
        - no match for: claimed(?t)
        - no match for: has-closing(?t)
        - no match for: prerequisite(?t)
    Used by: query q1
  blocked(?t)
    (1) all of:
        - ?t's number of open blockers is ?n
        - ?n > 0
    (2) all of:
        - ?t has native blocker ?i
        - ?i's state is "OPEN"
    Used by: D-DENY-BLOCKER, implementation-deny(), possible()
  implementation-permit(?t)
    (1) all of:
        - issue(?t)
        - open(?t)
        - available(?t)
    Used by: eligible(), query denials
  implementation-deny(?t, ?r)
    (1) all of:
        - issue(?t)
        - claimed(?t)
        - ?r is the text "D-DENY-CLAIM"
    (2) all of:
        - issue(?t)
        - prerequisite(?t)
        - ?r is the text "D-DENY-PREREQUISITE"
    (3) all of:
        - issue(?t)
        - has-closing(?t)
        - ?r is the text "D-DENY-OPEN-PR"
    (4) all of:
        - issue(?t)
        - blocked(?t)
        - ?r is the text "D-DENY-BLOCKER"
    (5) all of:
        - issue(?t)
        - ?t's completeness of label evidence is false
        - ?r is the text "D-DENY-LABELS-UNKNOWN"
    (6) all of:
        - issue(?t)
        - ?t's completeness of native dependency evidence is false
        - ?r is the text "D-DENY-NATIVE-UNKNOWN"
    (7) all of:
        - issue(?t)
        - no match for: closing-complete(?t)
        - ?r is the text "D-DENY-CLOSING-UNKNOWN"
    (8) all of:
        - issue(?t)
        - no match for: platform-ok(?t)
        - ?r is the text "D-DENY-PLATFORM"
    (9) all of:
        - issue(?t)
        - open(?t)
        - available(?t)
        - no match for: claimed(?t)
        - the context records completeness of your claim inventory false
        - ?r is the text "D-DENY-INVENTORY-UNKNOWN"
    Used by: implementation-denied(), query denials
  implementation-denied(?t)
    (1) all of:
        - implementation-deny(?t, ?r)
    Used by: eligible()
  eligible(?t)
    (1) all of:
        - implementation-permit(?t)
        - no match for: implementation-denied(?t)
    Used by: D-EASY, D-ORDINARY, D-UNFAVORABLE
  design-eligible(?t)
    (1) all of:
        - issue(?t)
        - open(?t)
        - ?t has label "status:needs-design"
        - ?t's completeness of label evidence is true
        - platform-ok(?t)
        - closing-complete(?t)
        - no match for: claimed(?t)
        - no match for: has-closing(?t)
        - no match for: ?t has label "design:decision-needed"
    Used by: D-DESIGN
  possible(?t)
    (1) all of:
        - available(?t)
        - no match for: claimed(?t)
        - no match for: prerequisite(?t)
        - no match for: blocked(?t)
        - no match for: has-closing(?t)
    (2) all of:
        - the viewer's role is "designer"
        - ?t has label "status:needs-design"
        - no match for: claimed(?t)
        - no match for: has-closing(?t)
    Used by: D-INSPECT
  uncertain(?t)
    (1) all of:
        - ?t's completeness of label evidence is false
    (2) all of:
        - ?t's completeness of native dependency evidence is false
    (3) all of:
        - ?t has some kind
        - no match for: closing-complete(?t)
    (4) all of:
        - platform-unknown(?t)
    Used by: D-INSPECT, query unknown-unlocks
  large-impact(?t)
    (1) all of:
        - ?t's impact assessment state is "current"
        - ?t's impact size is ?s
        - ?s is in the constant set "large"
    Used by: D-COMPLEXITY-BOOST, easy()
  small-complexity(?t)
    (1) all of:
        - ?t's complexity assessment state is "current"
        - ?t's complexity size is ?s
        - ?s is in the constant set "small"
    Used by: D-IMPACT-BOOST, easy()
  easy(?t)
    (1) all of:
        - large-impact(?t)
        - small-complexity(?t)
    Used by: D-EASY, D-OWN-EASY
  unfavorable(?t)
    (1) all of:
        - ?t's impact assessment state is "current"
        - ?t's impact size is ?i
        - ?i is in the constant set "small"
        - ?t's complexity assessment state is "current"
        - ?t's complexity size is ?c
        - ?c is in the constant set "large"
    Used by: D-UNFAVORABLE, D-OWN-UNFAVORABLE
  needs-complexity(?t)
    (1) all of:
        - ?t's complexity assessment state is ?s
        - ?s is in the constant set "needs-assessment"
    Used by: D-COMPLEXITY-BOOST, D-COMPLEXITY
  needs-impact(?t)
    (1) all of:
        - ?t's impact assessment state is ?s
        - ?s is in the constant set "needs-assessment"
    Used by: D-IMPACT-BOOST, D-IMPACT
  bad-complexity(?t)
    (1) all of:
        - ?t's complexity assessment state is ?s
        - ?s is in the constant set "bad-assessment"
    Used by: D-BAD-COMPLEXITY
  bad-impact(?t)
    (1) all of:
        - ?t's impact assessment state is ?s
        - ?s is in the constant set "bad-assessment"
    Used by: D-BAD-IMPACT
  design-pr(?t)
    (1) all of:
        - pr(?t)
        - ?t has label ?l
        - ?l is in the constant set "design-label"
    (2) all of:
        - pr(?t)
        - ?t has issue it closes ?i
        - ?i has label ?l
        - ?l is in the constant set "design-label"
    Used by: D-DESIGN-REVIEW, pr-action()
  pr-failure(?t)
    (1) all of:
        - ?t has check run ?c
        - ?c's outcome is ?o
        - ?o is in the constant set "failure"
    Used by: D-PR-FAIL, clean-pr(), accepted-pr(), follow-up()
  pr-pending(?t)
    (1) all of:
        - ?t has check run ?c
        - ?c's outcome is ?o
        - ?o is in the constant set "pending"
        - no match for: ?c's check requiredness is "advisory"
    (2) all of:
        - ?t has required check not yet reported ?m
    Used by: clean-pr(), accepted-pr()
  pr-unknown(?t)
    (1) all of:
        - ?t has check run ?c
        - ?c's outcome is ?o
        - no match for: ?o is in the constant set "known-check"
    Used by: clean-pr(), accepted-pr()
  pr-review(?t)
    (1) all of:
        - ?t's review decision is "CHANGES_REQUESTED"
    (2) all of:
        - ?t has review thread ?c
        - ?c's resolved flag is false
    (3) all of:
        - head-findings(?t)
    Used by: D-PR-REVIEW, clean-pr(), accepted-pr(), follow-up()
  required-unsatisfied(?t)
    (1) all of:
        - ?t has check run ?c
        - ?c's check requiredness is "required"
        - ?c's outcome is ?o
        - ?o is not "SUCCESS"
    Used by: requirements-satisfied()
  required-unknown(?t)
    (1) all of:
        - ?t has check run ?c
        - ?c's check requiredness is "unknown"
    Used by: requirements-satisfied()
  requirements-satisfied(?t)
    (1) all of:
        - ?t's completeness of target required-check evidence is true
        - no match for: required-unsatisfied(?t)
        - no match for: required-unknown(?t)
        - no match for: ?t has some required check not yet reported
    Used by: query check-ready
  verified(?t)
    (1) all of:
        - ?t's materialized native required-check query result is true
    Used by: clean-pr(), accepted-pr()
  check-blocker(?t, ?code, ?reason)
    (1) all of:
        - ?code is the text "RC-COVERAGE"
        - ?t's completeness of target required-check evidence is false
        - no match for: ?t has some unread target required-check evidence
        - ?reason is the text "Required-check evidence incomplete"
    (2) all of:
        - ?code is the text "RC-REQUIREDNESS"
        - ?t has check run ?c
        - ?c's check requiredness is "unknown"
        - ?c's name is ?name
        - ?reason is the text joining "Requiredness unknown: ", ?name
    (3) all of:
        - ?code is the text "RC-GAP"
        - ?t has unread target required-check evidence ?gap
        - ?reason is the text joining "Required-check evidence unknown: ", ?gap
    (4) all of:
        - ?code is the text "RC-MISSING"
        - ?t has required check not yet reported ?name
        - ?reason is the text joining "Required check not yet reported: ", ?name
    (5) all of:
        - ?code is the text "RC-OUTCOME"
        - ?t has check run ?c
        - ?c's check requiredness is "required"
        - ?c's name is ?name
        - ?c's outcome is ?o
        - ?o is not "SUCCESS"
        - ?reason is the text joining "Required check ", ?name, " is ", ?o
    Used by: pr-specific-blocker(), query check-blockers
  clean-pr(?t)
    (1) all of:
        - pr(?t)
        - ?t's completeness of pull request evidence is true
        - ?t's draft flag is false
        - ?t's mergeability is "MERGEABLE"
        - ?t has merge state ?m
        - ?m is in the constant set "merge-state"
        - verified(?t)
        - no match for: pr-failure(?t)
        - no match for: pr-pending(?t)
        - no match for: pr-unknown(?t)
        - no match for: pr-review(?t)
    Used by: D-PR-MERGE, D-HUMAN-SIGNOFF, follow-up()
  legacy-coverage(?t)
    (1) all of:
        - ?t has some head commit
        - no match (joined on ?t) for: the context records declared review coverage "any"
        - no match (joined on ?t) for: the context records declared review coverage "unknown"
    Used by: head-reviewed(), head-findings()
  head-reviewed(?t)
    (1) all of:
        - legacy-coverage(?t)
        - ?t's head commit is ?h
        - ?t has review ?r
        - ?r's review state is "APPROVED"
        - ?r's reviewed commit is ?h
    (2) all of:
        - legacy-coverage(?t)
        - ?t's head commit is ?h
        - ?t has review receipt ?c
        - ?c's reviewed commit is ?h
        - ?c's receipt status is "completed"
        - ?c's findings flag is false
    (3) all of:
        - the context records declared review coverage "any"
        - ?t's head commit is ?h
        - ?t has configured review provider evidence ?p
        - ?p's provider review state is "accepted"
        - ?p's provider-reviewed commit is ?h
    Used by: accepted-pr()
  head-findings(?t)
    (1) all of:
        - legacy-coverage(?t)
        - ?t's head commit is ?h
        - ?t has review receipt ?c
        - ?c's reviewed commit is ?h
        - ?c's findings flag is true
    (2) all of:
        - ?t's head commit is ?h
        - ?t has configured review provider evidence ?p
        - ?p's provider review state is "findings"
        - ?p's provider-reviewed commit is ?h
    Used by: pr-review(), accepted-pr()
  accepted-pr(?t)
    (1) all of:
        - head-reviewed(?t)
        - no match for: head-findings(?t)
        - ?t's completeness of pull request evidence is true
        - ?t's draft flag is false
        - verified(?t)
        - no match for: pr-failure(?t)
        - no match for: pr-pending(?t)
        - no match for: pr-unknown(?t)
        - no match for: pr-review(?t)
        - no match for: ?t's mergeability is "CONFLICTING"
    Used by: D-HUMAN-SIGNOFF, integrate-pr()
  refresh-needed(?t)
    (1) all of:
        - ?t's mergeability is ?m
        - ?m is in the constant set "unknown-mergeable"
    (2) all of:
        - ?t has merge state ?m
        - ?m is in the constant set "refresh-state"
    Used by: integrate-pr()
  integrate-pr(?t)
    (1) all of:
        - accepted-pr(?t)
        - refresh-needed(?t)
    Used by: D-PR-INTEGRATE, follow-up()
  follow-up(?t)
    (1) all of:
        - pr-failure(?t)
    (2) all of:
        - pr-review(?t)
    (3) all of:
        - pr(?t)
        - ?t's mergeability is "CONFLICTING"
    (4) all of:
        - clean-pr(?t)
    (5) all of:
        - integrate-pr(?t)
    Used by: own-follow-up()
  own-follow-up(?t)
    (1) all of:
        - mine-linked(?t)
        - follow-up(?t)
    Used by: D-DESIGN-REVIEW
  pr-action(?t)
    (1) all of:
        - pr(?t)
        - the viewer's role is "implementer"
    (2) all of:
        - the viewer's role is "designer"
        - design-pr(?t)
        - mine-linked(?t)
    Used by: D-PR-FAIL, D-PR-REVIEW, D-PR-CONFLICT, D-PR-MERGE, D-PR-INTEGRATE
  question-labelled(?t)
    (1) all of:
        - ?t has label ?l
        - ?l is in the constant set "question-label"
    Used by: record-pending(), open-unrecorded(), orphan-unknown()
  trusted-record(?t, ?r)
    (1) all of:
        - ?t has question record ?r
        - ?r's trust level is "trusted"
    Used by: asking-record(), orphaned-record(), orphan-unknown()
  unverified-record(?t)
    (1) all of:
        - ?t has question record ?r
        - ?r's trust level is "unverified"
    Used by: D-HUMAN-UNVERIFIED
  record-pending(?t, ?r)
    (1) all of:
        - ?r's question marker version is 2
    (2) all of:
        - ?r's question marker version is 1
        - question-labelled(?t)
    (3) all of:
        - ?t has question record ?r
        - no match for: ?r has some question marker version
        - question-labelled(?t)
    Used by: asking-record(), orphaned-record(), orphan-unknown()
  asking-record(?t, ?r)
    (1) all of:
        - trusted-record(?t, ?r)
        - no match for: record-settled(?r)
        - record-pending(?t, ?r)
    Used by: has-asking-record(), asks-viewer()
  has-asking-record(?t)
    (1) all of:
        - asking-record(?t, ?r)
    Used by: open-question(), open-unrecorded()
  open-question(?t)
    (1) all of:
        - issue(?t)
        - open(?t)
        - has-asking-record(?t)
    Used by: D-HUMAN-ASK-YOU, D-HUMAN-ASK
  open-unrecorded(?t)
    (1) all of:
        - issue(?t)
        - open(?t)
        - question-labelled(?t)
        - no match for: has-asking-record(?t)
    Used by: D-HUMAN-UNVERIFIED, D-HUMAN-DECIDE
  asks-viewer(?t)
    (1) all of:
        - asking-record(?t, ?r)
        - ?r's addressee is ?a
        - the viewer's agent name is ?a
    Used by: D-HUMAN-ASK-YOU, D-HUMAN-ASK
  closed(?t)
    (1) all of:
        - ?t's state is "CLOSED"
    Used by: orphaned-record(), orphan-unknown()
  record-settled(?r)
    (1) all of:
        - ?r's explicit resolution outcome is "resolved"
    (2) all of:
        - ?r's explicit resolution outcome is "withdrawn"
    Used by: asking-record(), orphan-unknown()
  orphaned-record(?t, ?r)
    (1) all of:
        - issue(?t)
        - closed(?t)
        - trusted-record(?t, ?r)
        - ?r's explicit resolution outcome is "none"
        - record-pending(?t, ?r)
    Used by: has-orphaned(), orphan-asks-viewer()
  orphan-unknown(?t, ?r)
    (1) all of:
        - issue(?t)
        - closed(?t)
        - trusted-record(?t, ?r)
        - ?r's explicit resolution outcome is "unknown"
        - record-pending(?t, ?r)
    (2) all of:
        - issue(?t)
        - closed(?t)
        - trusted-record(?t, ?r)
        - ?r's question marker version is 1
        - no match for: record-settled(?r)
        - ?t's completeness of label evidence is false
        - no match for: question-labelled(?t)
    Used by: has-orphan-unknown()
  has-orphaned(?t)
    (1) all of:
        - orphaned-record(?t, ?r)
    Used by: D-HUMAN-ORPHANED, orphan-source()
  has-orphan-unknown(?t)
    (1) all of:
        - orphan-unknown(?t, ?r)
    Used by: D-HUMAN-ORPHANED-UNKNOWN, orphan-source(), human-waiting-item()
  orphan-source(?t)
    (1) all of:
        - has-orphaned(?t)
    (2) all of:
        - has-orphan-unknown(?t)
    Used by: foreground()
  orphan-asks-viewer(?t)
    (1) all of:
        - orphaned-record(?t, ?r)
        - ?r's addressee is ?a
        - the viewer's agent name is ?a
    Used by: D-HUMAN-ORPHANED-YOU, D-HUMAN-ORPHANED
  human-waiting-item(?t)
    (1) all of:
        - the viewer's role is "human"
        - has-orphan-unknown(?t)
    Used by: human-attention-section()
  human-attention-section(?t, ?section, ?code, ?reason)
    (1) all of:
        - human-waiting-item(?t)
        - ?section is the text "waiting"
        - ?code is the text "HS-WAITING-UNKNOWN"
        - ?reason is the text "Whether this question was resolved could not be established; shown under Waiting for inspection, not as answered."
    (2) all of:
        - the viewer's role is "human"
        - ?t has some matched decision rule
        - no match for: human-waiting-item(?t)
        - ?section is the text "input"
        - ?code is the text "HS-INPUT-ACTIONABLE"
        - ?reason is the text "Requires human input or review from the observed evidence."
    Used by: query human-sections
  declared-review-coverage(?t)
    (1) all of:
        - ?t's effective declared review policy is "codex-or-coderabbit"
    (2) all of:
        - ?t's effective declared review policy is "codex-or-copilot"
    Used by: optional-review-detail(), pr-specific-blocker()
  optional-review-detail(?t)
    (1) all of:
        - declared-review-coverage(?t)
        - ?t's whether the declared review policy accepted the current head is true
    Used by: pr-specific-blocker()
  pr-specific-blocker(?t, ?code, ?reason)
    (1) all of:
        - ?code is the text "PR-DRAFT"
        - ?t's draft flag is true
        - ?reason is the text "draft"
    (2) all of:
        - check-blocker(?t, ?code, ?reason)
    (3) all of:
        - ?code is the text "PR-CHECK-FAILED"
        - ?t has check run ?c
        - ?c's name is ?name
        - ?c's outcome is ?o
        - ?o is in the constant set "failure"
        - ?o is not "CANCELLED"
        - ?reason is the text joining "check ", ?name, " failed"
    (4) all of:
        - ?code is the text "PR-CHECK-CANCELLED"
        - ?t has check run ?c
        - ?c's name is ?name
        - ?c's outcome is "CANCELLED"
        - ?c's whether a cancelled check had no recorded run time is true
        - ?reason is the text joining "check ", ?name, " cancelled without running (likely infrastructure, not a code defect): verification incomplete"
    (5) all of:
        - ?code is the text "PR-CHECK-CANCELLED"
        - ?t has check run ?c
        - ?c's name is ?name
        - ?c's outcome is "CANCELLED"
        - ?c's whether a cancelled check had no recorded run time is false
        - ?reason is the text joining "check ", ?name, " cancelled: verification incomplete"
    (6) all of:
        - ?code is the text "PR-CHECK-PENDING"
        - ?t's number of pending checks is ?n
        - ?n > 0
        - ?reason is the text joining ?n, " check(s) still pending: waiting"
    (7) all of:
        - ?code is the text "PR-CONFLICTS"
        - ?t's mergeability is "CONFLICTING"
        - ?reason is the text "merge conflicts with the base branch"
    (8) all of:
        - ?code is the text "PR-MERGEABLE-UNKNOWN"
        - ?t's mergeability is "UNKNOWN"
        - ?reason is the text "mergeability unknown (GitHub still computing)"
    (9) all of:
        - ?code is the text "PR-BEHIND"
        - ?t has merge state "BEHIND"
        - ?t's pull request base branch is ?base
        - ?reason is the text joining "branch is behind ", ?base, ": update it before merging"
    (10) all of:
        - ?code is the text "PR-MERGE-STATE"
        - ?t has merge state ?m
        - no match for: ?m is in the constant set "merge-state"
        - ?m is not "BLOCKED"
        - ?m is not "BEHIND"
        - no match for: pr-merge-state-exempt(?t)
        - ?reason is the text joining "merge state ", ?m, " is not current: merging is not possible yet"
    (11) all of:
        - ?code is the text "PR-CHANGES-REQUESTED"
        - ?t's review decision is "CHANGES_REQUESTED"
        - ?reason is the text "changes requested"
    (12) all of:
        - ?code is the text "PR-REVIEW-REQUIRED"
        - ?t's review decision is "REVIEW_REQUIRED"
        - ?reason is the text "a required approving review is missing"
    (13) all of:
        - ?code is the text "PR-UNRESOLVED-THREADS"
        - ?t's number of unresolved review threads is ?n
        - ?n > 0
        - ?reason is the text joining ?n, " unresolved review thread(s)"
    (14) all of:
        - ?code is the text "PR-CODEX-FINDINGS"
        - no match for: declared-review-coverage(?t)
        - no match for: ?t's effective declared review policy is "unknown"
        - ?t's whether legacy Codex receipt reports findings on the current head is true
        - ?reason is the text "Codex reports unresolved findings on the current head"
    (15) all of:
        - ?code is the text "PR-CODEX-STALE"
        - no match for: optional-review-detail(?t)
        - ?t's whether legacy Codex coverage is stale against the current head is true
        - ?reason is the text "Codex's latest review is for an older commit; current head not yet covered"
    (16) all of:
        - ?code is the text "PR-PROVIDER-FINDINGS"
        - declared-review-coverage(?t)
        - ?t has unresolved finding from a configured review provider ?f
        - ?f's review provider display label is ?label
        - ?f's review finding source URL is ?src
        - ?reason is the text joining ?label, " reports unresolved findings on the current head ", ?src
    (17) all of:
        - ?code is the text "PR-PROVIDER-FINDINGS"
        - ?t's effective declared review policy is "unknown"
        - ?t has unresolved finding from a configured review provider ?f
        - ?f's review provider display label is ?label
        - ?f's review finding source URL is ?src
        - ?reason is the text joining ?label, " reports unresolved findings on the current head ", ?src
    (18) all of:
        - ?code is the text "PR-POLICY-UNSATISFIED"
        - declared-review-coverage(?t)
        - ?t's whether the declared review policy accepted the current head is false
        - ?t's whether the declared review policy has unresolved head findings is false
        - ?t's effective declared review policy is ?eff
        - ?t's configured review providers' current-head states is ?sum
        - ?reason is the text joining "review policy ", ?eff, ": no configured provider has accepted the current head yet (", ?sum, ")"
    (19) all of:
        - ?code is the text "PR-POLICY-UNKNOWN"
        - ?t's effective declared review policy is "unknown"
        - ?t's reason the declared review policy is unknown is ?why
        - ?reason is the text joining "review policy unknown (", ?why, "): review coverage cannot be established"
    (20) all of:
        - ?code is the text "PR-REVIEW-REQUEST-NONE"
        - no match for: optional-review-detail(?t)
        - ?t's status of an explicit review request is "no reaction yet"
        - ?reason is the text "a review was requested and has had no reaction"
    (21) all of:
        - ?code is the text "PR-REVIEW-REQUEST-PENDING"
        - no match for: optional-review-detail(?t)
        - ?t's status of an explicit review request is ?st
        - ?st is not "no reaction yet"
        - ?st is not "covered"
        - ?reason is the text joining "waiting for the requested review to finish (", ?st, ")"
    (22) all of:
        - ?code is the text "PR-CODEX-RUNNING"
        - no match for: optional-review-detail(?t)
        - no match for: ?t has some status of an explicit review request
        - ?t's in-progress status of Codex's current-head review is ?st
        - ?reason is the text joining "waiting for Codex's review of the current head to finish (", ?st, ")"
    Used by: has-pr-specific-blocker(), pr-blocker()
  pr-merge-state-exempt(?t)
    (1) all of:
        - ?t has merge state "DIRTY"
        - ?t's mergeability is "CONFLICTING"
    (2) all of:
        - ?t has merge state "DRAFT"
        - ?t's draft flag is true
    (3) all of:
        - ?t has merge state "UNKNOWN"
        - ?t's mergeability is "UNKNOWN"
    Used by: pr-specific-blocker()
  has-pr-specific-blocker(?t)
    (1) all of:
        - pr-specific-blocker(?t, ?c, ?r)
    Used by: pr-blocker()
  pr-blocker(?t, ?code, ?reason)
    (1) all of:
        - ?t's closed or merged pull request state is ?l
        - no match for: ?t's state is "OPEN"
        - ?code is the text "PR-CLOSED"
        - ?reason is the text joining "pull request is ", ?l
    (2) all of:
        - ?t's state is "OPEN"
        - pr-specific-blocker(?t, ?code, ?reason)
    (3) all of:
        - ?t's state is "OPEN"
        - ?t has merge state "BLOCKED"
        - no match for: has-pr-specific-blocker(?t)
        - ?code is the text "PR-BLOCKED"
        - ?reason is the text "GitHub reports merging is blocked (branch protection); inspect the rules"
    Used by: query pr-blockers
  selected(?t, ?r) [ordering rules]
    (1) all of:
        - ?t has matched decision rule ?r
        - no match for: ?t has overridden decision rule ?r
    Used by: keys()
  age(?t, ?r, ?created) [ordering rules]
    (1) all of:
        - ?r's kind is "implement"
        - the viewer's requested order is "oldest"
        - ?t's creation order is ?created
    (2) all of:
        - ?r's kind is "implement"
        - the viewer's requested order is "newest"
        - ?t's creation order is ?c
        - ?created = 0 - ?c
    Used by: keys()
  keys(?t, ?r, ?b, ?g, ?p, ?u, ?un, ?own, ?inc, ?created) [ordering rules]
    (1) all of:
        - selected(?t, ?r)
        - ?r's band is ?b
        - ?b ≤ 3
        - fixed-key(?t, ?r, ?b, ?g, ?p)
        - ?u = 0 + 0
        - ?un = 0 + 0
        - ?own = 0 + 0
        - ?inc = 0 + 0
        - ?t's number is ?created
    (2) all of:
        - selected(?t, ?r)
        - ?r's band is ?b
        - ?b > 3
        - age(?t, ?r, ?created)
        - ?g = 0 + 1
        - ?p = 0 + 0
        - ?u = 0 + 0
        - ?un = 0 + 0
        - ?own = 0 + 0
        - ?inc = 0 + 0
    (3) all of:
        - selected(?t, ?r)
        - ?r's band is ?b
        - ?b > 3
        - no match for: age(?t, ?r, anything)
        - ?g = 0 + 0
        - ?r's preference is ?p
        - ?t's urgency sort key is ?u
        - ?t's owned-by-viewer sort key is ?own
        - ?t's incomplete-label sort key is ?inc
        - ?t's creation order is ?created
        - ?r's kind is ?k
        - at least one of (joined on ?t, ?k, ?un):
            (1) all of:
                - the context records assessment action kind ?k
                - ?un = 0 + 0
            (2) all of:
                - no match for: the context records assessment action kind ?k
                - ?t's number of dependents it unlocks is ?n
                - ?un = 0 - ?n
    Used by: query q4
  fixed-key(?t, ?r, ?b, ?g, ?p) [ordering rules]
    (1) all of:
        - ?t has some kind
        - ?r's band is ?b
        - ?b = 1
        - ?g = 0 + 0
        - ?p = 0 + 0
    (2) all of:
        - ?t's linked-to-viewer sort key is ?g
        - ?r's band is ?b
        - ?b = 2
        - ?r's preference is ?p
    (3) all of:
        - ?t's repository ownership inventory context is true
        - ?r's band is ?b
        - ?b = 3
        - ?r's preference is ?g
        - ?p = 0 + 0
    (4) all of:
        - ?r's band is ?b
        - ?b = 3
        - ?r's preference is ?g
        - ?t's number of active dependents is ?n
        - ?p = 0 - ?n
    Used by: keys()

== Evidence every rule may show ==
  impact (common): ?t's impact size is ?value
  complexity (common): ?t's complexity size is ?value
  impactState (common): ?t's impact assessment state is ?value
  complexityState (common): ?t's complexity assessment state is ?value
  head (common): ?t's head commit is ?value
  responsible (common): ?t has responsible agent ?value
  labelsComplete (eligibility): ?t's completeness of label evidence is ?value
  nativeComplete (eligibility): ?t's completeness of native dependency evidence is ?value
  openBlockers (eligibility): ?t's number of open blockers is ?value
  readiness (eligibility): ?t has label ?value and ?value is in the constant set "readiness"

== Constant sets ==
  small: "XS", "S"
  large: "L", "XL", "XXL"
  needs-assessment: "unassessed", "stale"
  bad-assessment: "invalid", "conflict"
  prerequisite: "status:needs-design", "question", "design:decision-needed", "status:blocked", "status:parked"
  design-label: "documentation", "status:needs-design"
  failure: "FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"
  pending: "PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"
  known-check: "SUCCESS", "NEUTRAL", "SKIPPED", "FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE", "PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"
  merge-state: "CLEAN", "HAS_HOOKS", "UNSTABLE"
  refresh-state: "BEHIND", "UNKNOWN"
  unknown-mergeable: "UNKNOWN"
  readiness: "status:ready", "status:incomplete"
  question-label: "question", "design:decision-needed"

== Inputs (lexicon) ==
Viewer facts:
  agent: agent name
  role: role
  platform: platform
  order: requested order
Attributes:
  ownership-inventory: repository ownership inventory context
  claim-activity: activity of your retained claim (active, waiting, resume-required or unknown)
  wait-reason: what your retained claim waits on, or why its activity is unknown
  owned-claims: number of implementation claims you retain
  owned-claims-complete: completeness of your claim inventory
  owned-review-subject: the claim the owned-work review is attached to
  active-count: number of active dependents
  active-dependent: active dependent
  assessment-kind: assessment action kind
  attention: agent whose attention is requested
  band: band
  blocker: native blocker
  blocking-complete: completeness of dependent coverage
  check: check run
  closes: issue it closes
  closing: closing pull request
  complexity-size: complexity size
  complexity-state: complexity assessment state
  created: creation order
  dependent: native dependent
  draft: draft flag
  forward-complete: completeness of forward closing-PR evidence
  head: head commit
  impact-size: impact size
  impact-state: impact assessment state
  incomplete-key: incomplete-label sort key
  kind: kind
  label: label
  labels-complete: completeness of label evidence
  linked-key: linked-to-viewer sort key
  matched: matched decision rule
  merge-state: merge state
  missing-required: required check not yet reported
  native-checks-satisfied: materialized native required-check query result
  required-evidence-complete: completeness of target required-check evidence
  required-evidence-gap: unread target required-check evidence
  mergeable: mergeability
  name: name
  native-complete: completeness of native dependency evidence
  number: number
  open-blockers: number of open blockers
  outcome: outcome
  overridden: overridden decision rule
  own-key: owned-by-viewer sort key
  owner: claiming agent
  platform: required platform
  pr-complete: completeness of pull request evidence
  preference: preference
  provider-commit: provider-reviewed commit
  provider-review: configured review provider evidence
  provider-state: provider review state
  question-record: question record
  receipt: review receipt
  receipt-commit: reviewed commit
  receipt-findings: findings flag
  receipt-status: receipt status
  record-outcome: explicit resolution outcome
  record-to: addressee
  record-trust: trust level
  record-version: question marker version
  resolved: resolved flag
  responsible: responsible agent
  review-coverage: declared review coverage
  required: check requiredness
  reverse-complete: completeness of reverse closing-PR evidence
  review: review
  review-commit: reviewed commit
  review-decision: review decision
  review-state: review state
  rule: rule ID
  state: state
  target: target
  thread: review thread
  unlock-count: number of dependents it unlocks
  unlock-unknown: reason the unlock count is unknown
  unlocks-dependent: dependent it would unlock
  urgency-key: urgency sort key
  closed-label: closed or merged pull request state
  no-run-time: whether a cancelled check had no recorded run time
  pending-count: number of pending checks
  base-ref: pull request base branch
  unresolved-threads: number of unresolved review threads
  policy-effective: effective declared review policy
  policy-unknown-reason: reason the declared review policy is unknown
  policy-head-reviewed: whether the declared review policy accepted the current head
  policy-has-findings: whether the declared review policy has unresolved head findings
  policy-summary: configured review providers' current-head states
  provider-finding: unresolved finding from a configured review provider
  provider-label: review provider display label
  finding-source: review finding source URL
  codex-findings: whether legacy Codex receipt reports findings on the current head
  codex-stale: whether legacy Codex coverage is stale against the current head
  codex-running: in-progress status of Codex's current-head review
  review-request-status: status of an explicit review request

== Not formalized here ==
  - Commands that change GitHub (deps add/remove, claim, release, needs-human, estimate N, issue create) enforce their own guards in TypeScript. Compiling this policy does not prove that every such guard is encoded in Datalog.
  - Collecting GitHub evidence and turning it into the input facts named under Inputs happens in TypeScript before the policy runs; it is not shown here.
  - Runtime explanations (each recommendation's why text) explain individual matches and are not the source of this listing.

Coverage of the full policy: 38 decision rules, 9 denials, 83 predicates (162 definitions), 19 queries, 4 sort key queries, 39 evidence bindings, 4 declared overrides, 14 constant sets, 94 attributes, 847 clauses.
