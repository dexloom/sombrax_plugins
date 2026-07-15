#!/usr/bin/env bash
#
# resolve-backend.sh — make the VibeCrew backend reachable to the plugin's
# Python client and to a launched `claude` session.
#
# Source this (`. scripts/resolve-backend.sh`) before launching `claude`. It
# exports VIBECREW_URL so `vibecrew_api.py` resolves the backend from tier 1 of
# its own lookup order (see the client's `resolve_base_url()`), instead of
# re-deriving it every subcommand.
#
# Resolution order (matches vibecrew_api.py exactly):
#   1. VIBECREW_URL, if already set  -> respected as-is.
#   2. ~/.vibecrew/instance.json     -> its integer "port" field (may be
#      absent on older builds — tolerated, falls through).
#   3. ~/.vibecrew/port              -> a plain integer written by CrewRuntime
#      on server start.
#   4. Default http://127.0.0.1:48620 (CrewRuntime.defaultPort).
#
# Then it health-checks the resolved URL at the LEAF path /health (this is the
# one route registered at the router root — every other route lives under the
# /api/ prefix) and prints a warning (non-fatal) if the backend doesn't
# answer, so a dead backend is reported up front.
#
# No port-file candidate search across TMPDIRs here — that was a
# vibe-kanban-indie-specific workaround for a sandboxed TMPDIR differing from
# the real per-user temp dir. VibeCrew's port file lives at a fixed path
# (~/.vibecrew/port), so there is nothing to search.

# --- 1. already set? -------------------------------------------------------
if [[ -n "${VIBECREW_URL:-}" ]]; then
  echo "resolve-backend: using VIBECREW_URL=${VIBECREW_URL} (preset)" >&2
else
  _vc_port=""

  # --- 2. ~/.vibecrew/instance.json -> {"port": N} --------------------------
  _vc_instance="${HOME}/.vibecrew/instance.json"
  if [[ -f "${_vc_instance}" ]]; then
    _vc_port="$(python3 -c '
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)
    port = data.get("port")
    if isinstance(port, int):
        print(port)
    elif isinstance(port, str) and port.strip().isdigit():
        print(int(port.strip()))
except Exception:
    pass
' "${_vc_instance}" 2>/dev/null)"
  fi

  # --- 3. ~/.vibecrew/port -> plain integer ---------------------------------
  if [[ -z "${_vc_port}" ]]; then
    _vc_port_file="${HOME}/.vibecrew/port"
    if [[ -f "${_vc_port_file}" ]]; then
      _vc_candidate="$(cat "${_vc_port_file}" 2>/dev/null | tr -d '[:space:]')"
      if [[ "${_vc_candidate}" =~ ^[0-9]+$ ]]; then
        _vc_port="${_vc_candidate}"
      fi
    fi
  fi

  # --- 4. default -------------------------------------------------------------
  if [[ -z "${_vc_port}" ]]; then
    _vc_port=48620
    echo "resolve-backend: no ~/.vibecrew/instance.json or ~/.vibecrew/port found; defaulting to port ${_vc_port}." >&2
  fi

  export VIBECREW_URL="http://127.0.0.1:${_vc_port}"
  echo "resolve-backend: VIBECREW_URL=${VIBECREW_URL}" >&2
  unset _vc_port _vc_instance _vc_port_file _vc_candidate
fi

# --- health check (non-fatal) — the leaf /health route -----------------------
if curl -s -m 3 -o /dev/null -w '%{http_code}' "${VIBECREW_URL}/health" 2>/dev/null | grep -q '^200$'; then
  echo "resolve-backend: backend healthy at ${VIBECREW_URL}" >&2
else
  echo "resolve-backend: WARNING — ${VIBECREW_URL}/health did not return 200." >&2
  echo "  Start the VibeCrew app and retry." >&2
fi
