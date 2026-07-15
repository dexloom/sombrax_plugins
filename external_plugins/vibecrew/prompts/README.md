# Orchestration prompts

Reusable prompts for the **one** headless coding-agent process that VibeCrew runs
per run. In this model the coding agent **drives its own pipeline** — it gets the
card (whose description carries a `## Pipeline` block) and runs it end to end
without handing control back between steps. It is the *integrator*: it writes the
code in the **develop** stage and **delegates** the specialist stages — the
**spec** to the `product` subagent, the **plan** to the `planner` subagent, and
both **reviews** to **codex**. The orchestrator does **not** feed it steps: it
monitors and reflects the board via `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/
vibecrew_api.py …` — MCP-free, over the REST API. Card creation is an operator-
driven request to the `product` agent / `product-manager` skill, not something the
orchestrator does on the loop. The agent delivers its own result — including the
merge or PR, when its card lists that stage.

So the prompt set is small: a **kickoff** that tells the agent to self-drive its
pipeline (delegating as above), plus one **method** for the stage that benefits
from a fixed shape (the plan's shape). Review uses **codex**, run by the agent
locally — it's already in the worktree with the code (the stdin rules are inline
in `pipeline.md`; no separate `codex-review.md` ships in this plugin).

## The set
| file | purpose | placeholders |
|------|---------|--------------|
| `pipeline.md` | The **kickoff** the orchestrator sends once after starting the agent: work your card's `## Pipeline` to completion on your own; stop only for a genuine question, at a **Wait-for-approval** gate (commit, emit the marker, **let the process exit** — VibeCrew runs each turn as its own headless process), or when the pipeline is **complete** (a listed `merge`/`pr` stage the agent performs itself, via `git`/`gh` or `vibecrew_api.py merge|pr $VIBECREW_WORKSPACE_ID`). | `{{TASK}}`, `{{BASE_BRANCH}}` |
| `plan.md` | The canonical planning method — the shape for `IMPLEMENTATION_PLAN.md` (written at the workspace root). Self-contained; used by the coding agent for its plan stage (or by the standalone `planner` agent if a human invokes it). | `{{TASK}}` |

## How it fits together
```
orchestrator: start (kickoff = filled pipeline.md as its prompt) ─▶ POLL (run <run_id> -> final_message)
coding agent (self-driven, one headless process per run): spec [→product] → plan [→planner] → plan-review [→codex] ──loop──▶ develop (its own code) → code-review [→codex] → update-docs → Wait-for-approval (commit, emit marker, EXIT) → operator follow-up ─▶ fresh process resumes → merge/pr (if listed: merge into the base / open the PR — autonomously, and for a direct merge, report `merge_commit: <sha>`) → STOP "complete"
orchestrator: dev finished + reviewed ─▶ inreview ; merge/PR actually landed (merged PR, or a merge_commit line) ─▶ done
```
The orchestrator owns *board state* for managed cards — it **reflects** status by
polling the run's `final_message` / the card's PR fields (`card-prs`) and moving
the card forward (`inreview` when dev is finished + reviewed, `done` once the
merge/PR has landed per the delivery-signal gate in `CLAUDE.md`). It is
**read-and-reflect only**: the operator makes the merge decision **up front, by
ticking the `merge`/`pr` stage on the card** — the coding agent then performs it —
and the orchestrator never performs or instructs the merge/PR itself. The coding
agent owns *execution* — it writes the code and delegates spec→`product`,
plan→`planner`, reviews→`codex`. The orchestrator never sends a per-step prompt; a
Wait-for-approval decision reaches the parked agent as a `follow-up`, which starts
a fresh process resuming the same session.

## Placeholders
- `{{TASK}}` — the card's title + id (and spec, if you have it).
- `{{BASE_BRANCH}}` — review/merge base branch (default `main`).

## Note
These are prompts for the *coding* agent, written to be self-contained (they
don't assume a skill is installed in that agent's environment). Codex review
falls back to a careful self-review, stated as such, if the `codex` CLI isn't
available.
