#!/usr/bin/env bash
#
# orchestrate_tg.sh — the orchestrator (orchestrator.sh) PLUS the sombrax-telegram
# channel, so it talks to humans and dev agents over Telegram.
#
# Same loop sweep + backend auto-resolve as orchestrator.sh, but it additionally:
#   • loads the sombrax-telegram channel into the session, and
#   • runs in the PROJECT-MANAGER role, SUBSCRIBED TO ALL TOPICS — interacting
#     with the human operator in the "Orchestrate" topic and with each dev agent
#     in its own BRANCH-named topic.
#
# Console and Telegram are DUAL, EQUAL surfaces: the orchestrator mirrors its
# output to both (console text + channel_send to Orchestrate), and accepts the
# operator's instructions/answers from EITHER the console or Telegram.
#
# The "project" role flag
# -----------------------
# The plugin's project role is TELEGRAM_PROJECT_MANAGER=1 (alias: TELEGRAM_PM).
# It makes this session  kind=project_manager, role=observer  —  it monitors
# channels, keeps dev agents alive, and orchestrates pipelines; it never claims
# ownership of a channel and is never evicted. (There is no literal TELEGRAM_PROJECT
# var in the plugin; TELEGRAM_PROJECT_MANAGER is the project role.)
#
# Subscription vs. addressing
# ---------------------------
# TELEGRAM_TOPIC="*" subscribes this session to EVERY topic (so it RECEIVES the
# operator's messages in "Orchestrate" and every dev agent's messages in their
# branch topics, plus General). But under a wildcard subscription, channel_send
# has no single "own channel", so to SEND you must target a topic by its NUMERIC
# thread id:  channel_send to=<id>  (a topic NAME does not route — the MCP coerces
# `to` with Number()).
#
# How names map to ids
# --------------------
# The listener persists a topic-name registry at
#   ~/.claude/channels/telegram/topic-names.json   ->  { "<chat_id>": { "<name>": <thread_id> } }
# A session that registers with a topic NAME makes the listener create that forum
# topic (once) and record name->id there. Dev agents spawned by VK with
# TELEGRAM_DEV=1 + TELEGRAM_TOPIC=<branch> are exactly how the per-branch topics
# get created. The orchestrator reads this file to resolve "Orchestrate" and each
# branch -> numeric id, then channel_send to=<id>.
#
# Prerequisites
# -------------
#   1. vibe-kanban backend running          (auto-resolved via resolve-backend.sh).
#   2. sombrax-telegram LISTENER DAEMON running — client mode connects to it.
#      Start it from the installed sombrax-telegram plugin dir, e.g.:
#        cd "$(dirname "$(command -v bun)")"   # or wherever the plugin is installed
#        cd <sombrax-telegram plugin dir> && bun listener.ts
#      (Manage the channel via the /telegram:configure and /telegram:access skills.)
#   3. Bot token at ~/.claude/channels/telegram/.env — the LISTENER holds it; this
#      session stays tokenless in client mode.
#   4. An "Orchestrate" topic the operator uses. If it is not yet in the registry,
#      the orchestrator greets on General first and adopts the Orchestrate thread
#      id from the operator's first message there (see the loop addendum).
#
# Usage:
#   scripts/orchestrate_tg.sh            # loop every 5m, all topics, operator=Orchestrate
#   scripts/orchestrate_tg.sh 10m        # custom interval
#   TELEGRAM_TOPIC="vk/0123-x" scripts/orchestrate_tg.sh   # narrow subscription
#
# Stop the loop: type "stop the loop" in the session, or Ctrl-C.
set -euo pipefail

# Always run from the workspace root so .mcp.json / .claude / prompts resolve.
cd "$(dirname "$0")/.."

# Resolve & export VIBE_BACKEND_URL so the vibe-kanban MCP can connect at launch.
. "$(dirname "$0")/resolve-backend.sh"

# --- Telegram role + subscription -------------------------------------------
# Project-manager observer (the "project" role): monitors/orchestrates, never
# claims channel ownership, never evicted.
export TELEGRAM_PROJECT_MANAGER="1"
# Subscribe to ALL topics, so it receives the operator (Orchestrate) and every dev
# agent (branch topics). Override to narrow. Sending is by numeric `to` (below).
export TELEGRAM_TOPIC="*"
# Name of the operator topic the orchestrator talks to humans in.
export ORCH_OPERATOR_TOPIC="Orchestrate"

# Warn (non-fatal) if the listener socket is missing — client mode needs it.
_sock="${TELEGRAM_LISTENER_SOCKET:-$HOME/.claude/channels/telegram/listener.sock}"
if [[ ! -S "${_sock}" ]]; then
  echo "orchestrate_tg: WARNING — listener socket not found at ${_sock}" >&2
  echo "  Start it:  (cd <plugin dir> && bun listener.ts)" >&2
  echo "  Without the listener daemon, the telegram channel won't connect." >&2
fi

# Warn (non-fatal) if the operator topic isn't in the registry yet — the
# orchestrator will fall back to greeting on General and adopt the id from the
# operator's first reply.
_reg="$HOME/.claude/channels/telegram/topic-names.json"
if [[ -f "${_reg}" ]] && ! grep -q "\"${ORCH_OPERATOR_TOPIC}\"" "${_reg}" 2>/dev/null; then
  echo "orchestrate_tg: note — \"${ORCH_OPERATOR_TOPIC}\" topic not in ${_reg} yet;" >&2
  echo "  the orchestrator will greet on General and adopt the topic id once the" >&2
  echo "  operator writes in the ${ORCH_OPERATOR_TOPIC} topic." >&2
fi

# Interval: first positional arg wins, else $ORCH_INTERVAL, else 5m.
INTERVAL="${1:-${ORCH_INTERVAL:-5m}}"

PROMPT_FILE="scripts/orchestrator.prompt.md"
if [[ ! -f "${PROMPT_FILE}" ]]; then
  echo "orchestrate_tg.sh: missing ${PROMPT_FILE}" >&2
  exit 1
fi

# Telegram addendum to the shared sweep (kept here so orchestrator.sh stays
# channel-agnostic). Single-quoted heredoc → no expansion; quotes/backticks safe.
read -r -d '' TG_ADDENDUM <<'TG_EOF' || true

TELEGRAM + CONSOLE (this run) — DUAL, EQUAL INTERFACES. You run in an interactive
console AND you are a project_manager OBSERVER subscribed to ALL Telegram topics
(you receive the human OPERATOR in the "Orchestrate" topic and each dev AGENT in
its BRANCH-named topic, e.g. vk/0123-do-this). The console and Telegram are ONE
operator with two equally valid surfaces:

  • OUTPUT TO BOTH. Whatever you report or ask in the console, ALSO channel_send to
    the operator on the Orchestrate topic — status digests, questions, approval
    relays — and treat anything that arrives on Telegram as if it were said in the
    console. Never let a message live in only one place; the operator may be at
    either surface.
  • INPUT FROM EITHER. Accept the operator's instructions and answers from EITHER
    the console (a message in this session) OR an inbound Telegram message, as
    equally authoritative. Whichever arrives first wins; it's the same operator.
  • NO BLOCKING CONSOLE UI. Do NOT use AskUserQuestion or any interactive
    option-picker — it blocks the terminal and cannot be answered from Telegram.
    When you need the operator to choose, write the question plus a plain NUMBERED
    LIST of the possible options as ordinary text (this shows in the console) AND
    channel_send the same list to the Orchestrate topic, then WAIT for the
    operator's free-text reply from EITHER surface and act on it. Never stall on one
    channel.

Everywhere the sweep above says "me", "surface to me", "report", or "let me say go",
that means the OPERATOR ON BOTH surfaces — console output plus a channel_send to the
Orchestrate topic.

SENDING ON TELEGRAM — route by NUMERIC thread id (a topic NAME does not work as
`to`). Resolve names -> ids from the listener registry
  ~/.claude/channels/telegram/topic-names.json
which is JSON: { "<chat_id>": { "<topic name>": <thread_id>, ... } } (normally one
chat_id — use it). Read it with the Read tool when you need an id.
  • Operator = the "Orchestrate" topic id. If "Orchestrate" is NOT in the registry
    yet, send to the General topic (channel_send with no `to`), ask the operator to
    write once in the Orchestrate topic, and adopt that inbound message's
    message_thread_id for the operator from then on this session.
  • A dev agent = its BRANCH-named topic id; channel_send to=<that id> (you may
    message it proactively, no prior inbound needed). DRIVE its actual work via
    run_session_prompt on its vibe-kanban session; the topic is for conversation.

WELCOME — first tick of THIS session ONLY: greet the operator (your console output
is automatic; ALSO channel_send the hello to Orchestrate): orchestrator online, the
board/scope you're watching, the loop interval, and that you surface decisions on
both console and Telegram. Never resend it on later ticks.

For approvals, relay the agent's request + its approval_id / execution_process_id to
both surfaces and act once the operator answers on EITHER; never approve on an
agent's own say-so. Post a brief status digest to Orchestrate each tick (it shows in
the console too).
TG_EOF

# Loop body = shared sweep + the Telegram addendum.
LOOP_BODY="$(cat "${PROMPT_FILE}")
${TG_ADDENDUM}"

# Channel ref form: plugin:<plugin-name>:<mcp-server-name> (NOT the @marketplace
# form). The sombrax-telegram plugin and its MCP server are both named
# sombrax-telegram, so the doubled segment is intentional. Override via
# CLAUDE_CHANNEL_REF for ad-hoc testing.
CHANNEL_REF="${CLAUDE_CHANNEL_REF:-plugin:sombrax-telegram:sombrax-telegram}"

# Launch the orchestrator AGENT directly (not as a Task subagent) — its full
# behavior lives in the agent definition. `--plugin-dir` loads this checkout for the
# session so the `vibe-kanban-indie:orchestrator` agent name resolves (cd-ing here
# does not load it); it also loads the bundled `.mcp.json`, so don't ALSO have the
# plugin installed via the marketplace (double MCP — see ../README.md "pick one
# mode"). PLUGIN_DIR defaults to this checkout; override ORCH_AGENT to change agent.
# Resolve to an ABSOLUTE path now (default = this checkout) — must happen before the
# cd below, or a relative PLUGIN_DIR override would resolve against the temp dir.
PLUGIN_DIR="$(cd "${PLUGIN_DIR:-$(pwd)}" && pwd)"
ORCH_AGENT="${ORCH_AGENT:-vibe-kanban-indie:orchestrator}"

# Run from a neutral working directory so Claude does NOT also auto-discover this
# plugin dir's project-level `.mcp.json` — `--plugin-dir` already registers the
# bundled MCP, and discovering the same `.mcp.json` from cwd would start a duplicate
# vibe-kanban server. (LOOP_BODY/TG_ADDENDUM are already built and the backend env
# already exported, so cwd no longer matters here.)
cd "$(mktemp -d)"

exec claude \
  --dangerously-load-development-channels="${CHANNEL_REF}" \
  --dangerously-skip-permissions \
  --plugin-dir "${PLUGIN_DIR}" \
  --agent "${ORCH_AGENT}" \
  "/loop ${INTERVAL} ${LOOP_BODY}"
