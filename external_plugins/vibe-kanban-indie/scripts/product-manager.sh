#!/usr/bin/env bash
#
# product-manager.sh — launch a Claude Code session that runs the
# `product-manager` skill: turn a rough, one-paragraph brief into a
# development-ready vibe-kanban card (issue) on the board.
#
# The skill renders the spec inline first so you can confirm nothing was
# missed, then files the card via the vibe-kanban MCP. Because it asks you to
# confirm, this runs as a normal INTERACTIVE Claude session (not -p).
#
# Usage:
#   scripts/product-manager.sh "Add dark-mode toggle to settings, persist choice"
#   scripts/product-manager.sh                 # start blank, paste the brief in the session
#   echo "brief text..." | scripts/product-manager.sh -   # read brief from stdin
#
# Prerequisite: the vibe-kanban backend must be running (see ../README.md), or the
# MCP card-filing step will fail with "Failed to connect to VK API".
set -euo pipefail

# Always run from the workspace root so bundled .mcp.json / skills resolve.
cd "$(dirname "$0")/.."

# Resolve & export VIBE_BACKEND_URL so the vibe-kanban MCP can connect at launch.
. "$(dirname "$0")/resolve-backend.sh"

BRIEF="${*:-}"

# `-` means: read the brief from stdin.
if [[ "${BRIEF}" == "-" ]]; then
  BRIEF="$(cat)"
fi

if [[ -n "${BRIEF}" ]]; then
  exec claude "/product-manager ${BRIEF}"
else
  # No brief given — open the session primed on the skill; type the brief there.
  exec claude "/product-manager"
fi
