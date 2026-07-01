<!--
plan.md — the canonical planning method. Planning is owned by the dedicated
`planner` agent (it writes `IMPLEMENTATION_PLAN.md` at the workspace root); this
prompt is that agent's shape/method. It is also kept self-contained so a
self-driving coding agent can be handed the same prompt directly when no separate
planner step is run. Fill {{TASK}} with the card's title + spec before sending.
-->
You are planning the task below for this repository. **Before any code is
written**, produce an implementation plan and save it as `IMPLEMENTATION_PLAN.md`
at the **workspace root** (next to `CLAUDE.md`, one level above the git repos —
that location is outside every repo worktree, so the file is never committed and
needs no gitignore entry). It guides this job and is left behind when the branch
merges.

If `SPEC.md` exists at the workspace root, it is the authoritative spec for this
task — read it first and ground the plan in it. If `PRIOR_KNOWLEDGE.md` exists there
too (written by the `recall-knowledge` stage), read it as well — it distills what
this project's knowledge base already knows; reuse its established patterns/decisions
instead of re-deriving them, and apply each fact to the repo named in its scope.

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
Save the file at the workspace root, confirm in one line that it's written, and **stop
— do not start implementing**. The next instruction will be a codex review of the
plan, then step-by-step development.
