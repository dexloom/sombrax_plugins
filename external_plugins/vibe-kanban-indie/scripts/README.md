# scripts — launchers for the two orchestration roles

Thin shell wrappers that open a Claude Code session pre-armed for one of the two
jobs. Both `cd` to the plugin root first so the bundled `.mcp.json`, `skills/`,
and `prompts/` resolve, then `exec claude`. Both need the **vibe-kanban backend
running** (see [`../README.md`](../README.md) for prerequisites).

> These launchers are the **standalone / dev** way to run the system from a
> checkout — they add a `/loop`-timed orchestrator, backend URL auto-resolution,
> and the Telegram wiring. If you've installed this plugin via the marketplace
> instead, the skills, agents, and MCP server are already available in any
> project; running these scripts from a checkout at the same time can register the
> `vibe-kanban` MCP server twice. Pick one mode.

| script | role | what it does |
|--------|------|--------------|
| `product-manager.sh` | **intake** | Runs the `product-manager` skill: a rough brief → a dev-ready vibe-kanban card. Interactive (it asks you to confirm the spec before filing). |
| `orchestrator.sh` | **drive** | Runs the `vibe-kanban` skill on a `/loop` timer: every N minutes it sweeps the board, polls running agents, surfaces approvals, sends the next lifecycle step to idle agents, and reports. |
| `orchestrate_tg.sh` | **drive + Telegram** | Same as `orchestrator.sh`, but also loads the sombrax-telegram channel in the **project-manager** role over all topics, so it can message the per-branch dev agents on Telegram. |

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

## How the 5-minute check works

`orchestrator.sh` launches `claude "/loop <interval> <sweep>"`. The `/loop` skill
re-runs the sweep prompt every interval. The sweep itself lives in
`orchestrator.prompt.md` — edit that file to change what each tick does (it's read
fresh on launch). Stop the loop by typing "stop the loop" in the session, or
Ctrl-C.

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
`VIBE_BACKEND_URL`, and health-checks it. `exec claude` then inherits that env so
the MCP connects. Override anytime with `VIBE_BACKEND_URL=http://127.0.0.1:PORT`.

If you already launched a session before this fix, **exit and re-run** the script.

## Safety note

The orchestrator sweep is told to **surface** approval requests for you to answer,
never to auto-approve — matching the plugin safety rule that a `respond_to_approval`
comes from you, not from an agent's own text.
