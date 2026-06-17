#!/usr/bin/env bash
#
# orchestrator.sh — launch the orchestrator AGENT as the session agent
# (`claude --agent vibe-kanban-indie:orchestrator`) and re-run its board sweep on an
# interval via the `/loop` skill. The launch interval is the "active" cadence; the
# orchestrator then runs ADAPTIVELY — backing the timer off to 30m after two
# consecutive empty ticks and snapping back to the active interval when a card needs
# work or an operator instruction arrives (see the agent definition's "Adaptive loop
# cadence"). It re-arms its own cron to change cadence.
#
# The orchestrator's full behavior lives in its agent definition; launching it with
# --agent (rather than as a Task subagent) makes it the session itself. `/loop
# <interval> <prompt>` re-runs the per-tick dispatch sweep in
# scripts/orchestrator.prompt.md every <interval>: find READY cards with no
# workspace (In-Progress or Orchestrate-opt-in), resolve the executor (the card's
# pinned agent, else the operator's last-used/default config), start ONE coding
# agent per card via the MCP, mark it In Progress, and report. Beyond that core it
# acts only on the opt-in directives named in its spawn prompt (auto-unblock /
# auto-answer-questions / telegram-fanout), whose logic lives in the agent
# definition. Default (active) interval is 5m; idle backoff is 30m.
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
# directives-block.sh):
#   ORCH_AUTO_COMPACT=1 scripts/orchestrator.sh                     # /compact headed
#                                                                    # agents over 300k
#   ORCH_AUTO_COMPACT=1 ORCH_COMPACT_THRESHOLD=250000 scripts/orchestrator.sh
#   ORCH_NUDGE_STUCK=1 scripts/orchestrator.sh                      # "Why are you stuck"
#                                                                    # to a managed agent
#                                                                    # stuck for 2 ticks
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

PROMPT_FILE="scripts/orchestrator.prompt.md"
if [[ ! -f "${PROMPT_FILE}" ]]; then
  echo "orchestrator.sh: missing ${PROMPT_FILE}" >&2
  exit 1
fi

LOOP_BODY="$(cat "${PROMPT_FILE}")"

# Append the opt-in "Directives enabled for this run" block (empty unless a directive
# env toggle like ORCH_AUTO_COMPACT=1 is set). Sourced so it can't drift from the
# Telegram launcher. The block must END the spawn prompt, so append it last.
. "$(dirname "$0")/directives-block.sh"
LOOP_BODY="${LOOP_BODY}${DIRECTIVES_BLOCK}"

# Launch the orchestrator AGENT directly (not as a Task subagent). Its full behavior
# lives in the agent definition; the looped prompt is just the per-tick sweep brief.
#
# In this standalone/dev mode the plugin is NOT installed via the marketplace, so
# `--plugin-dir` loads it from this checkout for the session — that's what makes the
# `vibe-kanban-indie:orchestrator` agent name resolve (merely cd-ing here does not
# load it). It also loads the bundled `.mcp.json`, so don't ALSO have the plugin
# installed via the marketplace at the same time (double MCP registration — see
# ../README.md "pick one mode"). PLUGIN_DIR defaults to this checkout (the dir we
# cd'd into above); override ORCH_AGENT to use a different agent name.
# Resolve to an ABSOLUTE path now (default = this checkout) — must happen before the
# cd below, or a relative PLUGIN_DIR override would resolve against the temp dir.
PLUGIN_DIR="$(cd "${PLUGIN_DIR:-$(pwd)}" && pwd)"
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
