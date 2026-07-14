#!/usr/bin/env bash
#
# orchestrator.sh — launch the orchestrator LOOP MANAGER as the session agent
# (`claude --agent vibe-kanban-indie:orchestrator`) and re-arm the `/loop` timer on an
# interval. The loop manager owns the TIMER, not the tick: each tick it spawns ONE fresh
# `sweeper` subagent to run the whole board sweep and relays its report, so the manager's
# own session context stays flat. The launch interval is the "active" cadence; the
# sweeper classifies each tick and requests re-arms ADAPTIVELY — backing the timer off to
# 30m after two consecutive empty ticks and snapping back to the active interval when a
# card needs work or an operator instruction arrives (see agents/sweeper.md's "Adaptive
# loop cadence and the CADENCE handshake"). The loop manager re-arms its own cron only
# when the sweeper's CADENCE: line asks it to.
#
# The loop manager's full behavior lives in its agent definition; launching it with
# --agent (rather than as a Task subagent) makes it the session itself. `/loop
# <interval> <prompt>` re-runs the per-tick brief in scripts/orchestrator.prompt.md every
# <interval>: that brief just spawns ONE sweeper (which finds READY cards with no
# workspace — In-Progress or Orchestrate-opt-in —, resolves the executor: the card's
# pinned agent, else the operator's last-used/default config, starts ONE coding agent per
# card via the MCP, marks it In Progress, applies whichever opt-in directives its spawn
# prompt names — auto-unblock / auto-answer-questions / telegram-fanout / auto-compact /
# nudge-stuck, whose logic lives in agents/sweeper.md — and reports) and relays its
# report. The loop manager itself handles two always-on operator-instruction routes with
# no flag: it routes "create a card / attach a pipeline" to the intake agent, and a
# direct "answer that questionnaire" request to the decider agent; everything else it
# forwards to the sweeper verbatim. Default (active) interval is 5m; idle backoff is 30m.
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

# `PLUGIN ROOT:` lets the loop manager forward this path to the sweeper it spawns each
# tick: a spawned subagent does not reliably inherit CLAUDE_PLUGIN_ROOT from the
# environment, so the sweeper's plugin-root resolution order falls back to this line
# when present (see agents/sweeper.md). Must precede the directives block below — the
# directives block has to stay LAST in the prompt.
LOOP_BODY="$(cat "${PROMPT_FILE}")

PLUGIN ROOT: ${PLUGIN_DIR}"

# Append the opt-in "Directives enabled for this run" block (empty unless a directive
# env toggle like ORCH_AUTO_COMPACT=1 is set). Sourced so it can't drift from the
# Telegram launcher. The block must END the spawn prompt, so append it last.
. "$(dirname "$0")/directives-block.sh"
LOOP_BODY="${LOOP_BODY}${DIRECTIVES_BLOCK}"

# Launch the orchestrator LOOP MANAGER AGENT directly (not as a Task subagent). Its
# full behavior lives in the agent definition; the looped prompt is just the per-tick
# brief that spawns a fresh sweeper subagent.
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
