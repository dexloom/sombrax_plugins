# Reference — sweep-mode long-forms (quiesce, classification, dispatch)

> Read-on-demand reference for `agents/orchestrator.md`. Read this file before the
> session's **first** sweep-mode tick. Behavior is carried over verbatim from the
> pre-0.4.0 sweep logic.

## Quiescing the Orchestrator standby workspace

The orchestrator runs against a **standby workspace** named **"Orchestrator"** (branch
**"orchestrator"**) that has **no repositories** — it represents the orchestrator
session, not a card. Because it has no repo but stays non-archived, the board UI keeps
polling its `GET /api/workspaces/{id}/git/status` and opening its diff WebSocket, and
every one of those calls fails with *"Workspace has no repositories configured"* — a
500 + WARN flood that never stops on its own. So a *dead* standby should be archived to
leave the board's polled active set — **but only once its orchestrator session is over.**

An earlier version of this step archived the standby **unconditionally** on every
tick, which archived it *out from under the live orchestrator that the workspace
backs* — the bug this rule now fixes. The rule is therefore: **archive a matched
standby only when its orchestrator session is OVER (its tmux session is gone / its
execution has finished); never while a live session backs it.** There is **no separate
"is this me?" self-identification step** — *"never archive a standby with a live
orchestrator session"* inherently protects your own backing workspace, because if you
are that standby's session then it is live (your execution isn't finished and/or your
tmux session exists), so the liveness check below leaves it alone.

From the non-archived `list_workspaces` inventory the sweep already fetched:

- Find any workspace whose **`name == "Orchestrator"`** or **`branch == "orchestrator"`**
  (exact match — this is the standby's stable identity). **Key off name/branch, never a
  hardcoded UUID**, so the rule survives the workspace being re-created with a fresh id.
- **Liveness / "over" detection** (decide per matched standby; archive **only** if its
  orchestrator session is over). Derive state from the API every time:
  1. `list_sessions(workspace_id)` → every session flagged `is_orchestrator_session:
     true`. **If there is no such session at all ⇒ the standby is orphaned ⇒ OVER ⇒
     archive.**
  2. For **each** orchestrator session, recover its latest execution: `Bash` GET
     `$VIBE_BACKEND_URL/api/sessions/<session_id>/executions`, take the last entry;
     `get_execution(execution_id)` → `is_finished`/`status` and `tmux_session_name`
     (`= vk-<execution_id>`, present for headed runs).
  3. A session is **LIVE** (⇒ do **not** archive) if **either** its execution is **not
     finished** (still running — covers a non-headed live orchestrator) **or** its tmux
     session **exists**: `Bash` `tmux has-session -t =vk-<execution_id>` (note the `=`
     exact-match target). It is **OVER** only when it is **finished AND** its tmux
     session is **absent** (or it never had a tmux session and is finished).
  4. **Do not trust `status` alone** — a headed execution reads `running` after finishing
     a turn; `tmux has-session` is the decider for headed runs, `is_finished` for
     non-headed runs.
  5. **Archive iff EVERY orchestrator session of the standby is provably OVER** (or there
     are none). If **any** session is live — **or** its state is **indeterminate** (the
     executions API errored, the execution is missing/unreadable, or the `tmux` query
     errored) — **leave the workspace alone** and let a later sweep re-check. Indeterminate
     counts as live, never as over, so a momentary API hiccup can never archive a live
     orchestrator.
- Archive an over standby via `update_workspace(workspace_id, archived: true)`.
- This is **idempotent**: once archived, it no longer appears in the non-archived
  inventory, so later sweeps find nothing and do nothing; a live standby is simply never
  touched. If the app or operator re-creates/un-archives it, the next sweep re-archives
  it once liveness shows its session is over.
- **Guard:** only ever archive the name/branch-matched standby. **Never** archive a
  card-linked or repo-backed workspace — a real card workspace is named after the
  card's `simple_id`/title and branched off the card's branch, so it can't match
  `"Orchestrator"`/`"orchestrator"`. If a matched workspace looks like a real
  repo-backed/card workspace, leave it alone.
- **Report** one line only when you actually archive something (e.g. "Quiesced stale
  standby workspace Orchestrator (session ended, archived)"). When there's nothing to do
  (live session, indeterminate, or already archived), stay silent — no noise every tick.

Archiving the standby's *record* does not stop the running orchestrator session: it
runs in its own tmux session from a neutral temp dir (`scripts/orchestrator-attach.sh`
launches `claude` with `tmux new-session … -c "$(mktemp -d)"`), not from inside that
workspace's worktree — and, per the liveness rule above, you only ever archive a standby
whose session is already over. This is a plugin-level workaround; the upstream cure is
server-side (don't poll git/status or open a diff WS for a repo-less workspace).

## Finding the READY cards (classification, cache-gated)

`list_issues` — **always filtered to the target project, and status-filtered to the
non-terminal columns (Todo + In Progress); never all projects, never an unfiltered
`limit: 100` dump** — returns only a *summary* of each card: **status, id, title, PR
fields — but NOT the description**, and the `## Pipeline` / Orchestrate opt-in lives in
the **description**. You therefore **cannot judge readiness from the list alone**. Build
the candidate set = every card that has **no workspace yet** and is **not** in a
terminal column (every **Todo** and **In Progress** card without a workspace; Done is
excluded by the filter), then classify each candidate from its description —
**cache-gated by `cards{}`** (`reference/state-file.md` → the `cards{}` cache):

- **Cache hit** ⇔ `cards[I.id]` exists (and **survived validate-on-read**) **AND**
  `cards[I.id].updated_at` equals the candidate's **fresh** `list_issues.updated_at`,
  compared by **exact string equality** (never parsed, never ordered) ⇒ use the cached
  `class` / `executor_pin`; **do not call `get_issue`**.
- **Cache miss** — entry absent, **DROPPED** by validate-on-read, or the stamps differ
  ⇒ `get_issue(I.id)`, derive `class` and a **validated** `executor_pin` from the fresh
  description, and store `cards[I.id] = { updated_at: <get_issue's stamp>, class,
  executor_pin }`.

Do **not** conclude a Todo card has no opt-in because the list summary doesn't show
one — the summary *never* shows one; you must open the card (`get_issue`, or a cache
hit that already did). (This is the bug that once made the orchestrator skip every Todo
card: it judged from `list_issues` and never read the description.)

A candidate card is **ready to dispatch** when, after reading its description, either:
- its description carries a **`## Pipeline`** block whose stages include the
  **Orchestrate** opt-in (the line "Have the orchestrator agent pick this card up
  and drive it to done autonomously…") — you own these regardless of column, even
  from **Todo**; or
- it sits in **In Progress** with no workspace — moving a card into In Progress is
  the operator's "start this" signal (ready regardless of opt-in).

**Never start a plain Todo card** (a Todo card whose description has **no** Orchestrate
opt-in) — that is the operator's backlog. But you only know a Todo card is "plain"
*after* you've read its description; **never skip reading it**. Do nothing for cards
that already have a workspace.

**A dispatch always `get_issue`s the card, cache hit or not** — see *Starting a coding
agent* → `prompt`; the cache never supplies the `{{TASK}}` description.

### Which cards count as "managed"

A card is **orchestrator-managed** when its description's `## Pipeline` carries the
**Orchestrate** opt-in — these are the cards you were told to drive to done, so you own
their board state through the whole lifecycle. Classify each card with a workspace
before deciding it is managed — cache-gated by the same `cards{}` rule as above (reuse
the description you already fetched, or the `cards{}` hit, for any candidate that
overlaps). A plain In-Progress card with **no** Orchestrate opt-in is
operator-hand-driven: you may have dispatched it, but the operator owns its delivery, so
**do not** auto-advance it — leave its column alone. Only reflect status for managed
cards that currently have a non-archived workspace.

**Done is terminal — never track or re-report a Done card.** Before you walk a card,
check its column: if it is **already in Done**, drop it entirely — do **not** `get_issue`
it, do **not** read its agent (`list_sessions` / `get_execution`), do **not** reflect or
re-report it, and **drop its `cards{}` entry** (this column is terminal for the cache
too). You report a card's move to Done **exactly once**, on the tick you actually move
it; from the next tick on, that card is in Done and falls out of your working set
forever — and out of the retained active set.

## Resolving which execution agent to start

For each ready card, decide the `executor` in this order:

1. **Pinned in the card.** If the card's `## Pipeline` block contains an
   execution-agent directive — a line of the form
   **"Run this card with the `AGENT` execution agent: pass `executor: \"AGENT\"`…"** —
   use that `AGENT` as the `executor`. Read it from **`cards{}.executor_pin` on a cache
   hit**; on a cache miss, the classification `get_issue` you already ran supplies it
   from the fresh description. **Validate before use** — accept it **only** if it
   matches `^[A-Z][A-Z0-9_]*$` **and** is one of the known `BaseCodingAgent` keys
   (`CLAUDE_CODE`, `CLAUDE_CODE_HEADED`, `CODEX`, `GEMINI`, `AMP`, `OPENCODE`,
   `CURSOR_AGENT`, `QWEN_CODE`, `COPILOT`, `DROID`); **otherwise store `null`**, report
   the unrecognized pin loudly, and fall back to the config's last-used executor (item
   2 below). **Never store the raw string.**
2. **Otherwise, the operator's last-used / default agent configuration.** Resolve the
   backend base (`$VIBE_BACKEND_URL`, else the `vibe-kanban.port` file — same lookup
   as `scripts/resolve-backend.sh`) and `Bash`:
   `curl -s "$VIBE_BACKEND_URL/api/config"` → read `executor_profile.executor`. That
   field is exactly the executor the operator most recently used / set as default in
   the UI. Use it as the `executor` (and its `variant`, if present, as `variant`).

Never invent an executor or hardcode a favourite — the choice is always the card's
pin or the config's last-used value. If the config has no `executor_profile`
(unlikely), fall back to `CLAUDE_CODE` and say so in your report.

## Starting a coding agent

The MCP `start_workspace` **requires** a non-empty `executor`, so always pass the one
you resolved above. Build the call:

- **`prompt`** — the self-drive kickoff. **A dispatch ALWAYS `get_issue`s the card here
  — `cards{}` never supplies the `{{TASK}}` description**, cache hit or not (the cache
  only ever eliminates the *classification* `get_issue`, never this one). Read
  `${CLAUDE_PLUGIN_ROOT}/prompts/pipeline.md`, fill `{{TASK}}` with the card's title +
  description (the description already carries the `## Pipeline` block, so the coding
  agent reads its own stage list from there) and `{{BASE_BRANCH}}` with the base
  branch (default `main`). Pass that filled text as `prompt`. Putting the kickoff in
  this initial `start_workspace` prompt is what makes the agent self-drive — do **not**
  follow it with any separate prompt (that would launch a second concurrent agent in
  the same worktree).
- **`executor`** — the resolved key (card pin → last-used config); **`variant`** if
  the config provided one.
- **`issue_id`** — the card id, so the workspace is linked to the card.
- **`name`** — a short workspace name (the card's `simple_id`, e.g. `VIBE-20`, or its
  title); `start_workspace` requires a non-empty name.
- **`repositories`** — `[{ repo_id, branch }]`; resolve `repo_id` via `list_repos`,
  `branch` = the base branch.

`start_workspace` returns `workspace_id`, `session_id`, and `execution_id` — record them
in the retained active set (they are also re-derivable from the API at any time). After
it starts, set the card's status to **"In Progress"** (`update_issue`) so the board
reflects that it's been dispatched and you won't re-dispatch it next sweep. (Status must
match a real column NAME — discover the names from `list_issues`/`get_issue`; typically
Todo / In Progress / In Review / Done. If `update_issue` returns "Unknown status …
Available statuses: [...]", use one of those exact names.)

After dispatch your core job continues with **status reflection** — a read-only check of
each managed card's agent so you can advance its column. Beyond that you do not nudge,
remind to commit, review, **merge**, **open PRs**, approve tools, or answer questions —
the coding agent does all of that within its own pipeline, and it performs the merge/PR
itself, autonomously (ticking the default-off `merge`/`pr` stage IS the operator's
authorization). Status reflection only *reads* agent state and *moves the card*; it
never takes a side-effecting action on the work itself. The only other exceptions are
the opt-in directives (`reference/directives.md`), and only when their flag is present
in this run's prompt.

## Reading the agent's state (per managed card)

State is recoverable from the API at any time — the retained active set is a cache of
these lookups, never a substitute for them when in doubt:

1. From the non-archived `list_workspaces` inventory you have the card↔workspace
   mapping. For the card's workspace, `list_sessions(workspace_id)` → the coding
   `session_id` (skip `is_orchestrator_session: true`).
2. **Run the probe** — one call over the whole union set (`reference/delta-gate.md` →
   *Phase 1 — probe*). This is what recovers each session's current `execution_id`; the
   raw `Bash` GET `…/executions` is **not** part of this routine path — the probe owns
   that read, and returns `execution_id` on **both** `POLL` and `SKIP` lines, so the fat
   `ExecutionProcess` rows (each carrying the whole `executor_action`) never enter your
   context on a quiet tick. That raw GET survives **only** as the gate's documented
   fail-open fallback (CR-4), and only per `reference/delta-gate.md`.
3. `get_execution(execution_id)` → use **`final_message`** (the agent's latest report),
   **`pending_approvals`**, and `status`/`is_finished` — but **only for sessions the probe
   returned as `POLL`** (or for every session, when the gate failed its output contract
   and you fell back). A **`SKIP`** line means none of this changed: skip this call,
   leave the card's column as-is, and read the line's own fresh
   `is_finished` / `is_parked` / `has_approvals` / handles instead if a directive needs
   them.

**Important — don't trust execution `status` alone.** Headed agents
(`CLAUDE_CODE_HEADED`) keep their tmux session, so the execution can read `running`
even after the agent has finished its turn and posted a final report. The reliable
"the agent is done with this turn" signal is **`pending_approvals` is empty AND
`final_message` describes a completed milestone** — not `status == completed`.
