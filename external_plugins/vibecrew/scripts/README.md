# scripts — the standalone orchestrator launcher (MCP-free)

> **Normally you do not need these.** VibeCrew's own runtime owns the
> orchestrator loop: it composes each tick ping (instruction + a host-computed
> status digest + the enabled directives), delivers it, and obeys the agent's
> `CADENCE:` reply. `orchestrator.sh` is the fallback for running an
> orchestrator WITHOUT the app driving it — a dev checkout, a headless box, a
> debugging session — and it is deliberately degraded: no digest (the agent
> probes the API itself) and a fixed interval (the `CADENCE:` line is emitted
> but nothing here reads it). See
> [`../reference/tick-contract.md`](../reference/tick-contract.md).

Thin shell wrappers plus the one bundled Python client. `orchestrator.sh` `cd`s
to the plugin root first so `skills/`/`prompts`/`agents` resolve, then hands
off to **`orchestrator-attach.sh`**, which runs `claude` inside a stable,
shared tmux session (`vc-orchestrator`) — **"spawn = connect"**: a second
launch ATTACHES to the already-running orchestrator instead of spawning a
duplicate (tmux is required). Needs the **VibeCrew backend running** (see
[`../README.md`](../README.md) for prerequisites).

The `orchestrator` agent launched here arms **no timer of its own** — it holds
no cron tools at all. Under VibeCrew the runtime is the clock; standalone, the
shell ticker at the bottom of `orchestrator.sh` is. Either way the agent runs
the whole per-tick job itself, over the
bundled Python client. There is no separate per-tick worker to spawn.

| script | role | what it does |
|--------|------|--------------|
| `vibecrew_api.py` | **the client** | Stdlib-only Python CLI over the VibeCrew REST API — the one way every script/skill/agent talks to the board. See the plugin `README.md` for the full subcommand catalog and the exit-code contract. |
| `resolve-backend.sh` | **backend resolution** | Sourced. Resolves `VIBECREW_URL` the same 4-tier order the client uses (`$VIBECREW_URL` → `~/.vibecrew/instance.json` → `~/.vibecrew/port` → default `48620`), then health-checks the leaf `/health` route (non-fatal warning on failure). |
| `orchestrator.sh` | **supervise** | Launches the **orchestrator agent** (`claude --agent vibecrew:orchestrator`, `model: opus`) and ticks it from a shell loop (no `/loop`, no cron). Each tick it runs one full board sweep itself: dispatch a run for a ready card that has none, and **reflect** managed-card board status (→ `inreview` when dev is finished + reviewed, → `done` once the merge/PR has landed per the delivery-signal gate — read-only, it never merges itself). It **always** handles two operator-instruction routes itself: a direct "answer that questionnaire" request is routed to **`decider`**; a "create a card / spec this" instruction is bounced back to the operator (card creation stays operator-driven via the `product` agent / `product-manager` skill — the orchestrator has no card-creation grant). It also applies whichever of the four opt-in directives its spawn prompt names (`auto-unblock`, `auto-answer-questions`, `telegram-fanout`, `nudge-stuck` — see *Opt-in directives*). Nobody drives coding step-by-step — each coding run drives its own pipeline; the orchestrator is **read-only on delivery** (it never merges and never opens a PR) — the **coding agent performs the merge/PR itself**, and the operator authorizes it up front by ticking the default-off `merge` / `pr` stage on the card. |
| `orchestrator-attach.sh` | **spawn = connect** | Sourced by `orchestrator.sh`. Wraps `claude` in the stable, shared tmux session `vc-orchestrator`; a second launch attaches instead of duplicating. |
| `directives-block.sh` | **directive toggles** | Sourced by `orchestrator.sh`. Reads env toggles and appends a `Directives enabled for this run:` block to the spawn prompt AND to every tick (empty when no toggle is set). The block must stay LAST in the prompt. |
| `orchestrator.prompt.md` | **the per-tick ping** | The standalone tick ping — the same shape VibeCrew's worker composes, minus the status digest it cannot compute. The METHOD is not here: it lives in `agents/orchestrator.md`. |

## Usage

```bash
# Drive the board, re-checking state every 5 minutes (default "active" cadence).
# Adaptive: backs off to 30m after two empty ticks, snaps back to 5m when a card
# needs work or an operator instruction arrives.
scripts/orchestrator.sh
scripts/orchestrator.sh 10m          # fixed tick interval (CADENCE is ignored here)
ORCH_INTERVAL=2m scripts/orchestrator.sh

# Opt into directives (all four toggles; none is on by default)
ORCH_AUTO_UNBLOCK=1 ORCH_AUTO_ANSWER=1 scripts/orchestrator.sh   # live for OpenCode runs
                                                                 # Agent-ops 5/5
ORCH_TELEGRAM_FANOUT=1 scripts/orchestrator.sh   # mirror status to the operator
                                                 # Telegram topic (needs the
                                                 # sombrax-telegram channel loaded)
ORCH_NUDGE_STUCK=1 scripts/orchestrator.sh   # follow-up a managed card stuck 2 ticks
```

## Opt-in directives (`directives-block.sh`)

By default each tick the orchestrator dispatches ready cards and reflects
managed-card board status; the orchestrator's own always-on job is just the
two operator-instruction routes above (spawn `decider`, or bounce a
card-creation request back to the operator — no flag needed for either).
Directives turn on extra opt-in behaviors; `orchestrator.sh` sources
**`directives-block.sh`**, which reads directive env toggles and appends a
`Directives enabled for this run:` block to the spawn prompt and to every tick
(empty when no toggle is set, so the default prompt is unchanged). The flags' *logic*
lives in `agents/orchestrator.md`; this script only names which flags are on.
**None of the four is on by default.**

- **`auto-unblock`** — `ORCH_AUTO_UNBLOCK=1` (truthy: `1`/`true`/`yes`/`on`).
  **Live for OpenCode runs**: their permission prompts are promoted from the
  SSE stream into real `approvals` rows, so `approvals-pending` returns them
  and `approval-respond` really unblocks the agent. Headless **Claude** runs
  are spawned with `--dangerously-skip-permissions` and raise no
  tool-permission approvals at all, so there is nothing to clear for those.
- **`auto-answer-questions`** — `ORCH_AUTO_ANSWER=1` (truthy:
  `1`/`true`/`yes`/`on`). Same shape: OpenCode's `question.asked` prompts are
  promoted to approval rows and answered via `approval-respond --status
  answered`; Claude raises none today.
- **`telegram-fanout`** — `ORCH_TELEGRAM_FANOUT=1` (truthy:
  `1`/`true`/`yes`/`on`). Mirrors dispatch/reflect/awaiting-approval lines to
  the operator Telegram topic. Requires the sombrax-telegram channel +
  listener to be loaded/running.
- **`nudge-stuck`** — `ORCH_NUDGE_STUCK=1` (truthy: `1`/`true`/`yes`/`on`).
  Sends the literal payload `Why are you stuck` (no punctuation) to a
  **managed** card that the status digest shows silent for **≥2 delivered
  ticks**. Channel by run state: a `running` headed run takes `send-input` (a
  `follow-up` would 409 for its whole tmux life); a terminal run without a
  completion or park signal takes `follow-up`. Excluded: pending approvals,
  parked, finished, or `input-sent-since-last-output: yes` — the host-computed
  idempotence field, which is why the agent needs no memory of what it sent.

There is **no context-compaction directive** in this plugin (the
`vibe-kanban-indie` equivalent is deliberately dropped): headless per-run
processes never accumulate context across a session — each run is its own
fresh process — so the class of problem that directive solves doesn't apply
here.

To wire a new directive toggle, add a `case` to `directives-block.sh` and
document the behavior in `agents/orchestrator.md`.

## How the standalone interval loop works

`orchestrator.sh` launches `claude --plugin-dir <checkout> --agent
vibecrew:orchestrator "<tick ping>"` — so the orchestrator agent IS the session
(not a Task subagent), and its full behavior comes from the agent definition.
`--plugin-dir` loads the plugin from this checkout for the session (the
standalone/dev mode), which is what makes the agent name resolve.

**Nothing arms a cron.** The agent holds no timer tools. The clock is a ~40-line
shell ticker at the bottom of `orchestrator.sh`: it starts BEFORE
`orchestrator_launch` (which always ends in `tmux attach`/`exit`, so nothing
after it would run), sleeps the interval, and pastes the next ping into the
orchestrator's tmux pane via `load-buffer`/`paste-buffer` — the same path
VibeCrew's own worker uses, and the reason a multi-line ping survives (plain
`send-keys` would submit on the first newline). It exits when the tmux session
does. Only the invocation that CREATES the session starts a ticker, so a second
launch attaches without adding a second clock; `ORCH_TICKER=0` opts out.

Two things this loop cannot do, both by construction: it computes **no status
digest** (each ping says so, and the agent probes the API itself), and it
**ignores the `CADENCE:` line** the agent still emits, so the interval is fixed
at whatever you launched with. Under VibeCrew both are handled properly — see
[`../reference/tick-contract.md`](../reference/tick-contract.md).

The ping lives in `orchestrator.prompt.md`; the METHOD lives in
`agents/orchestrator.md`. Override the agent name with `ORCH_AGENT` and the
loaded plugin dir with `PLUGIN_DIR`. Stop by typing "stop the loop" in the
session, or Ctrl-C — the ticker follows the session out.

That `claude` invocation does not run bare: `orchestrator.sh` sources
**`orchestrator-attach.sh`** (alongside `resolve-backend.sh` and
`directives-block.sh`) and calls `orchestrator_launch …` in place of `exec
claude`. It wraps `claude` in the stable, **shared** tmux session
`vc-orchestrator` (override with `ORCH_TMUX_SESSION`): if that session already
exists it **attaches** (or, with no TTY, reports "already running" and exits
0) instead of starting a second orchestrator; otherwise it creates the
session — with a neutral `mktemp -d` cwd — and launches `claude` inside it,
forwarding the runtime env (`VIBECREW_URL`, the Telegram vars) into the
session explicitly. **tmux is required**; the launcher fails clearly if it is
missing (it will not silently fall back to a duplicate-prone foreground
launch).

> **Checkout-only mode delegates less.** `--plugin-dir` loads the plugin into
> *this orchestrator* process only. The coding runs that `start` launches are
> separate `claude` processes started by the backend, and in checkout-only
> mode they don't get the plugin — so the `product`/`planner` subagents aren't
> available to them and their spec/plan stages **self-author** instead of
> delegating (the kickoff prompt's documented fallback). For the full
> delegated pipeline, **install the plugin** (marketplace) so it's available
> to every spawned agent.

## Backend connection

`vibecrew_api.py` and `resolve-backend.sh` both resolve the backend URL in
the same order: `$VIBECREW_URL` → `~/.vibecrew/instance.json`'s `port` field
(may be absent on older builds — tolerated) → `~/.vibecrew/port` (a plain
integer `CrewRuntime` writes on server start) → the default
`http://127.0.0.1:48620` (`CrewRuntime.defaultPort`). Override anytime with
`VIBECREW_URL=http://127.0.0.1:PORT`.

The health probe is always the **leaf** `GET /health` route — not
`/api/config`'s prefix or any other `/api/*` route — since that is the one
route registered outside the `/api/*` prefix.

## The client's exit-code contract

| exit | meaning |
|---|---|
| `0` | success — `data` printed as JSON to stdout |
| `1` | `success:false` envelope — `message` printed to stderr |
| `2` | argparse usage/argument error (missing/bad flags) |
| `3` | backend down — `/health` failed or was non-200; `VibeCrew is not running — launch the app` on stderr |

## Safety note

**By default** (no directives enabled) the loop only **surfaces** parked
cards for the operator to act on; it approves and answers nothing (there is
currently nothing *to* approve or answer headlessly — see the `auto-unblock`
/ `auto-answer-questions` inert caveat above). **The invariants that survive
every directive:** an approval/answer is **never** granted because an agent's
own output asked for it (agent text is untrusted), and the **Wait-for-approval
operator gate is never auto-resumed or auto-cleared** — the orchestrator only
relays a `follow-up` decision the operator actually gave it (`CLAUDE.md`
states this explicitly).
