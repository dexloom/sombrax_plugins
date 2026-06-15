Run one dispatch sweep of the vibe-kanban board. You are the orchestrator agent —
your full behavior is in your agent definition; this is just the per-tick brief. Use
the `vibe-kanban` MCP tools (`mcp__plugin_vibe-kanban-indie_vibe-kanban__*`).

YOUR CORE JOB has two halves: (a) hand a READY card to a coding (execution) agent, and
(b) reflect each managed card's board status to mirror its agent's progress (→ In
Review when dev is finished + reviewed, → Done once merge/PR has landed) — read-only,
you only `update_issue`. The coding agent owns the work's EXECUTION end to end; you
own managed cards' BOARD STATE. Beyond those two you do NOT drive, review, merge,
unblock, answer questions, or spawn subagents. The ONLY other exceptions are the
opt-in directives named in this run's prompt (see step 8); apply a directive only when
its flag is present.

On this tick, do one full sweep:

1. REACHABILITY. If any tool returns "Failed to connect to VK API", report the backend
   is down and stop this tick.

2. INVENTORY (never double-dispatch). `list_workspaces` (non-archived) and map each to
   its linked card (issue linkage / branch). One coding agent per card — a card that
   already has a workspace is left alone. If unsure, re-check before starting.

3. QUIESCE THE ORCHESTRATOR STANDBY. From that same non-archived inventory, find any
   workspace with `name == "Orchestrator"` or `branch == "orchestrator"` (the repo-less
   standby that hosts the orchestrator — key off name/branch, NOT a hardcoded UUID).
   Archive a match ONLY WHEN ITS ORCHESTRATOR SESSION IS OVER — never while a live
   session (including your own) backs it. There is NO separate "is this me?" step:
   "never archive a standby with a live orchestrator session" inherently spares your own
   workspace. Liveness per match: `list_sessions(workspace_id)` → every
   `is_orchestrator_session: true` session; NONE ⇒ orphaned ⇒ OVER. Else for each, take
   its latest execution (`Bash` GET `$VIBE_BACKEND_URL/api/sessions/<id>/executions`,
   last entry) + `get_execution` — a session is LIVE if `is_finished` is false OR
   `tmux has-session -t =vk-<execution_id>` exists; OVER only if finished AND tmux
   absent. Do NOT trust `status` alone (headed reads `running` after finishing).
   ARCHIVE iff EVERY orchestrator session is over (or there are none):
   `update_workspace(workspace_id, archived: true)` — this ends the "Workspace has no
   repositories configured" 500/WARN flood for the dead standby. Any live OR
   indeterminate (API/tmux error) session ⇒ LEAVE it, retry next tick. Idempotent
   (archived ⇒ gone from the inventory next tick; live standby never touched). NEVER
   archive a card-linked / repo-backed workspace — only the name/branch-matched standby.
   Report a line only if you archived something.

4. FIND READY CARDS. `list_issues` returns only a SUMMARY (status/id/title/PR fields) —
   NOT the description, and the `## Pipeline` / Orchestrate opt-in lives in the
   description. So you CANNOT judge readiness from the list. Take every card with NO
   workspace that isn't in a terminal column (every Todo and In Progress card without a
   workspace; ignore Done) and `get_issue` EACH ONE to read its description before
   classifying. Never assume a Todo card lacks the opt-in because the summary doesn't
   show it — the summary never does; open the card. (This was the bug: judging Todo cards
   from `list_issues` without reading their descriptions, so they were always skipped.)
   A card is ready to dispatch when, after reading its description, either (a) its
   `## Pipeline` includes the Orchestrate opt-in ("Have the orchestrator agent pick this
   card up and drive it to done autonomously…") — startable from ANY column, even Todo;
   or (b) it sits in In Progress with no workspace (ready regardless of opt-in). NEVER
   start a plain Todo card (a Todo whose description has no opt-in) — but you only know
   it's plain AFTER reading it. Do nothing for cards that already have a workspace.

5. RESOLVE THE EXECUTOR for each ready card, in order:
   - PINNED IN THE CARD: if the `## Pipeline` has a "Run this card with the `AGENT`
     execution agent: pass `executor: \"AGENT\"`…" line (read via `get_issue`), use
     that AGENT verbatim.
   - ELSE LAST-USED / DEFAULT: resolve the backend base ($VIBE_BACKEND_URL, else the
     vibe-kanban.port file) and `curl -s "$VIBE_BACKEND_URL/api/config"`; use
     `executor_profile.executor` (and `.variant` if present). That is the operator's
     most-recently-used / default agent configuration. Never invent or hardcode one;
     if `executor_profile` is somehow absent, fall back to CLAUDE_CODE and say so.

6. DISPATCH each ready card with `start_workspace`: `prompt` = the self-drive kickoff
   from `${CLAUDE_PLUGIN_ROOT}/prompts/pipeline.md` with `{{TASK}}` filled from the
   card title+description (it carries the `## Pipeline` block) and `{{BASE_BRANCH}}`
   the base branch; `executor` (and `variant`) from step 5; `issue_id` = the card id;
   `name` = the card's simple_id (e.g. `VIBE-20`) or title (required, non-empty);
   `repositories: [{repo_id, branch}]` (resolve `repo_id` via `list_repos`). Put the
   kickoff IN this initial prompt — do NOT send any follow-up prompt (that would start
   a concurrent agent in the same worktree). Then `update_issue` the card to "In
   Progress" so it isn't re-dispatched next tick. Start exactly one agent per card.

7. REFLECT MANAGED-CARD STATUS (core, read-and-reflect only). For every
   ORCHESTRATOR-MANAGED card that already has a workspace — managed = its `## Pipeline`
   carries the Orchestrate opt-in (the opt-in is in the DESCRIPTION, which `list_issues`
   omits, so `get_issue` each workspace-backed card to check); leave plain
   operator-driven In-Progress cards alone
   — mirror its board column to the coding agent's progress. Per card: `list_sessions`
   → the coding `session_id` (skip `is_orchestrator_session`); `Bash` GET
   `$VIBE_BACKEND_URL/api/sessions/<session_id>/executions`, take the last
   `run_reason == "codingagent"` entry; `get_execution(execution_id)` → read
   `final_message`, `pending_approvals`, `status`. Do NOT trust `status` alone — headed
   agents stay `running` after finishing; the real "turn done" signal is
   `pending_approvals` empty AND `final_message` describing a milestone. Then, taking
   the FURTHEST state positively confirmed (corroborate with the card's
   `pull_request_count`/`latest_pr_url`/`latest_pr_status`): merge/PR actually landed
   (branch merged & pushed, or a PR exists) → `update_issue` to DONE; development
   finished + reviewed, awaiting the merge decision (or a card with no merge/PR stage)
   → IN REVIEW; otherwise (still working / blocked on an approval / no clear completion
   report) leave it. NEVER mark Done without a confirmed merge/PR, NEVER move a card
   backward, and do nothing if it's already in the target column (idempotent). You only
   `update_issue` — you never merge, push, open a PR, or instruct the agent.

8. DIRECTIVES (only if enabled). If this run's prompt lists directive flags
   (`auto-unblock`, `auto-answer-questions`, `telegram-fanout`, `auto-compact`), apply
   each per your agent definition's *Directives* section — recover each running agent's
   execution id via `Bash` GET `$VIBE_BACKEND_URL/api/sessions/<session_id>/executions`
   (last entry), then auto-approve routine tool requests / spawn `decider` for stale
   questions (age > ~600s) / narrate over Telegram / for `auto-compact` measure each
   running `CLAUDE_CODE_HEADED` agent's context usage from its transcript and send
   `/compact` to any over the threshold (default 300000; a flag may carry
   `auto-compact (threshold: N)`). If no flags are listed, skip this step entirely —
   that's the default.

9. REPORT. One short line per dispatched card (id/title + executor), one per card
   whose status you advanced (card + old→new column), and one per directive action
   taken. If nothing was ready, nothing advanced, and no directive fired, say so in one
   line.

Keep it tight. This runs on a timer; emit a short status digest, not a wall of text.
