#!/usr/bin/env bash
#
# orchestrator.sh — launch the orchestrator (a single loop-armed board sweep
# agent) as the session agent (`claude --agent vibecrew:orchestrator`) and
# re-arm the `/loop` timer on an interval. Unlike vibe-kanban-indie's split
# loop-manager + per-tick subagent, this ONE agent both owns the timer and
# runs the sweep itself, entirely over `python3 vibecrew_api.py …` — no MCP,
# no subagent spawned for the routine tick. The launch interval is the
# "active" cadence; the agent classifies each tick and requests re-arms
# ADAPTIVELY — backing the timer off to 30m after two consecutive empty ticks
# and snapping back to the active interval when a card needs work or an
# operator instruction arrives (see agents/orchestrator.md's "Adaptive cadence
# 5m ↔ 30m"). The agent re-arms its own cron only when its own cadence
# decision asks it to.
#
# The agent's full behavior lives in its agent definition; launching it with
# --agent (rather than as a Task subagent) makes it the session itself. `/loop
# <interval> <prompt>` re-runs the per-tick brief in
# scripts/orchestrator.prompt.md every <interval>: that brief runs one sweep
# itself (finds READY cards with no workspace — inprogress or Orchestrate
# opt-in —, resolves the executor: the card's pinned agent, else the
# operator's last-used/default config, starts ONE coding run per card via the
# client, marks it inprogress, applies whichever opt-in directives its spawn
# prompt names — auto-unblock / auto-answer-questions / telegram-fanout /
# nudge-stuck, whose logic lives in agents/orchestrator.md — and reports).
# The agent itself handles two operator-instruction routes with no flag: a
# direct "answer that questionnaire" request is routed to the decider agent;
# "create a card / spec this" is bounced back to the operator (card creation
# stays operator-driven via the product agent / product-manager skill).
# Default (active) interval is 5m; idle backoff is 30m.
#
# Usage:
#   scripts/orchestrator.sh            # check every 5 minutes
#   scripts/orchestrator.sh 10m        # check every 10 minutes
#   scripts/orchestrator.sh 300s       # check every 300 seconds
#   ORCH_INTERVAL=2m scripts/orchestrator.sh
#
# Spawn = connect: this launches `claude` inside a stable, shared tmux session
# (`vc-orchestrator`, override with ORCH_TMUX_SESSION). If an orchestrator is
# ALREADY running, a second launch ATTACHES to it instead of spawning a
# duplicate (and without a TTY it just reports "already running" rather than
# failing). tmux is REQUIRED (the launcher fails clearly if it is missing).
# See orchestrator-attach.sh.
#
# Opt-in directives (default-off; injected into the spawn prompt — see
# directives-block.sh), canonical order:
#   ORCH_AUTO_UNBLOCK=1 scripts/orchestrator.sh   # auto-unblock — INERT until
#                                                 # Agent-ops 5/5 (see
#                                                 # agents/orchestrator.md)
#   ORCH_AUTO_ANSWER=1 scripts/orchestrator.sh    # auto-answer-questions —
#                                                 # INERT until Agent-ops 5/5
#   ORCH_TELEGRAM_FANOUT=1 scripts/orchestrator.sh  # telegram-fanout: mirror
#                                                   # status to the operator
#                                                   # Telegram topic
#   ORCH_NUDGE_STUCK=1 scripts/orchestrator.sh     # nudge-stuck: follow-up a
#                                                  # managed run stuck 2 ticks
#
# To stop the loop: type "stop the loop" in the session, or Ctrl-C / exit it.
#
# Prerequisite: the VibeCrew backend must be running (see ../README.md), or
# every tick will just report "backend down".
set -euo pipefail

# Always run from the plugin root so bundled skills / prompts resolve.
cd "$(dirname "$0")/.."

# Resolve & export VIBECREW_URL so vibecrew_api.py can connect at launch.
. "$(dirname "$0")/resolve-backend.sh"

# Interval: first positional arg wins, else $ORCH_INTERVAL, else 5m.
INTERVAL="${1:-${ORCH_INTERVAL:-5m}}"

# Resolve PLUGIN_DIR to an ABSOLUTE path now (default = this checkout, the
# dir we cd'd into above) — must happen before the cd inside
# orchestrator-attach.sh below (a relative PLUGIN_DIR override would
# otherwise resolve against its temp dir), and before we build LOOP_BODY
# below, which carries it as a `PLUGIN ROOT:` line.
PLUGIN_DIR="$(cd "${PLUGIN_DIR:-$(pwd)}" && pwd)"

PROMPT_FILE="scripts/orchestrator.prompt.md"
if [[ ! -f "${PROMPT_FILE}" ]]; then
  echo "orchestrator.sh: missing ${PROMPT_FILE}" >&2
  exit 1
fi

# `PLUGIN ROOT:` lets the agent resolve its own plugin root even when
# $CLAUDE_PLUGIN_ROOT isn't set in its environment for some reason. Must
# precede the directives block below — the directives block has to stay LAST
# in the prompt.
LOOP_BODY="$(cat "${PROMPT_FILE}")

PLUGIN ROOT: ${PLUGIN_DIR}"

# Append the opt-in "Directives enabled for this run" block (empty unless a
# directive env toggle like ORCH_NUDGE_STUCK is set). Sourced so it can't
# drift. The block must END the spawn prompt, so append it last.
. "$(dirname "$0")/directives-block.sh"
LOOP_BODY="${LOOP_BODY}${DIRECTIVES_BLOCK}"

# Launch the orchestrator AGENT directly (not as a Task subagent). Its full
# behavior lives in the agent definition; the looped prompt is just the
# per-tick sweep brief.
#
# In this standalone/dev mode the plugin is NOT installed via the
# marketplace, so `--plugin-dir` loads it from this checkout for the session
# — that's what makes the `vibecrew:orchestrator` agent name resolve (merely
# cd-ing here does not load it). PLUGIN_DIR defaults to this checkout (the
# dir we cd'd into above, resolved to an absolute path above); override
# ORCH_AGENT to use a different agent name.
ORCH_AGENT="${ORCH_AGENT:-vibecrew:orchestrator}"

# "Spawn = connect": launch claude inside the stable, shared
# `vc-orchestrator` tmux session, OR attach to it if an orchestrator is
# already running — so a second launch never spawns a duplicate orchestrator.
# The helper also sets the neutral working directory for the wrapped session
# (`tmux new-session … -c "$(mktemp -d)"`). (tmux is required; see
# orchestrator-attach.sh.)
. "$(dirname "$0")/orchestrator-attach.sh"

# Kick off (or attach to) the session that arms the /loop timer.
orchestrator_launch --plugin-dir "${PLUGIN_DIR}" --agent "${ORCH_AGENT}" "/loop ${INTERVAL} ${LOOP_BODY}"
