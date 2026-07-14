# Orchestration prompts

Reusable prompts for the **one** Claude Code agent that vibe-kanban runs per card.
In this model the coding agent **drives its own pipeline** — it gets the card (whose
description carries a `## Pipeline` block) and runs it end to end without handing
control back between steps. It is the *integrator*: it writes the code in the
**develop** stage and **delegates** the specialist stages — the **spec** to the
`product` subagent, the **plan** to the `planner` subagent, and both **reviews** to
**codex**. The orchestrator does **not** feed it steps: it **only monitors and reflects
the board**. The agent delivers its own result — including the merge or PR, when its
card lists that stage.

So the prompt set is small: a **kickoff** that tells the agent to self-drive its
pipeline (delegating as above), plus two **methods** for stages that benefit from a
fixed shape (the plan's shape, the codex review). Review uses **codex**, run by the
agent locally — it's already in the worktree with the code.

## The set
| file | purpose | placeholders |
|------|---------|--------------|
| `pipeline.md` | The **kickoff** the orchestrator sends once after starting the agent: work your card's `## Pipeline` to completion on your own; stop only for a genuine question, at a **Wait-for-approval** gate, or when the pipeline is **complete** (a listed `merge`/`pr` stage the agent performs itself). | `{{TASK}}`, `{{BASE_BRANCH}}` |
| `plan.md` | The canonical planning method — the shape for `IMPLEMENTATION_PLAN.md` (written at the workspace root). Self-contained; used by the coding agent for its plan stage (or by the standalone `planner` agent if a human invokes it). | `{{TASK}}` |
| `codex-review.md` | Gate with codex: `codex exec --sandbox read-only … < /dev/null` for the plan, the piped `codex review --base <base>` for the diff — never leave codex's stdin open. Reports `PASS`/`CHANGES REQUESTED`. | `{{BASE_BRANCH}}` |

## How it fits together
```
orchestrator: start_workspace (kickoff = filled pipeline.md as its prompt) ─▶ MONITOR (get_execution / final_message)
coding agent (self-driven):  spec [→product] → recall-knowledge → plan [→planner] → plan-review [→codex] ──loop──▶ develop (its own code) → code-review [→codex] → update-docs → enrich-knowledge → Wait-for-approval (PARK on marker → operator approves → resume) → merge/pr (if listed: squash-merge into the base / open the PR — autonomously) → STOP "complete"
orchestrator: dev finished + reviewed ─▶ In Review ; merge/PR actually landed ─▶ Done
```
The orchestrator owns *board state* for managed cards — it **reflects** status by
reading the agent's `final_message` / the card's PR fields and moving the card forward
(In Review when dev is finished + reviewed, Done once the merge/PR has landed). It is
**read-and-reflect only**: the operator makes the merge decision **up front, by ticking
the `merge`/`pr` stage on the card** — the coding agent then performs it — and the
orchestrator never performs or instructs the merge/PR itself. The coding agent owns
*execution* — it writes the code and delegates spec→`product`, plan→`planner`,
reviews→`codex`. The orchestrator never sends a per-step prompt.

## Placeholders
- `{{TASK}}` — the card's title + id (and spec, if you have it).
- `{{BASE_BRANCH}}` — review/merge base branch (default `main`).

## Note
These are prompts for the *coding* agent, written to be self-contained (they don't
assume a skill is installed in that agent's environment). The `codex-review` prompt
falls back to an inline review if the `codex` CLI isn't available.
