<!--
codex-review.md — the method the self-driving coding agent uses to gate its own work
with codex: plan mode after planning, diff mode after building. Set {{BASE_BRANCH}}
(default `main`). The agent runs codex locally (it has the code), reports the verdict,
then resolves every blocker itself and reviews again until it PASSes. Nobody is waiting
on the other end of this review — it is a loop the agent closes on its own.
-->
Run an independent review with the **Codex CLI**, report the verdict, then **act on it
yourself**. Codex runs read-only: it reviews, **you** fix.

Pick the mode that matches where we are:

## Reviewing the PLAN (before any development)
```
codex exec --sandbox read-only "Review this implementation plan before any code is written. Read the plan at ./IMPLEMENTATION_PLAN.md and the project guidelines at ./CLAUDE.md if present. Assess: is the approach correct and complete, are the steps grounded in the real code, does it actually satisfy the task, and what is missing or risky? Separate blockers (must fix) from recommendations and nits." < /dev/null
```

## Reviewing the DIFF (after a step, or before marking done)
Use `codex exec` (not `codex review`) so the session can be resumed cheaply for
re-checks:
```
codex exec --sandbox read-only "Review the diff of this branch against its base. Run git diff {{BASE_BRANCH}} yourself and read any changed files you need. Review for: correctness bugs, missed requirements, regressions, error handling, and consistency with the codebase and CLAUDE.md. Separate blockers from recommendations and nits." < /dev/null
```

## Re-reviewing after fixes — resume the SAME session
After you fix blockers, **do not start a fresh review.** Codex already holds the
plan/diff, the files it read, and its own findings in context, so resuming costs a
fraction of the tokens and time of a new review:
```
codex exec resume --last "We fixed your findings: <one-line per fix>. Re-check the updated plan/diff and verify each finding is resolved. Report only unresolved or newly introduced blockers; if none, say PASS." < /dev/null
```
Run `resume` from the **same working directory** as the first review (`--last`
filters sessions by cwd). If `resume` fails (no session, CLI error), fall back to a
fresh full review with the first-pass command above.

**Never leave codex's stdin open.** `codex exec` (and `exec resume`) reads stdin
*in addition to* its prompt argument: launched from an agent's shell, stdin is an
open pipe that never sends EOF, so codex prints "Reading additional input from
stdin…" and **blocks forever** at 0% CPU. That is why every command here ends with
`< /dev/null`. Run codex from **inside the repo worktree** (not the workspace
root), and add `--skip-git-repo-check` only if codex complains that the directory
is untrusted.

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
review inline against the same criteria — don't silently skip it.

**Then close the loop yourself — this review is never a park.** On `PASS`, continue the
pipeline. On `CHANGES REQUESTED`, **resolve every blocker yourself** and **review again**:
resume the same codex session (`codex exec resume --last "…" < /dev/null`) if the CLI
works, or — if it doesn't — repeat the **inline** review against
the same criteria, again saying the CLI was unavailable. **Iterate until the verdict is
`PASS`**, then continue.

A blocker is resolved in exactly one of two ways: you **fix it** (revise
`IMPLEMENTATION_PLAN.md` for a plan review; change the code and commit for a diff review),
or — because codex does produce false positives — you **dismiss it in writing, with your
reason**, and carry that dismissal into the next verdict. Recommendations and nits are
yours to judge. There is no round limit and no "report the residuals and move on": nobody
else reviews this, and nobody is going to hand you a go. The **only** stop is the one your
kickoff already sanctions — a **genuine decision you cannot derive from the
spec/plan/codebase** — which you surface as a question.
