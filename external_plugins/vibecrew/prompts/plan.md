<!--
plan.md — the canonical planning method. The `planner` agent owns planning and
uses this as its shape; it is self-contained so a self-driving coding agent can
be handed it directly when no separate planner runs. Fill {{TASK}} with the
card's title + spec before sending.
-->
Plan the task below for this repository and save the plan as
`IMPLEMENTATION_PLAN.md` at the workspace root, before any code is written.

In VibeCrew the workspace root is the git worktree, so the plan lands inside the
repo. It is pipeline paperwork, not a deliverable: right after writing it,
append `IMPLEMENTATION_PLAN.md` and `SPEC.md` to the repo's exclude file (the
path printed by `git rev-parse --git-path info/exclude`) so neither can be
committed.

If `SPEC.md` exists at the workspace root, it is the authoritative spec: read
it first and ground the plan in it, so that each acceptance criterion in it is
covered by a step or by the Verification section.

## Task
{{TASK}}

## How to plan
Read the relevant code first and ground every step in real files; a plan that
names the wrong function or assumes a structure that isn't there is worse than
no plan. Then write `IMPLEMENTATION_PLAN.md` in this shape:

```
## Implementation plan: <title>

**Goal:** <what "done" looks like, traceable to the task>
**Approach:** <strategy in 2–4 lines; note any alternative you rejected and why>

### Steps (ordered; each one small and independently verifiable)
1. <imperative step> — files: `path/one`, `path/two`; done-when: <observable check>
2. <…>

### Verification
<how the whole change is proven — tests to add/run, build/lint, manual checks;
concrete commands where you know them>

### Risks / open questions
<unknowns, ordering constraints, unverified assumptions, anything needing a
decision before/while building>
```

Keep each step small enough for one focused turn, and order the steps so each
depends only on earlier ones. Name every file a step touches, including every
call site of a signature you change.

## Then stop
Save the file at the workspace root, confirm in one line that it is written,
and stop without implementing. The next instructions are a codex review of the
plan, then step-by-step development.
