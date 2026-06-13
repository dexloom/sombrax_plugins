# Orchestration prompts

Reusable prompts the **`orchestrator`** agent sends to the **one** Claude Code
(Headed) agent it spawns per card, to drive it through the development lifecycle.

This matches vibe-kanban's grain: it runs **one coding agent per session**, and
you interact with it by sending **prompts**. The **spec** and **plan** stages,
though, are owned by *separate* agents — the **`product`** agent writes the spec
and the **`planner`** agent writes the plan (each persisting a board artifact) —
so the coding agent starts from a ready `SPEC.md` + `IMPLEMENTATION_PLAN.md` and
these prompts drive only what *it* does: review, and step-by-step development.
Review uses **codex**, delivered as a prompt the agent runs locally (it's already
in the worktree with the code).

## The set
| file | purpose | placeholders |
|------|---------|--------------|
| `plan.md` | The canonical planning method — the **`planner`** agent's shape (it persists the card's Plan artifact, materialised as `IMPLEMENTATION_PLAN.md` at the workspace root). Self-contained so it can also be handed directly to a self-driving coding agent when no separate planner step runs. | `{{TASK}}` |
| `codex-review.md` | Gate with codex: `codex exec --sandbox read-only` for the plan, `codex review --base <base>` for the diff. Reports `PASS`/`CHANGES REQUESTED`. | `{{BASE_BRANCH}}` |
| `step.md` | Implement one plan step, then stop. | `{{N}}`, `{{STEP}}` |

## How the orchestrator uses them
```
spec (product) → plan (planner) → codex-review (plan) ──loop until PASS──▶ step 1 → step 2 → … → codex-review (diff) → done
                                   └─ spec & plan land as ./SPEC.md + ./IMPLEMENTATION_PLAN.md before the coding agent starts ─┘
```
The orchestrator owns progress (which stage/step we're on, what's next). It
sequences the **`product`** (spec) and **`planner`** (plan) agents first, then
fills the `{{placeholders}}` and sends the review/step prompts to the spawned
coding agent via `run_session_prompt` or the agent's Telegram topic. The coding
agent does the build and codex; the orchestrator **decides and sequences**, and
never lets it idle waiting on a human for a routine next step.

## Placeholders
- `{{TASK}}` — the card's title + spec.
- `{{N}}`, `{{STEP}}` — the step number and text from `IMPLEMENTATION_PLAN.md`.
- `{{BASE_BRANCH}}` — review base branch (default `main`).

## Note
These are prompts for the *spawned* agent, written to be self-contained (they
don't assume a skill is installed in that agent's environment). The `codex-review`
prompt falls back to an inline review if the `codex` CLI isn't available.
