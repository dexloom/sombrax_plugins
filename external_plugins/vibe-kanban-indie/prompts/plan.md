<!--
plan.md — sent by the orchestrator to the spawned coding agent to produce the plan.
Fill {{TASK}} with the card's title + spec before sending. The agent writes the
plan as a file in its own worktree; nothing is stored on the board card.
-->
You are working the task below in this repository. **Before writing any code**,
produce an implementation plan and save it as `IMPLEMENTATION_PLAN.md` at the repo
root. Add `IMPLEMENTATION_PLAN.md` to `.gitignore` (create or append) so it stays
a local working artifact and is never committed to the mainline — it guides this
job and is left behind when the branch merges.

## Task
{{TASK}}

## How to plan
Read the relevant code first and ground every step in real files — a plan that
names the wrong function or assumes a structure that isn't there is worse than no
plan. Then write `IMPLEMENTATION_PLAN.md` in this shape:

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

Keep steps small enough that each is one focused turn, and ordered so a later step
only depends on earlier ones.

## Then stop
Save the file, confirm in one line that it's written (and gitignored), and **stop
— do not start implementing**. The next instruction will be a codex review of the
plan, then step-by-step development.
