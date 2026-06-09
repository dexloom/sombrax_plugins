#!/usr/bin/env bash
#
# orchestrator.sh — launch a Claude Code session that drives the vibe-kanban
# board and re-checks the state of every running agent on a fixed interval,
# using the `/loop` skill.
#
# `/loop <interval> <prompt>` re-runs <prompt> every <interval>. Here the looped
# prompt is the orchestrator sweep in scripts/orchestrator.prompt.md: survey the
# board, poll executions, surface approvals, send the next lifecycle step to any
# idle agent, and report. Default interval is 5m.
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

# Kick off an interactive session that immediately arms the /loop timer.
exec claude "/loop ${INTERVAL} ${LOOP_BODY}"
