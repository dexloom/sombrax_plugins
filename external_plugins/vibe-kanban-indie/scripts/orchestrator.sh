#!/usr/bin/env bash
#
# orchestrator.sh — launch the SINGLE-LOOP orchestrator as the session agent
# (`claude --agent vibe-kanban-indie:orchestrator`) on a `/loop` timer. One long-running
# session owns both the timer AND the tick, with a MONITOR-FIRST two-mode tick: by
# default each tick is a cheap monitor pass over the currently active cards (their
# sessions/executions via the delta gate — no board-wide fetches); a full board sweep
# (inventory, find READY cards — In-Progress or Orchestrate-opt-in — resolve the
# executor: the card's pinned agent, else the operator's last-used/default config, start
# ONE coding agent per card, mark it In Progress) runs ONLY when a dispatch trigger
# fires: nothing active to monitor, an active card just shipped, an operator
# instruction, or the periodic backstop. The agent arms and re-arms its own cron
# ADAPTIVELY — backing off to 30m after two consecutive empty ticks and snapping back to
# the active interval when work or an operator instruction returns (see
# agents/orchestrator.md "Adaptive cadence"). The launch interval is the "active"
# cadence.
#
# The agent's full behavior lives in its agent definition (agents/orchestrator.md, with
# long-form procedure in reference/*.md it Reads on demand); launching it with --agent
# (rather than as a Task subagent) makes it the session itself. `/loop <interval>
# <prompt>` re-runs the SHORT per-tick pointer in scripts/orchestrator.prompt.md every
# <interval> — the pointer stays tiny (well under the shell-command length cap) because
# the behavior is in the agent definition, not the prompt. The agent applies whichever
# opt-in directives its spawn prompt names — auto-unblock / auto-answer-questions /
# telegram-fanout / auto-compact / nudge-stuck, whose logic lives in
# reference/directives.md — and handles two always-on operator-instruction routes with
# no flag: it routes "create a card / attach a pipeline" to the intake agent, and a
# direct "answer that questionnaire" request to the decider agent; everything else it
# handles directly (it holds the board tools). Default (active) interval is 5m; idle
# backoff is 30m.
#
# Usage:
#   scripts/orchestrator.sh            # check every 5 minutes
#   scripts/orchestrator.sh 10m        # check every 10 minutes
#   scripts/orchestrator.sh 300s       # check every 300 seconds
#   ORCH_INTERVAL=2m scripts/orchestrator.sh
#
# Spawn = connect: this launches `claude` inside a stable, shared tmux session
# (`vk-orchestrator`, override with ORCH_TMUX_SESSION). If an orchestrator is ALREADY
# running, a second launch ATTACHES to it instead of spawning a duplicate (and without a
# TTY it just reports "already running" rather than failing). The shared session name is
# also used by orchestrate_tg.sh, so a console launch and a Telegram launch are mutually
# exclusive — whichever ran FIRST owns the session and its config wins. tmux is REQUIRED
# (the launcher fails clearly if it is missing). See orchestrator-attach.sh.
#
# Opt-in directives (default-off; injected into the spawn prompt — see
# directives-block.sh), canonical order:
#   ORCH_AUTO_UNBLOCK=1 scripts/orchestrator.sh   # auto-unblock: approve routine,
#                                                 # plan-sanctioned tool permissions
#   ORCH_AUTO_ANSWER=1 scripts/orchestrator.sh    # auto-answer-questions: answer a
#                                                 # stale question prompt
#   ORCH_TELEGRAM_FANOUT=1 scripts/orchestrate_tg.sh   # telegram-fanout: accepted by
#                                                      # either launcher, but only
#                                                      # orchestrate_tg.sh loads the
#                                                      # channel — use that one
#   ORCH_AUTO_COMPACT=1 scripts/orchestrator.sh    # auto-compact: /compact headed
#                                                  # agents over 300k
#   ORCH_AUTO_COMPACT=1 ORCH_COMPACT_THRESHOLD=250000 scripts/orchestrator.sh
#   ORCH_NUDGE_STUCK=1 scripts/orchestrator.sh     # nudge-stuck: "Why are you stuck" to
#                                                  # a managed agent stuck for 2 ticks
#
# To stop the loop: type "stop the loop" in the session, or Ctrl-C / exit it.
#
# Prerequisite: the vibe-kanban backend must be running (see ../README.md), or every
# tick will just report "backend down".
set -euo pipefail

# Always run from the workspace root so bundled .mcp.json / skills / prompts resolve.
cd "$(dirname "$0")/.."

# Resolve & export VIBE_BACKEND_URL so the vibe-kanban MCP can connect at launch.
. "$(dirname "$0")/resolve-backend.sh"

# Interval: first positional arg wins, else $ORCH_INTERVAL, else 5m.
INTERVAL="${1:-${ORCH_INTERVAL:-5m}}"

# Resolve PLUGIN_DIR to an ABSOLUTE path now (default = this checkout, the dir we
# cd'd into above) — must happen before the cd inside orchestrator-attach.sh below (a
# relative PLUGIN_DIR override would otherwise resolve against its temp dir), and
# before we build LOOP_BODY below, which carries it as a `PLUGIN ROOT:` line.
PLUGIN_DIR="$(cd "${PLUGIN_DIR:-$(pwd)}" && pwd)"

PROMPT_FILE="scripts/orchestrator.prompt.md"
if [[ ! -f "${PROMPT_FILE}" ]]; then
  echo "orchestrator.sh: missing ${PROMPT_FILE}" >&2
  exit 1
fi

# `PLUGIN ROOT:` gives the orchestrator its plugin root when CLAUDE_PLUGIN_ROOT is not
# in its environment: the agent's plugin-root resolution order falls back to this line
# when present (see agents/orchestrator.md "Arming the loop"). Must precede the
# directives block below — the directives block has to stay LAST in the prompt.
LOOP_BODY="$(cat "${PROMPT_FILE}")

PLUGIN ROOT: ${PLUGIN_DIR}"

# Append the opt-in "Directives enabled for this run" block (empty unless a directive
# env toggle like ORCH_AUTO_COMPACT=1 is set). Sourced so it can't drift from the
# Telegram launcher. The block must END the spawn prompt, so append it last.
. "$(dirname "$0")/directives-block.sh"
LOOP_BODY="${LOOP_BODY}${DIRECTIVES_BLOCK}"

# Launch the orchestrator AGENT directly (not as a Task subagent). Its full behavior
# lives in the agent definition; the looped prompt is just a short per-tick pointer.
#
# In this standalone/dev mode the plugin is NOT installed via the marketplace, so
# `--plugin-dir` loads it from this checkout for the session — that's what makes the
# `vibe-kanban-indie:orchestrator` agent name resolve (merely cd-ing here does not
# load it). It also loads the bundled `.mcp.json`, so don't ALSO have the plugin
# installed via the marketplace at the same time (double MCP registration — see
# ../README.md "pick one mode"). PLUGIN_DIR defaults to this checkout (the dir we
# cd'd into above, resolved to an absolute path above); override ORCH_AGENT to use a
# different agent name.
ORCH_AGENT="${ORCH_AGENT:-vibe-kanban-indie:orchestrator}"

# "Spawn = connect": launch claude inside the stable, shared `vk-orchestrator` tmux
# session, OR attach to it if an orchestrator is already running — so a second launch
# never spawns a duplicate orchestrator. The helper also sets the neutral working
# directory for the wrapped session (`tmux new-session … -c "$(mktemp -d)"`), so Claude
# does NOT also auto-discover this plugin dir's project-level `.mcp.json` — `--plugin-dir`
# already registers the bundled MCP, and discovering the same `.mcp.json` from cwd would
# start a duplicate vibe-kanban server. (tmux is required; see orchestrator-attach.sh.)
. "$(dirname "$0")/orchestrator-attach.sh"

# Kick off (or attach to) the session that arms the /loop timer.
orchestrator_launch --plugin-dir "${PLUGIN_DIR}" --agent "${ORCH_AGENT}" "/loop ${INTERVAL} ${LOOP_BODY}"
