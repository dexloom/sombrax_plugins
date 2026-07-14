#!/usr/bin/env bash
#
# directives-block.sh — build the "Directives enabled for this run" block that the
# orchestrator agent reads to turn on its opt-in behaviors. This file is **sourced**
# (not executed) by orchestrator.sh and orchestrate_tg.sh, so both launchers emit the
# identical block and can't drift. It sets one variable:
#
#   DIRECTIVES_BLOCK  — the block text to append to the /loop spawn prompt, or an
#                       EMPTY string when no directive env is set (the default: no
#                       block ⇒ no directive behavior — dispatch, status reflection,
#                       and the always-on operator-instruction route (spawn intake)
#                       only).
#
# Directive toggles (env vars; default-off, matching every directive's default):
#   ORCH_AUTO_UNBLOCK=1            enable `auto-unblock` (truthy: 1/true/yes/on)
#   ORCH_AUTO_ANSWER=1             enable `auto-answer-questions` (truthy: 1/true/yes/on)
#   ORCH_TELEGRAM_FANOUT=1         enable `telegram-fanout` (truthy: 1/true/yes/on) —
#                                  needs the sombrax-telegram channel, i.e. orchestrate_tg.sh
#   ORCH_AUTO_COMPACT=1            enable `auto-compact` (truthy: 1/true/yes/on)
#   ORCH_COMPACT_THRESHOLD=300000  per-run context threshold for auto-compact, in
#                                  tokens (default 300000 when auto-compact is on)
#   ORCH_NUDGE_STUCK=1            enable `nudge-stuck` (truthy: 1/true/yes/on) — send
#                                  "Why are you stuck" to a managed agent with no
#                                  progress across two consecutive ticks
#
# Add future directive toggles here the same way (one `case` per flag, appending a
# `- <flag>` line). The `agents/sweeper.md` agent definition's *Directives* section
# defines what each named flag actually does; this script only decides which flags are
# listed.

_directive_lines=""

# auto-unblock: approve routine, plan-sanctioned tool-permission requests; escalate the rest.
case "${ORCH_AUTO_UNBLOCK:-}" in
  1 | true | yes | on | TRUE | YES | ON)
    _directive_lines="${_directive_lines}
- auto-unblock"
    ;;
esac

# auto-answer-questions: answer a stale question prompt past its grace window.
case "${ORCH_AUTO_ANSWER:-}" in
  1 | true | yes | on | TRUE | YES | ON)
    _directive_lines="${_directive_lines}
- auto-answer-questions"
    ;;
esac

# telegram-fanout: proactive operator-topic messages + headed-agent topic conversation.
# Needs the sombrax-telegram channel — i.e. launch via orchestrate_tg.sh.
case "${ORCH_TELEGRAM_FANOUT:-}" in
  1 | true | yes | on | TRUE | YES | ON)
    _directive_lines="${_directive_lines}
- telegram-fanout"
    ;;
esac

# auto-compact: trigger /compact on headed agents whose context exceeds the threshold.
case "${ORCH_AUTO_COMPACT:-}" in
  1 | true | yes | on | TRUE | YES | ON)
    _threshold="${ORCH_COMPACT_THRESHOLD:-300000}"
    _directive_lines="${_directive_lines}
- auto-compact (threshold: ${_threshold})"
    ;;
esac

# nudge-stuck: send "Why are you stuck" to a managed agent with no progress for 2 ticks.
case "${ORCH_NUDGE_STUCK:-}" in
  1 | true | yes | on | TRUE | YES | ON)
    _directive_lines="${_directive_lines}
- nudge-stuck"
    ;;
esac

if [[ -n "${_directive_lines}" ]]; then
  # Two leading newlines separate the block from the rest of the spawn prompt; the
  # block must END the prompt (the agent expects the directive list to "end the
  # prompt"), so launchers append DIRECTIVES_BLOCK last.
  DIRECTIVES_BLOCK="

Directives enabled for this run — apply each one's behavior as defined in your agent
instructions:${_directive_lines}"
else
  DIRECTIVES_BLOCK=""
fi

unset _directive_lines _threshold
