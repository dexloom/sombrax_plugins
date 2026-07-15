#!/usr/bin/env bash
#
# directives-block.sh — build the "Directives enabled for this run" block that the
# orchestrator agent reads to turn on its opt-in behaviors. This file is **sourced**
# (not executed) by orchestrator.sh, so every launch emits the identical block and
# can't drift. It sets one variable:
#
#   DIRECTIVES_BLOCK  — the block text to append to the /loop spawn prompt, or an
#                       EMPTY string when no directive env is set (the default: no
#                       block ⇒ no directive behavior — dispatch + status
#                       reflection only).
#
# Directive toggles (env vars; default-off, matching every directive's default):
#   ORCH_AUTO_UNBLOCK=1            enable `auto-unblock` (truthy: 1/true/yes/on)
#                                  — documented INERT until Agent-ops 5/5 (headless
#                                  runs skip permissions; nothing to unblock today).
#   ORCH_AUTO_ANSWER=1             enable `auto-answer-questions` (truthy: 1/true/yes/on)
#                                  — documented INERT until Agent-ops 5/5 (nothing
#                                  raises question approvals yet).
#   ORCH_TELEGRAM_FANOUT=1         enable `telegram-fanout` (truthy: 1/true/yes/on) —
#                                  needs the sombrax-telegram channel loaded.
#   ORCH_NUDGE_STUCK=1             enable `nudge-stuck` (truthy: 1/true/yes/on) — send
#                                  a follow-up to a managed agent whose latest run is
#                                  terminal WITHOUT a completion or park signal.
#
# NOTE: this plugin wires only the four toggles above — no context-compaction
# directive/case exists here (deliberately dropped). Headless per-run processes
# never accumulate context across a session — each run is a fresh process — so
# that class of directive does not apply to VibeCrew.
#
# Add future directive toggles here the same way (one `case` per flag, appending a
# `- <flag>` line). `agents/orchestrator.md`'s *Directives* section defines what
# each named flag actually does; this script only decides which flags are listed.

_directive_lines=""

# auto-unblock: INERT until Agent-ops 5/5 (see agents/orchestrator.md).
case "${ORCH_AUTO_UNBLOCK:-}" in
  1 | true | yes | on | TRUE | YES | ON)
    _directive_lines="${_directive_lines}
- auto-unblock"
    ;;
esac

# auto-answer-questions: INERT until Agent-ops 5/5 (see agents/orchestrator.md).
case "${ORCH_AUTO_ANSWER:-}" in
  1 | true | yes | on | TRUE | YES | ON)
    _directive_lines="${_directive_lines}
- auto-answer-questions"
    ;;
esac

# telegram-fanout: proactive operator-topic messages. Needs the sombrax-telegram channel.
case "${ORCH_TELEGRAM_FANOUT:-}" in
  1 | true | yes | on | TRUE | YES | ON)
    _directive_lines="${_directive_lines}
- telegram-fanout"
    ;;
esac

# nudge-stuck: follow-up a managed agent whose latest run is terminal with no
# completion/park signal (never a `running` run — that would 409 anyway).
case "${ORCH_NUDGE_STUCK:-}" in
  1 | true | yes | on | TRUE | YES | ON)
    _directive_lines="${_directive_lines}
- nudge-stuck"
    ;;
esac

if [[ -n "${_directive_lines}" ]]; then
  # Two leading newlines separate the block from the rest of the spawn prompt; the
  # block must END the prompt (the agent expects the directive list to "end the
  # prompt"), so the launcher appends DIRECTIVES_BLOCK last.
  DIRECTIVES_BLOCK="

Directives enabled for this run — apply each one's behavior as defined in your agent
instructions:${_directive_lines}"
else
  DIRECTIVES_BLOCK=""
fi

unset _directive_lines
