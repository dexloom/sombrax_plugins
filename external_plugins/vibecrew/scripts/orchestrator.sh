#!/usr/bin/env bash
#
# orchestrator.sh — launch the orchestrator agent
# (`claude --agent vibecrew:orchestrator`) and tick it on an interval.
#
# STANDALONE MODE. Normally VibeCrew's own runtime owns the orchestrator loop:
# one worker inside the app composes each tick ping (instruction + a
# host-computed STATUS DIGEST + the enabled directives), delivers it, and reads
# the agent's `CADENCE:` reply to decide when to tick again. This script exists
# for the case where you want an orchestrator WITHOUT the app driving it — a
# dev checkout, a headless box, a debugging session.
#
# It is a DELIBERATELY DEGRADED loop, and the degradations are worth knowing:
#
#   * No status digest. A shell ticker has no database access, so each ping says
#     so explicitly and the agent probes the API itself. Slower, not wrong.
#   * Fixed interval. The agent still emits its `CADENCE:` line — but nothing
#     here reads it, so a `re-arm 30m` is ignored and the loop keeps ticking at
#     whatever interval you launched with. Under the app, that line is obeyed.
#
# No `/loop` is armed, for any executor. The agent holds no cron tools and arms
# no timer of its own; the ticker below is the only clock. (Before this, Claude
# self-armed a `/loop` cron — invisible and uncontrollable from outside its own
# session — while OpenCode got a loop that died with the app's UI.)
#
# Usage:
#   scripts/orchestrator.sh            # tick every 5 minutes
#   scripts/orchestrator.sh 10m        # tick every 10 minutes
#   scripts/orchestrator.sh 300s       # tick every 300 seconds
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
#   ORCH_AUTO_UNBLOCK=1 scripts/orchestrator.sh     # auto-unblock
#   ORCH_AUTO_ANSWER=1 scripts/orchestrator.sh      # auto-answer-questions
#   ORCH_TELEGRAM_FANOUT=1 scripts/orchestrator.sh  # telegram-fanout
#   ORCH_NUDGE_STUCK=1 scripts/orchestrator.sh      # nudge-stuck
#
# To stop the loop: type "stop the loop" in the session, or Ctrl-C / exit it,
# then kill the ticker (it exits on its own when the tmux session goes away).
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

# ---------------------------------------------------------------------------
# The standalone ticker
#
# Re-submits the ping into the orchestrator's tmux pane every INTERVAL. It has
# to be started BEFORE `orchestrator_launch`, because that helper always ends in
# `tmux attach` (which `exec`s, replacing this process) or an `exit 0` — nothing
# placed after it would ever run.
#
# Only the launcher that actually CREATES the session starts a ticker. A second
# invocation attaches to the running orchestrator, and must not add a second
# clock ticking the same pane.
#
# Delivery uses the same load-buffer/paste-buffer path the app's worker uses,
# not `send-keys` with the text inline: tmux ships commands to its server over a
# socket with a ~16 KiB cap, and a multi-line prompt sent as keys would submit on
# its first newline.
#
# Fixed interval by design — see the header. The agent's `CADENCE:` line is
# still emitted (and still correct); this loop has no way to act on it.
# ---------------------------------------------------------------------------

# Seconds, from the same `<N>[smh]` forms the interval grammar accepts.
_orch_interval_seconds() {
  local raw="$1" num unit
  num="${raw%[smh]}"
  unit="${raw##*[0-9]}"
  case "${unit}" in
    s) echo "${num}" ;;
    m|"") echo $(( num * 60 )) ;;
    h) echo $(( num * 3600 )) ;;
    *) echo 300 ;;
  esac
}

_orch_ticker() {
  local seconds tick=1 buf tick_file
  seconds="$(_orch_interval_seconds "${INTERVAL}")"
  while true; do
    sleep "${seconds}"
    # The session going away is the loop's exit signal — the operator quit the
    # orchestrator, so there is nothing left to tick.
    tmux has-session -t "=${ORCH_TMUX_SESSION}" 2>/dev/null || return 0
    tick=$(( tick + 1 ))

    buf="vc-orch-tick-${tick}"
    tick_file="$(mktemp)"
    {
      printf 'ORCHESTRATOR TICK (#%s, interval %s). ' "${tick}" "${INTERVAL}"
      tail -n +2 "${PROMPT_FILE}"
      printf '\n\nPLUGIN ROOT: %s' "${PLUGIN_DIR}"
      printf '%s' "${DIRECTIVES_BLOCK}"
    } > "${tick_file}"

    tmux load-buffer -b "${buf}" "${tick_file}" 2>/dev/null || { rm -f "${tick_file}"; return 0; }
    tmux paste-buffer -b "${buf}" -t "${ORCH_TMUX_SESSION}" -p -d 2>/dev/null || true
    tmux send-keys -t "${ORCH_TMUX_SESSION}" Enter 2>/dev/null || true
    rm -f "${tick_file}"
  done
}

# Start a ticker only when THIS invocation is the one creating the session.
# `ORCH_TICKER=0` opts out entirely (e.g. when something else drives the ticks).
if [[ "${ORCH_TICKER:-1}" == "1" ]] \
   && ! tmux has-session -t "=${ORCH_TMUX_SESSION}" 2>/dev/null; then
  _orch_ticker &
  echo "orchestrator.sh: ticking '${ORCH_TMUX_SESSION}' every ${INTERVAL} (ticker pid $!)" >&2
fi

# Kick off (or attach to) the session. NO `/loop` prefix — the agent arms no
# timer; the ticker above is the clock. This call does not return: it execs
# `tmux attach` (with a TTY) or exits.
orchestrator_launch --plugin-dir "${PLUGIN_DIR}" --agent "${ORCH_AGENT}" "${LOOP_BODY}"
