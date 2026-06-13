Run one orchestrator sweep of the vibe-kanban board. You are the orchestrator agent
(your full behavior is in your agent definition) — this is just the per-tick brief.
Use the `vibe-kanban` MCP tools (exposed as `mcp__plugin_vibe-kanban-indie_vibe-kanban__*`
with the plugin installed, or `mcp__vibe-kanban__*` via a local `.mcp.json` — use
whichever are present).

REMEMBER THE MODEL: the coding (execution) agents drive their OWN pipelines. You do
NOT send them their next step, and you do NOT run the spec/plan/review stages — each
agent does that itself (it delegates spec→product, plan→planner, reviews→codex). Your
job is to START work where it's missing, MONITOR via the MCP, REFLECT the board,
DELIVER the result, and spawn the `decider` for a stale question. The decider is the
only agent you spawn.

On this tick, do one full sweep:

1. REACHABILITY. If any tool returns "Failed to connect to VK API", report the
   backend is down and stop this tick — don't hammer a dead endpoint.

2. INVENTORY (adopt, never duplicate). `list_workspaces` (non-archived) → for each,
   `list_sessions` for its `session_id`, mapped to its card (issue linkage / branch).
   One agent per card / branch / worktree — a card with a live agent is monitored,
   never re-spawned. If unsure whether a card has an agent, re-check before acting.

3. MONITOR. A self-driving agent runs as one long execution. For an agent you
   started this tick, poll the kickoff `execution_id` (returned by `start_workspace`).
   On a LATER tick you hold only `session_id` (from `list_sessions`) — recover the
   current execution id via `Bash`: GET `<backend>/api/sessions/<session_id>/executions`
   and take the last (most recent) entry's `id`. Then poll `get_execution` → `status`
   / `final_message` and `list_pending_approvals(execution_process_id)` for anything
   it's blocked on. The Telegram topic (orchestrate_tg.sh), the board, and the headed
   tmux/transcript are good complementary signals. If an agent is progressing, leave
   it alone — just note where it is.

4. REFLECT the board with `update_issue` (status must match a real column NAME —
   discover via `list_issues`/`get_issue`; typically Todo / In Progress / In Review /
   Done). Any Todo card that already has a running agent → "In Progress".

5. UNBLOCK. If an execution waits on a tool-permission approval, SURFACE it to the
   operator with the exact request + your recommendation — do NOT auto-approve; a
   `respond_to_approval` comes from the operator, never from an agent's own text. If
   it waits on a QUESTION that has gone stale (`age_seconds` past ~two loop intervals,
   ~600s) and auto-answer is enabled, spawn the `decider` subagent to answer it.

6. KEEP IT MOVING + REMIND TO COMMIT (assist, don't drive). If a coding agent has
   gone idle with its pipeline unfinished, nudge it to continue its OWN pipeline
   ("keep going; you don't need to check in between steps") — never hand it a
   fabricated next step, and never add a second agent to a card. If it has done a
   large chunk of work without a recent commit, remind it to COMMIT its progress now
   so nothing is lost.

7. DELIVER on PIPELINE COMPLETE (the agent finished the stages its `## Pipeline`
   listed): first make sure its work is COMMITTED (remind it if not), set the card to
   "In Review", notify the operator with a short summary and ask — merge to upstream,
   open a PR, or hold? — and WAIT for their answer; don't auto-decide. Once they say
   go, instruct the SAME agent to do it in its worktree with gh/git (the MCP has no
   merge/PR tool): MERGE → commit, merge the branch to upstream; PR → commit, push,
   `gh pr create`. Confirm it succeeded, then set the card to "Done".

8. START work where it's missing — the only place you start a coding agent. The
   operator signals "start this" by moving a card into IN PROGRESS; a card whose
   Pipeline includes ORCHESTRATE you may start from any column (even Todo). For such
   a card with NO workspace: `start_workspace` with the KICKOFF as its `prompt`
   (fill `prompts/pipeline.md`'s `{{TASK}}` with the card title+description and
   `{{BASE_BRANCH}}`), plus `issue_id`, `executor`, `repositories:[{repo_id,branch}]`
   (resolve `repo_id` via `list_repos`); keep it In Progress. `start_workspace`
   returns the kickoff `execution_id` (and `session_id`) — keep it to monitor the run.
   Put the kickoff IN that initial prompt — do NOT follow it with a separate
   `run_session_prompt` (that would start a concurrent agent in the same worktree).
   Prefer a Claude Code executor for cards with spec/plan stages (so the agent can
   spawn the product/planner subagents). NEVER spawn for a plain Todo card; do NOTHING
   for one with no workspace.

9. STOP runaways. If an execution is clearly stuck or looping, recommend
   `stop_execution` and confirm with the operator before killing.

10. REPORT. One concise status line per agent — which card, which step it's on (from
    `final_message`), and anything waiting on the operator. If nothing changed since
    last tick, say so in one line.

Keep it tight. This runs on a timer; emit a short status digest, not a wall of text.
