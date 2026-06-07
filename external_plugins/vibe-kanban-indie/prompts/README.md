# Orchestration prompts

Reusable prompts the **`orchestrator`** agent sends to the **one** Claude Code
(Headed) agent it spawns per card, to drive it through the development lifecycle.

This matches vibe-kanban's grain: it runs **one coding agent per session**, and
you interact with it by sending **prompts** — there's no native team of
specialized agents in a workspace. So the lifecycle phases are *prompts*, not
separate agents. Review uses **codex**, delivered here as a prompt the agent runs
locally (it's already in the worktree with the code).

## The set
| file | purpose | placeholders |
|------|---------|--------------|
| `plan.md` | Produce `IMPLEMENTATION_PLAN.md` in the worktree — a gitignored, per-job working artifact, left/cleaned on merge (never on the card). | `{{TASK}}` |
| `codex-review.md` | Gate with codex: `codex exec --sandbox read-only` for the plan, `codex review --base <base>` for the diff. Reports `PASS`/`CHANGES REQUESTED`. | `{{BASE_BRANCH}}` |
| `step.md` | Implement one plan step, then stop. | `{{N}}`, `{{STEP}}` |

## How the orchestrator uses them
```
plan → codex-review (plan) ──loop until PASS──▶ step 1 → step 2 → … → codex-review (diff) → done
```
The orchestrator owns progress (which step we're on, what's next), fills the
`{{placeholders}}`, and sends each prompt to the spawned agent via
`run_session_prompt` or the agent's Telegram topic. The agent does the work —
plan, code, and codex; the orchestrator **decides and sequences**, and never lets
the agent idle waiting on a human for a routine next step.

## Placeholders
- `{{TASK}}` — the card's title + spec.
- `{{N}}`, `{{STEP}}` — the step number and text from `IMPLEMENTATION_PLAN.md`.
- `{{BASE_BRANCH}}` — review base branch (default `main`).

## Note
These are prompts for the *spawned* agent, written to be self-contained (they
don't assume a skill is installed in that agent's environment). The `codex-review`
prompt falls back to an inline review if the `codex` CLI isn't available.
