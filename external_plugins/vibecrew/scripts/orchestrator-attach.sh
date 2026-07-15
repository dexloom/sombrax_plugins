#!/usr/bin/env bash
#
# orchestrator-attach.sh — "spawn = connect" launch for the orchestrator.
#
# SOURCED by orchestrator.sh (it does NOT set -euo pipefail of its own — that
# is inherited from the sourcing launcher). It defines orchestrator_launch(),
# which wraps `claude` in a STABLE, NAMED tmux session so that a SECOND launch
# ATTACHES to the already-running orchestrator instead of spawning a duplicate
# (and the backend a duplicate standby workspace, if VibeCrew tracks one).
#
# Why tmux (not a bare `exec claude`): a bare foreground launch with no dedupe
# would let two invocations produce two competing orchestrators. A stable tmux
# session gives us a pre-launch liveness check (`tmux has-session`) and a
# place to re-attach to.
#
# Env override:
#   ORCH_TMUX_SESSION   — the stable session name (default: vc-orchestrator).

# Stable session name (override for ad-hoc testing).
ORCH_TMUX_SESSION="${ORCH_TMUX_SESSION:-vc-orchestrator}"

# Env vars the wrapped `claude` session needs at RUNTIME. A pre-existing tmux
# SERVER keeps the environment from when IT first started, NOT the launcher's,
# so a new session does not automatically see VIBECREW_URL et al. We therefore
# forward these explicitly via an `env VAR=val …` prefix rather than trusting
# inheritance. (Directive toggles like ORCH_NUDGE_STUCK are already baked into
# the /loop prompt by directives-block.sh, so they need no forwarding here.)
_ORCH_ENV_FORWARD=(
  VIBECREW_URL
  TELEGRAM_PROJECT_MANAGER TELEGRAM_TOPIC ORCH_OPERATOR_TOPIC
  TELEGRAM_LISTENER_SOCKET CLAUDE_CHANNEL_REF
)

# _orchestrator_attach_or_report [why]
#   Attach to the stable session if we have a TTY; otherwise report that it is
#   running and exit 0 (never error on `tmux attach` without a terminal). Also
#   the safe landing for a session that vanished or a lost create race: report
#   + exit 0 rather than abort.
_orchestrator_attach_or_report() {
  local why="${1:-running}"
  local target="=${ORCH_TMUX_SESSION}"   # leading '=' ⇒ EXACT match (no prefix/glob)
  if [[ -t 1 && -t 0 ]]; then
    exec tmux attach-session -t "${target}"
  fi
  echo "orchestrator-attach: orchestrator ${why} in tmux session '${ORCH_TMUX_SESSION}'." >&2
  echo "  No TTY to attach. Run 'tmux attach -t ${ORCH_TMUX_SESSION}' from a terminal." >&2
  exit 0
}

# orchestrator_launch <claude-arg>...
#   <claude-arg>... is the full `claude` argv the launcher built
#   (e.g. --plugin-dir X --agent Y "/loop 5m <body>"). Call this IN PLACE OF
#   the launcher's final `exec claude …`.
orchestrator_launch() {
  # tmux is REQUIRED — without it we cannot dedupe, and silently running
  # `claude` in the foreground would re-permit the duplicate-orchestrator
  # defect. Fail clearly instead.
  if ! command -v tmux >/dev/null 2>&1; then
    echo "orchestrator-attach: ERROR — tmux is required for the orchestrator launcher" >&2
    echo "  (it dedupes / attaches to an already-running orchestrator). Install tmux and retry." >&2
    exit 1
  fi

  local target="=${ORCH_TMUX_SESSION}"

  # Resolve an absolute claude binary so tmux execs it directly (no shell, no
  # PATH surprises inside the server's environment).
  local claude_bin
  claude_bin="$(command -v claude || true)"
  if [[ -z "${claude_bin}" ]]; then
    echo "orchestrator-attach: ERROR — 'claude' not found on PATH" >&2
    exit 1
  fi

  # Already running? Attach. Checked BEFORE any mktemp, so an attach-only
  # invocation leaks no temp dir.
  if tmux has-session -t "${target}" 2>/dev/null; then
    _orchestrator_attach_or_report
    return
  fi

  # Not running → create the named session and launch claude inside it.
  # Neutral cwd only on the launch path — there is no `.mcp.json` to avoid
  # discovering (this plugin ships none), but a neutral cwd still keeps the
  # session out of any repo worktree.
  local neutral
  neutral="$(mktemp -d)"

  # Build the `env VAR=val …` prefix from whichever forward-vars are set.
  local env_prefix=(env)
  local v
  for v in "${_ORCH_ENV_FORWARD[@]}"; do
    [[ -n "${!v:-}" ]] && env_prefix+=("${v}=${!v}")
  done

  # Pass argv DIRECTLY to tmux (executable + each arg as a separate word) —
  # tmux execs them directly without a shell, so the multi-line /loop prompt
  # round-trips with no quoting work. Don't let `new-session` abort the
  # launcher under `set -e` if we lost a creation race; fall through to attach
  # instead.
  if ! tmux new-session -d -s "${ORCH_TMUX_SESSION}" -c "${neutral}" \
         "${env_prefix[@]}" "${claude_bin}" "$@" 2>/dev/null; then
    echo "orchestrator-attach: session '${ORCH_TMUX_SESSION}' already exists (race); attaching." >&2
    _orchestrator_attach_or_report
    return
  fi

  _orchestrator_attach_or_report "started"
}
