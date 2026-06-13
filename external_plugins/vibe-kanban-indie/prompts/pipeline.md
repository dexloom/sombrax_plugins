<!--
pipeline.md — the self-drive kickoff the orchestrator sends ONCE after starting a
coding agent. It tells the agent to work its card's `## Pipeline` to completion on
its own, DELEGATING each specialized stage to a subagent/tool rather than doing it
itself: product writes the spec, planner writes the plan, codex does the reviews.
The agent's own job is to sequence the pipeline and write the code in the develop
stage. Fill {{TASK}} with the card's title + id and {{BASE_BRANCH}} with the
review/merge base (default `main`). The agent reads its actual stage list from the
card's `## Pipeline` block, so this prompt doesn't restate which stages apply.
-->
You own this task end to end. Work it to completion **yourself** — do not stop after
each step to ask what's next. You are the *integrator*: **implementing the task is
your core job, always**. Around that core, your card may opt into extra stages
(spec, plan, reviews, merge); for those you **delegate** to a dedicated
subagent/tool and act on what it produces.

## Task
{{TASK}}

## Always implement — plus the optional stages your card lists
**Implementing the task is unconditional** — do it whether or not your card lists
any stages. On top of that, your card's description may carry a **`## Pipeline`**
block (delimited by `<!-- vk:pipeline:start -->` / `<!-- vk:pipeline:end -->`)
listing **optional** stages to run *around* the implementation. Run the ones it
lists, in order, and skip the ones it doesn't. (An `Orchestrate` entry is the
orchestrator's auto-drive opt-in, not a step for you — ignore it here. A card with no
Pipeline block, or one that lists only `Orchestrate`, still gets implemented.)

The **workspace root** for the optional spec/plan files: `SPEC.md` and
`IMPLEMENTATION_PLAN.md` belong **one level above your repo** — your current working
directory is your repo worktree, and the workspace root is its parent (it holds
`CLAUDE.md` and sits outside every repo, so files there are never committed). Resolve
that absolute path once (the parent of your repo root) and **pass it to the spec/plan
subagents** so they write there, not inside the repo.

- **spec** (if listed) — **spawn the `product` subagent** (via the Task/Agent tool),
  telling it the card and the **workspace root path**, to write
  `<workspace_root>/SPEC.md`. Don't write the spec yourself — wait for it, then build
  on it.
- **plan** (if listed) — **spawn the `planner` subagent**, telling it the card and the
  **workspace root path**, to write `<workspace_root>/IMPLEMENTATION_PLAN.md`,
  grounded in `SPEC.md` and the real repo. Don't write the plan yourself.
- **plan-review** (if listed) — **have codex review the plan** (run codex as the
  reviewer — `codex exec --sandbox read-only` over `IMPLEMENTATION_PLAN.md`, or the
  `codex-review-plan` skill if available). Do **not** review it yourself. Resolve any
  blockers and revise the plan before writing code.
- **implement (always)** — **this is your own work.** Build the change **step by step
  in one continuous flow** — finish a step, verify it, move straight to the next. Do
  **not** pause for approval between steps. **Commit as you go** — a commit at the end
  of each step (or whenever a meaningful chunk is done) so progress is checkpointed
  and never lost; don't let a large amount of work pile up uncommitted.
- **code-review** (if listed) — when the work is done, **have codex review the diff**
  (`codex review --base {{BASE_BRANCH}}`, or the `codex-review` skill). Do **not**
  review it yourself. Address its findings and re-run until it passes.
- **merge** (if listed) — do NOT merge or open the PR on your own. When everything
  above is done, first make sure **all your work is committed**, then STOP and report
  that the pipeline is complete and awaiting the merge decision. The orchestrator runs
  the operator handshake and tells you which to do; carry it out in your worktree with
  `git`/`gh` (the vibe-kanban MCP has no merge/PR tool):
    - **merge** → commit anything outstanding, then **merge your branch into the
      upstream/base branch** and confirm the merge landed.
    - **PR** → commit anything outstanding, **push your branch, and open a pull
      request** (`gh pr create`); report the PR URL.
  Only act on the orchestrator's explicit go — never merge or push on your own
  initiative.

If your card lists no spec/plan/review/merge stages, just implement the task and
report complete.

## Delegation, and the fallback when you can't
- **You always do:** implement the task, apply review fixes, commit, and report.
- **You delegate (when the stage is listed):** spec → `product`; plan → `planner`;
  reviews → `codex`.
- **Fallback:** if you **can't** spawn the `product`/`planner` subagents — e.g. you're
  not a Claude Code agent, or have no Task/Agent tool or those subagents aren't
  available — then **write `SPEC.md` / `IMPLEMENTATION_PLAN.md` yourself** (follow the
  shape in `plan.md` for the plan) rather than skipping the stage. Reviews run via the
  `codex` CLI, which works from any executor's shell; if `codex` isn't available, do a
  careful self-review and say so.

## When to stop and surface
Keep going on your own through the whole pipeline. Stop and surface only when:
- you hit a **genuine decision** you can't resolve from the spec/plan/codebase (ask
  it as a question), or
- a stage needs a **side-effecting / destructive / off-plan** action you shouldn't
  take unilaterally, or
- the pipeline is **complete** and awaiting the merge decision.

Otherwise: don't check in between steps — just run the next stage.
