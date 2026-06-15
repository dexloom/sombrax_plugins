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

> These launchers are the **standalone / dev** way to run the system from a
> checkout — they add a `/loop`-timed orchestrator, backend URL auto-resolution,
> and the Telegram wiring. If you've installed this plugin via the marketplace
> instead, the skills, agents, and MCP server are already available in any
> project; running these scripts from a checkout at the same time can register the
> `vibe-kanban` MCP server twice. Pick one mode.

| script | role | what it does |
|--------|------|--------------|
| `product-manager.sh` | **intake** | Runs the `product-manager` skill: a rough brief → a dev-ready vibe-kanban card. Interactive (it asks you to confirm the spec before filing). |
| `orchestrator.sh` | **supervise** | Launches the **orchestrator agent** (`claude --agent vibe-kanban-indie:orchestrator`) on a `/loop` timer: each tick it starts an agent for an In-Progress/Orchestrate card that has none, and **reflects** managed-card board status by reading each agent's state (→ In Review when dev is finished + reviewed, → Done once the merge/PR has landed — read-only, it never merges itself). With a directive it can also spawn the `decider` for stale questions / auto-approve / `/compact` overloaded headed agents (`ORCH_AUTO_COMPACT=1`, see *Opt-in directives*). It does **not** drive coding step-by-step — each coding agent runs its own pipeline, and the operator owns the merge decision. |
| `orchestrate_tg.sh` | **supervise + Telegram** | Same as `orchestrator.sh`, but also loads the sombrax-telegram channel in the **project-manager** role over all topics, so it can message the per-branch dev agents on Telegram. |

## Usage

```bash
# Intake a brief into a card
scripts/product-manager.sh "Add a dark-mode toggle to settings, persist the choice"
echo "longer brief..." | scripts/product-manager.sh -   # brief from stdin

# Drive the board, re-checking state every 5 minutes (default)
scripts/orchestrator.sh
scripts/orchestrator.sh 10m          # or any /loop interval
ORCH_INTERVAL=2m scripts/orchestrator.sh

# Drive the board AND talk to dev agents over Telegram (project-manager role)
scripts/orchestrate_tg.sh            # all topics, 5m loop
scripts/orchestrate_tg.sh 10m
TELEGRAM_TOPIC="vk/0123-x" scripts/orchestrate_tg.sh   # scope to one branch

# Opt into the auto-compact directive (works on either launcher)
ORCH_AUTO_COMPACT=1 scripts/orchestrator.sh                      # /compact headed
                                                                 # agents over 300k
ORCH_AUTO_COMPACT=1 ORCH_COMPACT_THRESHOLD=250000 scripts/orchestrate_tg.sh
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
  silently on the console alone — that was the stuck-question bug this fixes.
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

By default the orchestrator only dispatches and reflects status. Directives turn on
extra opt-in behaviors; both launchers source **`directives-block.sh`**, which reads
directive env toggles and appends a `Directives enabled for this run:` block to the
`/loop` spawn prompt (empty when no toggle is set, so the default prompt is unchanged).
The flag's *logic* lives in the `orchestrator` agent definition; this block just names
which flags are on.

- **`auto-compact`** — `ORCH_AUTO_COMPACT=1` (truthy: `1`/`true`/`yes`/`on`). Each tick,
  the orchestrator measures every running **`CLAUDE_CODE_HEADED`** agent's context-window
  usage from its Claude Code transcript and sends `/compact` (via `run_session_prompt`)
  to any agent whose usage exceeds the threshold. **Threshold** defaults to **300000**
  tokens, overridable with `ORCH_COMPACT_THRESHOLD=<tokens>`. Headed-only,
  all-running-headed scope (not just managed cards), no board side effects, idempotent
  (a compacted agent reads back under the threshold). Example:
  `ORCH_AUTO_COMPACT=1 ORCH_COMPACT_THRESHOLD=250000 scripts/orchestrator.sh`.

To wire a new directive toggle, add a `case` to `directives-block.sh` and document the
behavior in `agents/orchestrator.md` — both launchers pick it up automatically.

> **GUI is future work, not in this repo.** The vibe-kanban GUI is a separate upstream
> app; a future toggle there would enable `auto-compact` by injecting the same flag +
> `ORCH_COMPACT_THRESHOLD` into the spawn prompt — the directive mechanism is the single
> integration point.

## How the 5-minute check works

`orchestrator.sh` launches `claude --plugin-dir <checkout> --agent
vibe-kanban-indie:orchestrator "/loop <interval> <sweep>"` — so the orchestrator
agent IS the session (not a Task subagent), and its full behavior comes from the
agent definition. `--plugin-dir` loads the plugin from this checkout for the session
(this is the standalone/dev mode), which is what makes the agent name resolve and
registers the bundled MCP; don't ALSO install the plugin via the marketplace at the
same time (double MCP registration — pick one mode, as noted above). The `/loop`
skill re-runs the per-tick sweep every interval. The sweep brief lives in
`orchestrator.prompt.md` — edit that file to change what each tick does (it's read
fresh on launch). Override the agent name with `ORCH_AGENT` and the loaded plugin
dir with `PLUGIN_DIR`. Stop the loop by typing "stop the loop" in the session, or
Ctrl-C.

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

The orchestrator sweep is told to **surface** approval requests for you to answer,
never to auto-approve — matching the plugin safety rule that a `respond_to_approval`
comes from you, not from an agent's own text.
