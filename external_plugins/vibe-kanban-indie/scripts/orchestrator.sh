#!/usr/bin/env bash
#
# orchestrator.sh — launch the orchestrator AGENT as the session agent
# (`claude --agent vibe-kanban-indie:orchestrator`) and re-run its board sweep on a
# fixed interval via the `/loop` skill.
#
# The orchestrator's full behavior lives in its agent definition; launching it with
# --agent (rather than as a Task subagent) makes it the session itself. `/loop
# <interval> <prompt>` re-runs the per-tick dispatch sweep in
# scripts/orchestrator.prompt.md every <interval>: find READY cards with no
# workspace (In-Progress or Orchestrate-opt-in), resolve the executor (the card's
# pinned agent, else the operator's last-used/default config), start ONE coding
# agent per card via the MCP, mark it In Progress, and report. It does nothing else
# — no monitoring, delivery, merge, or question-answering. Default interval is 5m.
#
# Usage:
#   scripts/orchestrator.sh            # check every 5 minutes
#   scripts/orchestrator.sh 10m        # check every 10 minutes
#   scripts/orchestrator.sh 300s       # check every 300 seconds
#   ORCH_INTERVAL=2m scripts/orchestrator.sh
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

# Run from a neutral working directory so Claude does NOT also auto-discover this
# plugin dir's project-level `.mcp.json` — `--plugin-dir` already registers the
# bundled MCP, and discovering the same `.mcp.json` from cwd would start a duplicate
# vibe-kanban server. (LOOP_BODY is already read and the backend env already
# exported, so cwd no longer matters here.)
cd "$(mktemp -d)"

# Kick off an interactive session that immediately arms the /loop timer.
exec claude --plugin-dir "${PLUGIN_DIR}" --agent "${ORCH_AGENT}" "/loop ${INTERVAL} ${LOOP_BODY}"
