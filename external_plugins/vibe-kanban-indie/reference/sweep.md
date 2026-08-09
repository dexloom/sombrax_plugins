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

## The board shape — columns and sub-boards are DISCOVERED, never assumed

Two things that used to be constants are per-board data. Resolve both **once per
session** (they change rarely; re-resolve only when a write fails on an unknown status,
or an operator says the board changed) and keep them in retained context.

### Columns (`project_statuses`) — per project, fully custom

A board's columns are rows in `project_statuses`, with **arbitrary names**. The seeded
default is `Todo / In Progress / In Review / Done`, so most boards still look familiar
— but a board whose owner renamed or added columns is not an error case, it is the
supported case. **Never hardcode a column name into a filter.** Read the real set:

```
curl -sf "$VIBE_BACKEND_URL/api/project-statuses?project_id=<id>"
```

Each row carries `id`, `name`, `color`, `sort_order`, `hidden`. Classify them into the
three roles this file uses, and use the ROLE everywhere below:

- **TERMINAL** — `hidden == true`, **plus** the last non-hidden column by `sort_order`.
  (This is exactly the rule the app's own board UI applies; there is no `is_done` flag
  in the schema to read instead, so this heuristic IS the contract.) A card in a
  terminal column is finished: never enumerate, walk, dispatch, or re-report it, and
  drop its `cards{}` entry.
- **START-SIGNAL** — the second non-hidden column by `sort_order` (the "In Progress"
  slot). A card sitting here with no workspace is the operator's "start this".
- **OPEN** — every other non-hidden column (the backlog head, review columns, …).

Record the resolved role→name mapping in your first report line of the session
(`columns: Todo=open, In Progress=start, In Review=open, Done=terminal`) so a
mis-detected board is caught by eye immediately. If the board has **fewer than three**
non-hidden columns, say so and treat only the last as terminal.

**Writes still use names.** `update_issue` takes a status *name*, so pass the discovered
name for the role you want, never a literal. On `Unknown status … Available statuses:
[...]`, re-resolve the columns from that error and retry once.

### Sub-boards (nested projects)

A board is a project row; `parent_id` nests them, and **a parent project still owns its
own kanban** — it is a board, not just a folder. `list_projects` returns `parent_id` on
every row, so the tree costs nothing extra to build.

Your **target scope** is the project the operator named **plus its descendant boards**,
resolved once per session by walking `parent_id` (guard with a visited set; the app
permits no reparenting today but does not guarantee acyclicity to readers). Enumerate
cards **per board** — every `list_issues` stays filtered to exactly one project id —
and union the results. Name the boards you are sweeping in the session's first report
line. Columns are **per board**: resolve them for each board in scope; do not reuse the
parent's mapping for a child.

If the operator named a single board, sweep only that board. `list_workspaces` is **not**
project-scoped — it returns every non-archived workspace on the machine — so when you
map workspaces to cards, ignore any whose linked card is outside your target scope
rather than adopting it into the active set.

## Finding the READY cards (classification, cache-gated)

`list_issues` — **always filtered to one project id, and status-filtered to that
board's non-terminal columns; never all projects, never an unfiltered `limit: 100`
dump** — returns only a *summary* of each card: **status, id, title, `parent_issue_id`,
PR fields — but NOT the description**, and the `## Pipeline` / Orchestrate opt-in lives
in the **description**. You therefore **cannot judge readiness from the list alone**.
Build the candidate set = every card that has **no workspace yet** and is **not** in a
terminal column, then classify each candidate from its description —
**cache-gated by `cards{}`** (`reference/state-file.md` → the `cards{}` cache):

- **Cache hit** ⇔ `cards[I.id]` exists (and **survived validate-on-read**) **AND**
  `cards[I.id].updated_at` equals the candidate's **fresh** `list_issues.updated_at`,
  compared by **exact string equality** (never parsed, never ordered) ⇒ use the cached
  `class` / `executor_pin` / `routing`; **do not call `get_issue`**.
- **Cache miss** — entry absent, **DROPPED** by validate-on-read, or the stamps differ
  ⇒ `get_issue(I.id)`, derive `class`, a **validated** `executor_pin`, and a
  **validated** `routing` from the fresh description, and store `cards[I.id] =
  { updated_at: <get_issue's stamp>, class, executor_pin, routing }`.
- **Deriving `routing`** (the classification the `classify-task` skill stamped on the
  card at intake): find a description line beginning `**Routing:** ` — the card's
  routing record, placed directly **above** the `## Pipeline` block by
  `product`/`intake`. Take the first word after `**Routing:** ` and accept it **only**
  if it is exactly one of `trivial`, `light`, `medium`, `heavy`; anything else (or no
  such line — normal for pre-routing cards) ⇒ store **`null`**. Never store the raw
  line. Routing is **read-only context for you**: the tier explains which pipeline the
  card carries, and you name it in the dispatch report — you never re-route, re-tier,
  or edit the card's pipeline because of it (re-routing is `intake`'s job, on an
  operator instruction or after a surfaced `VK-ESCALATE` park).

Do **not** conclude a Todo card has no opt-in because the list summary doesn't show
one — the summary *never* shows one; you must open the card (`get_issue`, or a cache
hit that already did). (This is the bug that once made the orchestrator skip every Todo
card: it judged from `list_issues` and never read the description.)

A candidate card is **ready to dispatch** when, after reading its description, either:
- its description carries a **`## Pipeline`** block whose stages include the
  **Orchestrate** opt-in (the line "Have the orchestrator agent pick this card up
  and drive it to done autonomously…") — you own these regardless of column, even
  from the backlog column; or
- it sits in the **START-SIGNAL** column with no workspace — moving a card there is
  the operator's "start this" signal (ready regardless of opt-in).

**Never start a plain backlog card** (one whose description has **no** Orchestrate
opt-in) — that is the operator's backlog. But you only know a card is "plain" *after*
you've read its description; **never skip reading it**. Do nothing for cards that
already have a workspace.

### Parents are never dispatched (sub-issue rule)

Cards nest: every list row carries `parent_issue_id` (absent/null on a root card). Build
the **parent set** for the board by one pass over the list you already fetched — the
distinct non-null `parent_issue_id` values. This costs **no extra call**.

- **A card in the parent set is never dispatched**, in any column, opt-in or not. A
  parent is a container for work, not work: dispatching it points a coding agent at an
  epic whose real scope lives in its children. This rule is what actually protects an
  epic — **not** the filing convention that epics carry no pipeline, because the board
  UI lets anyone drag an epic into the start column, and the app enforces nothing.
  Report it once per sweep as `<card>: parent of N sub-issues — not dispatched`.
- **Sub-issues dispatch normally.** A child is an ordinary card: its own opt-in, its own
  routing tier, its own workspace. Children of one parent with no `blocking` edges
  between them are exactly the parallel-lane case — dispatch them together, subject to
  the WIP cap below.
- **Roll-up is written — from the children's columns, and only from those.** The backend
  still derives nothing from hierarchy (no rollup, no auto-close), so if the parent is to
  track its children, you are the one who moves it. See *Parent roll-up* below for the
  whole rule; the short version is: **≥1 child in flight ⇒ start-signal; every child at
  review-or-better ⇒ review; every child terminal ⇒ terminal.**
- **Defend yourself on hierarchy — the backend does not.** `parent_issue_id` accepts
  cycles (`A→B→A`, even `A→A`), accepts a parent in a *different project*, and
  `ON DELETE SET NULL` silently orphans children when a parent is deleted. So: never
  walk a parent chain without a visited set; treat a parent id you did not see in this
  board's listing as **out of scope** (do not fetch it, do not follow it); and accept
  that a card which was a child last tick may be a root this tick — re-derive the parent
  set every sweep rather than caching it. (`parents{}` is **not** such a cache: it stores
  which cards to *ask* about and what you already *wrote*, never who the children are —
  a card that is no longer a parent comes back with an empty roster and is dropped.)

### Parent roll-up (a parent's column follows its children)

A parent is not work, but it **is** a status container — and the backend fills nothing in
(no rollup, no auto-close), so if an epic is to say what its lane is doing, you are the one
who moves it. The roll-up reads **one** source: the **columns its children are actually
in**. Never an agent's `final_message` (a parent has no agent), never a PR field of its own.

**Runs in sweep mode only** — it needs the board listing, and *Context diet* forbids one in
monitor mode. Nothing is lost by that: a child shipping in a monitor pass fires sweep
trigger 2, so the sweep pass — and this roll-up — runs in that same tick. Run it **after**
dispatch and status reflection, so this sweep's own dispatches and ships count.

**Candidate parents — free, from data already in hand:**

```
PARENTS := { distinct non-null parent_issue_id over this sweep's COMPLETE listing, in scope }
         ∪ { p ∈ parents{} that this sweep's listing still shows as a non-terminal card in scope }
```

The second term is why the ledger exists: a parent whose children have **all** gone
terminal has no non-terminal child left to point at it, and would vanish from the derived
set on the exact sweep its Done roll-up came due. Record each newly discovered parent as
`parents[p] = "seen"` (`reference/state-file.md` → *The `parents{}` ledger*). On an
**incomplete** listing, derive nothing and skip the roll-up entirely this sweep.

Evaluate parents **deepest-first**, so a parent that is itself a child settles before its
own parent and one sweep can roll a whole tree.

**Per child, from the listing + the active set (no extra call):**

- **IN FLIGHT** — it has a live (non-archived) workspace in the active set, **or** it sits
  **at or past the START-SIGNAL column** by `sort_order` and is not terminal.
- **AT REVIEW OR BETTER** — it sits in the board's **REVIEW** column (the last non-terminal
  one) **or** in a **TERMINAL** column.
- **TERMINAL** — the board's terminal role (hidden ∪ last visible).

**The rungs — evaluate highest first; the first positively confirmed one is the target:**

| # | Fires when | Target column role |
|---|---|---|
| **1** | roster **verified**, ≥1 child, **every** child TERMINAL | **TERMINAL** |
| **2** | roster **verified**, ≥1 child, **every** child AT REVIEW OR BETTER, and ≥1 not terminal | **REVIEW** |
| **3** | **≥1** child IN FLIGHT (a single positive — no roster needed) | **START-SIGNAL** |

Rungs 1 and 2 are the same distinction the card-level rule (`agents/orchestrator.md` →
*Deciding the column*) makes for a single card, applied one level up: a child reaches the
review column when its pipeline finished but **nothing landed**, and a terminal column only
on a **confirmed merge/PR**. So a parent whose children are all finished-but-unlanded lands
in **review**, and follows them to **terminal** only once they actually land. **Complete but
not merged ⇒ In Review; merged ⇒ Done** — for the parent exactly as for the card.

**Verifying the roster (rungs 1 and 2 only — rung 3 never needs it):**

1. `list_issues(project_id: <the parent's board>, parent_issue_id: <the parent's id>)` —
   **no status filter** (terminal children are the whole point), paged until
   `returned_count == total_count`.
2. Corroborate **membership** against `get_issue(<the parent's id>)`'s sub-issue list, which
   is not board-scoped. `parent_issue_id` may legitimately point **across projects**, and a
   child on another board is invisible to the scoped listing above — exactly the blind spot
   that would let a partial roster fake an "all done".
3. **Hold on any doubt** — a short, errored, or unpaged listing; a child you cannot place in
   a resolved board's columns (a child on a board outside your scope is exactly that case —
   you have no column roles for it, and *Defend yourself on hierarchy* forbids wandering off
   to fetch them); the two membership reads disagreeing. Write nothing for rungs 1–2 and
   report `<card>: roll-up held — roster unverified (<why>)`. Holding is the safe failure: a
   parent left where it is costs nothing, a parent falsely closed hides open work.

**Bounding the cost — refute before you read.** The free listing already kills most roster
reads: **one child in an OPEN column (anything non-terminal that is not the review column —
the backlog head, the start-signal column, any middle column) refutes rungs 1 and 2
outright**, because that child is neither done nor waiting on review. So attempt the roster
read **only** for a parent whose visible children are *all* in the review column, or which
has **no** visible children left at all (the all-terminal case) — a handful of parents on a
normal board, usually none. **Cap it at 10 roster reads per sweep**, ordered: parents with a
child that changed this tick, then newly discovered parents, then the rest; report the
remainder as `roll-up deferred — N parents past the 10/sweep roster cap`. Rung 3 costs
**nothing** — it is decided entirely from rows you already fetched.

**Writing the move:**

- **Forward-only, by `sort_order`, never by name** — never move a parent to a column that
  sorts earlier than the one it is in. Already at or past the target ⇒ do nothing.
- **Once per role.** The `parents{}` value records the furthest role you rolled it to
  (`seen` → `start` → `review`; a parent rolled to terminal is **dropped** from the ledger).
  A role already written is never re-written, so an operator who moves a rolled-up parent
  somewhere else **keeps** that placement instead of being overridden every sweep.
- Write the **real column name** for the role on **the parent's own board** (a parent may
  sit on a different board than its children — resolve columns per board, as always).
- **Report as plain lines, never digest rows** — a parent has no workspace and therefore no
  lane letter (`reference/report.md` → *Explicitly NOT rows*):
  `<card>: 2/5 sub-issues in flight → In Progress`,
  `<card>: all 5 sub-issues complete, none landed → In Review`,
  `<card>: all 5 sub-issues done → Done`.
- A roll-up move **advances a card's column**, so it counts the tick **ACTIVE** for cadence.
  It is idempotent by the two rules above, so it can never pin the loop at 5m.
- **A roll-up never makes a parent dispatchable.** Moving an epic into the start-signal
  column is exactly the operator gesture that normally means "start this" — the
  never-dispatch-a-parent rule above is unconditional and outranks it, whoever did the
  moving.
- **"Plain cards are operator-owned" does not exempt a parent.** That rule (*Which cards
  count as "managed"*) forbids advancing a card from an **agent's** report when no agent was
  told to drive it. The roll-up asserts nothing about an agent: it restates, on the parent,
  what the board already says about its children.

### The dependency gate (blocking edges), bounded

Cards filed as lanes carry `blocking` relationships (blocker → blocked). The MCP has no
relationship *read* tool; read them over the backend's REST route — the same
`$VIBE_BACKEND_URL` the delta-gate script uses:
`curl -sf "$VIBE_BACKEND_URL/api/issue-relationships?issue_id=<id>"`, which returns
**outgoing rows only** (`WHERE issue_id = ?`), so blockers are discovered from the
blocker side and there is no way to ask "who blocks X".

That shape makes the gate O(cards), so **bound it**:

1. Run it **only when at least one candidate is otherwise ready** (unchanged).
2. Query only the board's **non-terminal** cards — terminal ones cannot block.
3. **Cap the fan-out at 50 cards per sweep.** Order the queue: cards that blocked
   something on a previous sweep first (you saw those edges), then the ready
   candidates, then the rest.
4. If the cap truncates the queue, **hold every candidate you could not clear** and say
   so: `dependency gate truncated at 50/<N> cards — M candidates held unverified`.
   Holding is the safe failure: dispatching a card whose blocker you never checked is
   the one outcome this gate exists to prevent.

Every row with `relationship_type == "blocking"` whose source card is not in a terminal
column marks its `related_issue_id` **blocked**. A blocked candidate is **not ready**:
hold it and report `<card>: waiting on <blocker-id>`. No stored state — a blocker
reaching a terminal column frees its dependents on the next sweep. A blocking **cycle**
(A blocks B blocks A) is a filing error: report it loudly for the operator to break;
never dispatch either side of it.

**When the board outgrows the cap**, say so once and name the fix rather than quietly
degrading: the backend needs a project-scoped relationships read (or a `blocked_by`
field on the list row) before lane gating scales past ~50 open cards per board.

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
cards that currently have a non-archived workspace. **The one exception is the parent
roll-up** (above): a parent's column is derived from its children's columns, not from any
agent's report, so it applies to a plain parent too.

**A terminal column is terminal — never track or re-report a card in one.** Before you
walk a card, check its column against the board's resolved TERMINAL role (above): if it
is terminal, drop it entirely — do **not** `get_issue` it, do **not** read its agent
(`list_sessions` / `get_execution`), do **not** reflect or re-report it, and **drop its
`cards{}` entry** (a terminal column is terminal for the cache too). You report a card's
move to a terminal column **exactly once**, on the tick you actually move it; from the
next tick on it falls out of your working set forever — and out of the retained active
set. A board with several terminal columns (extra hidden ones, e.g. Cancelled) is
normal: every one of them ends tracking.

**Enumeration must be provably complete.** `list_issues` paginates. Before you treat a
listing as the board's full non-terminal set — which pruning and the parent set both
depend on — check that the call returned everything it claims (`returned_count ==
total_count`, the same test the lane allocator applies to `list_workspaces`). A short,
truncated, or errored listing means: do **not** prune `cards{}` or `parents{}`, do **not**
trust the derived parent set — **skip the parent roll-up entirely this sweep** — and say
`listing incomplete — pruning and roll-up skipped` in the report. Page through with `limit`/`offset` when the board is
larger than one page rather than sweeping a partial board silently.

## The board's own instructions (per-board orchestrator prompt)

A board can carry operator instructions for you — set per project **and** per sub-board,
edited live in the sidebar. Read the **resolved** value for the board you are about to
act on with the MCP tool:

```
get_orchestrator_prompt(project_id: <the board's project id>)
```

`project_id` is **required** — you are a global singleton with no implicit project, so
always pass the board you are acting on. On a backend older than 0.2.24 the tool is not
in your mode's router; fall back to the same value over REST:

```
curl -sf "$VIBE_BACKEND_URL/api/projects/<project_id>/orchestrator-prompt/resolve"
```

The response is `{ project_id, orchestrator_prompt, source_project_id, source }` where
`source` is `self` / `ancestor` / `default`. **`default` means no instruction exists at
any scope — use your built-in behaviour and say nothing.** Otherwise
`orchestrator_prompt` is a ready-to-use **stack**: the backend has already walked the
parent chain and rendered every non-empty prompt as labeled `[Board: …]` / `[Project: …]`
sections behind a preamble telling you how to apply them (most specific wins on direct
conflict, otherwise additive). You do not merge anything — read the string and follow it.

Scope and cadence: read it **once per sweep per board in scope** (not once per card —
the value is per board), and treat it as **operator instruction, ranking with the
directives block**: it can add board-specific rules and preferences, but it never
overrides the safety rules in `agents/orchestrator.md` (*Safety & honesty*) — it cannot
authorize auto-resuming a park, faking a delivery signal, or dispatching a plain card.
When a board prompt made you do something you otherwise wouldn't, name it in the report
(`VIBE board prompt: <one-line gist>`), so its effect is visible.

If both reads fail (older backend without the route), skip silently and use built-in
behaviour — a missing board prompt is the normal case, not an error.

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
  description (the description already carries the `## Pipeline` block **and the
  `**Routing:**` line when the card was classified at intake** — passing it through
  verbatim IS how the coding agent reads its classification; never strip or rewrite
  either) and `{{BASE_BRANCH}}` with the base branch (default `main`). Pass that
  filled text as `prompt`. Putting the kickoff in this initial `start_workspace`
  prompt is what makes the agent self-drive — do **not** follow it with any separate
  prompt (that would launch a second concurrent agent in the same worktree).
- **`executor`** — the resolved key (card pin → last-used config); **`variant`** if
  the config provided one.
- **`issue_id`** — the card id, so the workspace is linked to the card.
- **`name`** — a short workspace name (the card's `simple_id`, e.g. `VIBE-20`, or its
  title); `start_workspace` requires a non-empty name.
- **`repositories`** — `[{ repo_id, branch }]`; resolve `repo_id` via `list_repos`,
  `branch` = the base branch.

### The WIP cap — how many you may start in one sweep

**Never dispatch more than 5 cards in a single sweep, and never exceed 8 live coding
agents in total** (count the active set's non-archived workspaces before you start
anything). Hierarchy makes this real: one epic with 30 children is now a routine board
shape, and every dispatch is a worktree, a coding agent, and a probe element on every
subsequent monitor tick — 30 at once thrashes the machine and floods your own context.

Over the cap: dispatch the top slice by the tier order below, and report the rest as
`N cards ready, held by WIP cap (M live)`. Held cards are not lost — the next sweep
re-derives them, and a shipped card frees a slot (sweep trigger 2 fires immediately).
The cap is a floor on machine sanity, not a scheduling policy: the operator can say
"start them all" and you override it for that sweep, saying so in the report.

When several cards are ready in one sweep, dispatch the **lighter tiers first**
(`trivial` → `light` → `medium` → `heavy`, unrouted last within their column order) —
quick wins clear the board's WIP fastest and a heavy card's long run never delays
them. Name each card's tier in the dispatch report line (e.g. `dispatched AQUA-31
(light → Async Sonnet, CLAUDE_CODE)`); say `unrouted` when `routing` is `null` — an
unrouted card with an Orchestrate opt-in dispatches exactly as before, routing is
never a dispatch precondition.

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
