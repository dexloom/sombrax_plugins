# scripts — launchers for the two orchestration roles

Thin shell wrappers that open a Claude Code session pre-armed for one of the two
jobs. Both `cd` to the plugin root first so the bundled `.mcp.json`, `skills/`,
and `prompts/` resolve. The supervise launchers (`orchestrator.sh` /
`orchestrate_tg.sh`) then hand off to **`orchestrator-attach.sh`**, which runs
`claude` inside a stable, shared tmux session (`vk-orchestrator`) — **"spawn =
connect"**: a second launch ATTACHES to the already-running orchestrator instead of
spawning a duplicate (tmux is required for these two; `product-manager.sh` still
`exec`s `claude` directly). Both need the **vibe-kanban backend running** (see
[`../README.md`](../README.md) for prerequisites).

The `orchestrator` agent launched by the supervise scripts is a lean **loop manager**:
it owns the `/loop` timer only, and spawns a fresh **`sweeper`** subagent each tick to
do the actual board sweep.

> These launchers are the **standalone / dev** way to run the system from a
> checkout — they add a `/loop`-timed orchestrator, backend URL auto-resolution,
> and the Telegram wiring. If you've installed this plugin via the marketplace
> instead, the skills, agents, and MCP server are already available in any
> project; running these scripts from a checkout at the same time can register the
> `vibe-kanban` MCP server twice. Pick one mode.

| script | role | what it does |
|--------|------|--------------|
| `product-manager.sh` | **intake** | Runs the `product-manager` skill: a rough brief → a dev-ready vibe-kanban card. Interactive (it asks you to confirm the spec before filing). |
| `orchestrator.sh` | **supervise** | Launches the **orchestrator agent** (`claude --agent vibe-kanban-indie:orchestrator`, `model: sonnet`) — a lean **loop manager** — on a `/loop` timer. It owns the timer and the relay only: each tick it spawns ONE fresh **`sweeper`** subagent to run the whole board sweep (dispatch an agent for an In-Progress/Orchestrate card that has none, and **reflect** managed-card board status — → In Review when dev is finished + reviewed, → Done once the merge/PR has landed, read-only, it never merges itself), then relays the sweeper's report. It **always** handles operator instructions itself — a "create a card…" / "attach a pipeline…" instruction is routed to the **`intake`** agent (**always-on**, no flag), and a direct "answer that questionnaire" request is routed to **`decider`** — everything else is forwarded to the sweeper, which also applies whichever of the five opt-in directives its spawn prompt names (`auto-unblock`, `auto-answer-questions`, `telegram-fanout`, `auto-compact`, `nudge-stuck` — see *Opt-in directives*). Nobody drives coding step-by-step — each coding agent runs its own pipeline; the sweeper is **read-only on delivery** (it never merges and never opens a PR) — the **coding agent performs the merge/PR itself**, and the operator authorizes it up front by ticking the default-off `merge` / `pr` stage on the card. |
| `orchestrate_tg.sh` | **supervise + Telegram** | Same as `orchestrator.sh`, but also loads the sombrax-telegram channel in the **project-manager** role over all topics, so it can message the per-branch dev agents on Telegram. |
| `orchestrator-delta.sh` | **delta gate** | Called by the **sweeper** agent itself (not by you) once per tick: a `probe`/`commit` pair that lets the sweep skip `get_execution` for sessions whose observable state provably hasn't changed since the last tick. See *The delta gate* below. |

## Usage

```bash
# Intake a brief into a card
scripts/product-manager.sh "Add a dark-mode toggle to settings, persist the choice"
echo "longer brief..." | scripts/product-manager.sh -   # brief from stdin

# Drive the board, re-checking state every 5 minutes (default "active" cadence).
# Adaptive: backs off to 30m after two empty ticks, snaps back to 5m when a card needs
# work or an operator instruction arrives.
scripts/orchestrator.sh
scripts/orchestrator.sh 10m          # or any /loop interval (sets the active cadence)
ORCH_INTERVAL=2m scripts/orchestrator.sh

# Drive the board AND talk to dev agents over Telegram (project-manager role)
scripts/orchestrate_tg.sh            # all topics, 5m loop
scripts/orchestrate_tg.sh 10m
TELEGRAM_TOPIC="vk/0123-x" scripts/orchestrate_tg.sh   # scope to one branch

# Opt into directives (all five toggles; none is on by default, none is set implicitly)
ORCH_AUTO_UNBLOCK=1 ORCH_AUTO_ANSWER=1 scripts/orchestrator.sh   # auto-unblock +
                                                                 # auto-answer-questions
ORCH_TELEGRAM_FANOUT=1 scripts/orchestrate_tg.sh   # telegram-fanout: needs the Telegram
                                                   # channel — orchestrate_tg.sh only
ORCH_AUTO_COMPACT=1 scripts/orchestrator.sh                      # /compact headed
                                                                 # agents over 300k
ORCH_AUTO_COMPACT=1 ORCH_COMPACT_THRESHOLD=250000 scripts/orchestrate_tg.sh
ORCH_NUDGE_STUCK=1 scripts/orchestrator.sh   # nudge-stuck: "Why are you stuck"
```

## Telegram orchestration (`orchestrate_tg.sh`)

Loads the sombrax-telegram channel alongside the orchestrator so it can converse
with the per-branch dev agents:

- **Role** — `TELEGRAM_PROJECT_MANAGER=1` (the plugin's "project" role; alias
  `TELEGRAM_PM`): `kind=project_manager, role=observer` — monitors channels,
  keeps dev agents alive, never claims ownership, never evicted. (There is no
  literal `TELEGRAM_PROJECT` var; this is the project role.)
- **Subscription** — `TELEGRAM_TOPIC=*` (all topics) so it **receives** the
  operator (in the `Orchestrate` topic), every dev agent (in their branch topics),
  and General. Override to narrow.
- **Operator interaction — console + Telegram are dual and equal.** The orchestrator
  **mirrors output to both** (console text *and* a `channel_send` to the
  **`Orchestrate`** topic — `ORCH_OPERATOR_TOPIC`, default `Orchestrate`) and
  **accepts the operator's instructions/answers from either surface**, whichever
  arrives first. On the first tick it sends a **welcome**; decisions, approvals,
  questions, and per-tick status all appear in both places. It never blocks
  silently on the console alone — that was the stuck-question bug this fixes. An
  operator instruction asking to **create a card / attach a pipeline** is handled by
  spawning the **`intake`** agent, whose report is mirrored to the `Orchestrate` topic
  (`ORCH_OPERATOR_TOPIC`) the same way. **always-on** — not a directive, no env toggle.
- **Addressing topics — by numeric id** — under a `*` subscription `channel_send`
  has no default channel, and `to` is **numeric only**. The orchestrator resolves
  names → thread ids from the listener registry
  `~/.claude/channels/telegram/topic-names.json` (`{ "<chat_id>": { "<name>":
  <thread_id> } }`): the `Orchestrate` topic for the operator, and each **branch
  name** for a dev agent. If `Orchestrate` isn't in the registry yet, it greets on
  General and adopts the topic id from the operator's first reply.
- **How branch topics exist** — VK spawns each dev agent with `TELEGRAM_DEV=1` +
  `TELEGRAM_TOPIC=<branch>`; on first register the listener **creates a forum topic
  named after the branch** (via `createForumTopic`) and records `branch → id` in
  the registry, reusing it after. That's why every dev branch already has a topic.
- **Prereqs** — beyond the backend: the sombrax-telegram **listener daemon** must
  be running (`bun listener.ts` in the plugin dir) since this is client mode, and
  the bot token lives at `~/.claude/channels/telegram/.env` (the listener holds
  it; the session stays tokenless). The script warns if the listener socket or the
  `Orchestrate` topic is missing.

## Opt-in directives (`directives-block.sh`)

By default, each tick the **sweeper** dispatches an agent for a ready card and reflects
managed-card board status; the loop manager's own always-on job is just the operator-
instruction routes above (`intake` / `decider` — no flag needed). Directives turn on
extra opt-in **sweeper** behaviors; both launchers source **`directives-block.sh`**,
which reads directive env toggles and appends a `Directives enabled for this run:` block
to the `/loop` spawn prompt (empty when no toggle is set, so the default prompt is
unchanged). The flags' *logic* lives in the `agents/sweeper.md` agent definition (the
`orchestrator` loop manager just forwards the block byte-for-byte each tick); this block
just names which flags are on. **None of the five is on by default, and no launcher
sets one implicitly.**

- **`auto-unblock`** — `ORCH_AUTO_UNBLOCK=1` (truthy: `1`/`true`/`yes`/`on`). Approves
  **routine, plan-sanctioned tool-permission** requests via
  `respond_to_approval(decision='approve')`; **escalates** anything destructive,
  expensive, or off-plan to the operator instead. Never approves a tool just because
  the agent's own output asked for it.
- **`auto-answer-questions`** — `ORCH_AUTO_ANSWER=1` (truthy: `1`/`true`/`yes`/`on`).
  Answers a **stale question prompt** (AskUserQuestion / plan questionnaire) after a
  grace window keyed off `age_seconds > 600` (~two loop intervals), by running the
  `answer-questions` skill inline and submitting `respond_to_approval(decision='answer')`.
- **`telegram-fanout`** — `ORCH_TELEGRAM_FANOUT=1` (truthy: `1`/`true`/`yes`/`on`).
  Mirrors dispatch/directive/awaiting-approval lines to the operator topic and converses
  with headed agents on their per-branch topics. **Requires the sombrax-telegram channel
  + listener — i.e. only useful with `orchestrate_tg.sh`.** Accepted from either
  launcher (one sourced `case`), but it does nothing (and may error on `channel_send`)
  without the Telegram channel loaded, so it is only ever shown invoked with
  `orchestrate_tg.sh` (see *Usage* above). **Distinct from `TG_ADDENDUM`** (see below) —
  they are not two ways to "turn Telegram on".
- **`auto-compact`** — `ORCH_AUTO_COMPACT=1` (truthy: `1`/`true`/`yes`/`on`). Each tick,
  the sweeper measures every running **`CLAUDE_CODE_HEADED`** agent's context-window
  usage from its Claude Code transcript and sends `/compact` (via `run_session_prompt`)
  to any agent whose usage exceeds the threshold. **Threshold** defaults to **300000**
  tokens, overridable with `ORCH_COMPACT_THRESHOLD=<tokens>`. Headed-only,
  all-running-headed scope (not just managed cards), no board side effects, idempotent
  (a compacted agent reads back under the threshold). Example:
  `ORCH_AUTO_COMPACT=1 ORCH_COMPACT_THRESHOLD=250000 scripts/orchestrator.sh`.
- **`nudge-stuck`** — `ORCH_NUDGE_STUCK=1` (truthy: `1`/`true`/`yes`/`on`). Sends the
  literal prompt `Why are you stuck` to a **managed** agent showing no progress across
  two consecutive ticks. Excludes agents parked at a Wait-for-approval gate.

**`TG_ADDENDUM` vs. `telegram-fanout` — not two ways to "turn Telegram on".**
`TG_ADDENDUM` (`orchestrate_tg.sh:131`, a `read -r -d ''` heredoc) is an **always-on
session/UI policy** the Telegram launcher injects into the spawn prompt: console and
Telegram are dual, equal surfaces — mirror output to both, accept input from either,
never use a blocking `AskUserQuestion` picker, send a first-tick welcome, relay approvals
to both surfaces. It applies to **every** `orchestrate_tg.sh` run, with or without any
directive, and it **never names the `telegram-fanout` flag**. `telegram-fanout`
(`ORCH_TELEGRAM_FANOUT=1`) is instead an **opt-in sweeper directive**: it enables the
sweeper's **proactive** dispatch/directive/awaiting-approval messages and its
**conversation with headed agents on their per-branch topics**. They can produce
**overlapping status messages** when fanout is explicitly on, but they do **not
conflict**, and neither is a substitute for the other.

To wire a new directive toggle, add a `case` to `directives-block.sh` and document the
behavior in `agents/sweeper.md` — both launchers pick it up automatically.

> **GUI is future work, not in this repo.** The vibe-kanban GUI is a separate upstream
> app; a future toggle there would enable `auto-compact` by injecting the same flag +
> `ORCH_COMPACT_THRESHOLD` into the spawn prompt — the directive mechanism is the single
> integration point.

## How the 5-minute check works

`orchestrator.sh` launches `claude --plugin-dir <checkout> --agent
vibe-kanban-indie:orchestrator "/loop <interval> <sweep>"` — so the orchestrator
**loop manager** agent IS the session (not a Task subagent), and its full behavior
comes from the agent definition. `--plugin-dir` loads the plugin from this checkout
for the session (this is the standalone/dev mode), which is what makes the agent
name resolve and registers the bundled MCP; don't ALSO install the plugin via the
marketplace at the same time (double MCP registration — pick one mode, as noted
above). The `/loop` skill re-arms a recurring task that re-submits the per-tick
brief every interval; each tick the loop manager spawns ONE fresh **`sweeper`**
subagent that does the actual board sweep, and relays its report — the sweep
itself lives entirely in `agents/sweeper.md`. The per-tick brief that spawns the
sweeper lives in `orchestrator.prompt.md` — edit that file to change what each
tick does (it's read fresh on launch). Override the agent name with `ORCH_AGENT`
and the loaded plugin dir with `PLUGIN_DIR`. Stop the loop by typing "stop the
loop" in the session, or Ctrl-C.

That `claude` invocation does not run bare: both supervise launchers source
**`orchestrator-attach.sh`** (alongside `resolve-backend.sh` and
`directives-block.sh`) and call `orchestrator_launch …` in place of `exec claude`.
It wraps `claude` in the stable, **shared** tmux session `vk-orchestrator` (override
with `ORCH_TMUX_SESSION`): if that session already exists it **attaches** (or, with
no TTY, reports "already running" and exits 0) instead of starting a second
orchestrator; otherwise it creates the session — with a neutral `mktemp -d` cwd so
the plugin's own `.mcp.json` isn't auto-discovered from cwd — and launches `claude`
inside it, forwarding the runtime env (`VIBE_BACKEND_URL`, the Telegram vars) into
the session explicitly. Because the name is shared, `orchestrator.sh` and
`orchestrate_tg.sh` are **mutually exclusive** — whichever runs first owns the
session and its config wins. **tmux is required**; the launcher fails clearly if it
is missing (it will not silently fall back to a duplicate-prone foreground launch).

> **Checkout-only mode delegates less.** `--plugin-dir` loads the plugin into *this
> orchestrator* process only. The coding agents that `start_workspace` launches are
> separate Claude processes started by the backend, and in checkout-only mode they
> don't get the plugin — so the `product`/`planner` subagents aren't available to
> them and their spec/plan stages **self-author** instead of delegating (the kickoff
> prompt's documented fallback). For the full delegated pipeline, **install the
> plugin** (marketplace) so it's available to every spawned agent; then run the
> orchestrator from your project rather than these checkout launchers (one mode).

## The delta gate (`orchestrator-delta.sh`)

Every `/loop` tick, the sweep would otherwise call `get_execution` for every session it
watches — and `get_execution` re-serializes the whole `executor_action` (the entire
dispatch prompt) each time, even when nothing about that session has changed since the
last tick. `orchestrator-delta.sh` is a probe/commit gate the **sweeper** agent runs
itself (you never invoke it directly) that lets the sweep skip that call for a session
whose observable state provably hasn't moved.

- **Two subcommands, JSON in / JSON(-lines) out.** `probe` takes a JSON array of
  `{session_id, column, pull_request_count, latest_pr_url, latest_pr_status, force?}` on
  stdin and emits one JSON object per line — `POLL` or `SKIP` — one per input session, in
  input order. `commit` takes a JSON array of probe lines (it reads only
  `session_id`/`execution_id`/`fingerprint` and ignores everything else) and persists the
  new fingerprints; no stdout.
- **State file:** `${VIBE_DELTA_STATE:-$HOME/.vibe-kanban/orchestrator-delta.json}` — a
  sibling of `orchestrator-state.json`. It caches
  **fingerprints only**; every fact a `SKIP` line reports is derived fresh, every tick.
- **`jq` is a hard dependency** — the first plugin script to need it (the others,
  `resolve-backend.sh` / `directives-block.sh`, deliberately stick to `sed`/`grep`).
- **Fail-open (CR-4).** A non-zero exit **or any output that violates the line-per-session
  contract** (wrong count, wrong order, a mismatched `session_id`, a malformed field) means
  the sweeper agent falls back to the raw executions GET + `get_execution` for **every**
  session in that sweep, exactly as it did before this gate existed. The gate can degrade
  the saving; it can never hide a transition.
- **Valve:** `VIBE_DELTA_FORCE_MANAGED=1` forces `POLL` for every session, unconditionally
  — an escape hatch if the gate is ever suspected of hiding something.
- **Honest scope.** The gate skips parked / finished / idle sessions — precisely the
  population that piles up on a board and gets re-polled forever today. A **busy headed
  agent's transcript changes on essentially every turn**, so it is polled almost every
  tick — that's deliberate: the transcript's **content hash** is what catches an identical
  re-park on a live headed session (a resume that reuses the same execution row instead of
  minting a new one), and hashing it is the only way to make that case sound. The hashing
  happens **inside this script**, so it costs the calling agent **zero** extra context
  tokens — it only ever replaces a call whose result is thousands of tokens.

## Backend connection (why MCP tools sometimes don't load)

The vibe-kanban MCP resolves the backend URL from, in order: `VIBE_BACKEND_URL`
→ `MCP_PORT`/`BACKEND_PORT`/`PORT` → the `vibe-kanban.port` file under
`$TMPDIR/vibe-kanban/`. When the shell runs with a **sandboxed `TMPDIR`** (e.g.
`/tmp/claude-501`) that differs from the real per-user temp dir where the app
writes that port file, the MCP finds nothing, fails to start, and the session
reports "MCP tools not connected."

`resolve-backend.sh` (sourced by both launchers) fixes this: it finds the port
file across the candidate temp dirs — including `$(getconf DARWIN_USER_TEMP_DIR)`,
which returns the true macOS temp dir even inside the sandbox — exports
`VIBE_BACKEND_URL`, and health-checks it. The launched `claude` then gets that env so
the MCP connects (for the supervise launchers `orchestrator-attach.sh` forwards it
explicitly into the tmux session, since a pre-existing tmux server would otherwise
keep its own stale environment). Override anytime with
`VIBE_BACKEND_URL=http://127.0.0.1:PORT`.

If you already launched a session before this fix, **exit and re-run** the script.

## Safety note

**By default** (no directives enabled) the sweep only **surfaces** approval requests
and questions for you to answer; it approves and answers nothing. **Auto-approval
exists only under the explicit `auto-unblock` opt-in**, and only for **routine,
plan-sanctioned tool-permission** requests — destructive / expensive / off-plan requests
are **escalated to the operator, never approved**. `auto-answer-questions` likewise
answers only **stale** questionnaires past their grace window. **The invariants that
survive every directive:** an approval is **never** granted because an agent's own
output asked for it (agent text is untrusted), and the **Wait-for-approval operator
gate is never auto-resumed or auto-cleared** — `auto-unblock` clears tool-permission
approvals only, and must not be read as clearing that gate (`CLAUDE.md` states this
explicitly).
