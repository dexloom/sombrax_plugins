<!--
codex-review.md — sent by the orchestrator to the spawned coding agent to gate
work with codex. Use plan mode after planning, diff mode after building. Set
{{BASE_BRANCH}} (default `main`). The agent runs codex locally (it has the code),
reports a verdict, and waits — it does NOT fix things in this turn.
-->
Run an independent review with the **Codex CLI** and report the result. Do **not**
fix anything in this turn — review, summarize, and wait. Codex runs read-only.

Pick the mode that matches where we are:

## Reviewing the PLAN (before any development)
```
codex exec --sandbox read-only "Review this implementation plan before any code is written. Read the plan at ./IMPLEMENTATION_PLAN.md and the project guidelines at ./CLAUDE.md if present. Assess: is the approach correct and complete, are the steps grounded in the real code, does it actually satisfy the task, and what is missing or risky? Separate blockers (must fix) from recommendations and nits."
```

## Reviewing the DIFF (after a step, or before marking done)
```
echo "Review for: correctness bugs, missed requirements, regressions, error handling, and consistency with the codebase and CLAUDE.md. Separate blockers from recommendations and nits." | codex review --base {{BASE_BRANCH}}
```

## Report back in this shape
```
CODEX VERDICT: PASS | CHANGES REQUESTED
Blockers (must fix):   <list, or "none">
Recommendations:       <list, or "none">
Nits:                  <list, or "none">
Bottom line:           <one or two sentences; for a plan, also: does it satisfy the task?>
```

`PASS` = no blockers. Any blocker → `CHANGES REQUESTED`.

If the `codex` CLI isn't installed or fails, **say so explicitly** and perform the
review inline against the same criteria — don't silently skip it. After reporting,
**stop and wait**: the orchestrator decides whether to revise or proceed.
