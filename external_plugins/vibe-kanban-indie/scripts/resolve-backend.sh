#!/usr/bin/env bash
#
# resolve-backend.sh — make the vibe-kanban backend reachable to the MCP server.
#
# Source this (`. scripts/resolve-backend.sh`) before launching `claude`. It
# exports VIBE_BACKEND_URL so the MCP resolves the backend from step 1 of its
# lookup order — instead of relying on the port file under $TMPDIR, which breaks
# when the shell runs with a sandboxed TMPDIR (e.g. /tmp/claude-501) that differs
# from the real per-user temp dir where the app actually writes the port file.
#
# Resolution order:
#   1. VIBE_BACKEND_URL, if already set  -> respected as-is.
#   2. The vibe-kanban.port file, searched across candidate temp dirs:
#        - $TMPDIR/vibe-kanban/
#        - $(getconf DARWIN_USER_TEMP_DIR)/vibe-kanban/   (real macOS user temp)
#        - /tmp/vibe-kanban/
#      -> exports VIBE_BACKEND_URL=http://127.0.0.1:<main_port>.
#
# Then it health-checks the resolved URL and prints a warning (non-fatal) if the
# backend doesn't answer, so a dead backend is reported up front rather than as
# "MCP tools not connected" inside the session.

# --- 1. already set? -------------------------------------------------------
if [[ -n "${VIBE_BACKEND_URL:-}" ]]; then
  echo "resolve-backend: using VIBE_BACKEND_URL=${VIBE_BACKEND_URL} (preset)" >&2
else
  # --- 2. find the port file ----------------------------------------------
  _vk_candidates=()
  [[ -n "${TMPDIR:-}" ]] && _vk_candidates+=("${TMPDIR%/}/vibe-kanban/vibe-kanban.port")
  _vk_darwin_tmp="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"
  [[ -n "${_vk_darwin_tmp}" ]] && _vk_candidates+=("${_vk_darwin_tmp%/}/vibe-kanban/vibe-kanban.port")
  _vk_candidates+=("/tmp/vibe-kanban/vibe-kanban.port")

  # Pick the first candidate whose backend is ALIVE — not merely the first file
  # that exists. A stale port file (e.g. a sandbox $TMPDIR/.../vibe-kanban.port
  # left over from a dead instance) otherwise shadows the live one and pins us to
  # a dead port. Health-check each; fall back to the freshest existing file only if
  # none answers.
  _vk_alive_url=""; _vk_alive_src=""
  _vk_fallback_url=""; _vk_fallback_src=""; _vk_fallback_mtime=0
  for _vk_f in "${_vk_candidates[@]}"; do
    [[ -f "${_vk_f}" ]] || continue
    _vk_port="$(sed -n 's/.*"main_port":\([0-9]*\).*/\1/p' "${_vk_f}" 2>/dev/null)"
    [[ -n "${_vk_port}" ]] || continue
    _vk_url="http://127.0.0.1:${_vk_port}"
    # freshest existing-but-maybe-dead file = last-resort fallback
    _vk_m="$(stat -f '%m' "${_vk_f}" 2>/dev/null || stat -c '%Y' "${_vk_f}" 2>/dev/null || echo 0)"
    if [[ "${_vk_m}" -ge "${_vk_fallback_mtime}" ]]; then
      _vk_fallback_mtime="${_vk_m}"; _vk_fallback_url="${_vk_url}"; _vk_fallback_src="${_vk_f}"
    fi
    if [[ -z "${_vk_alive_url}" ]] \
       && curl -s -m 3 -o /dev/null -w '%{http_code}' "${_vk_url}/api/health" 2>/dev/null | grep -q '^200$'; then
      _vk_alive_url="${_vk_url}"; _vk_alive_src="${_vk_f}"
    fi
  done

  if [[ -n "${_vk_alive_url}" ]]; then
    export VIBE_BACKEND_URL="${_vk_alive_url}"
    echo "resolve-backend: VIBE_BACKEND_URL=${VIBE_BACKEND_URL} (alive, from ${_vk_alive_src})" >&2
  elif [[ -n "${_vk_fallback_url}" ]]; then
    export VIBE_BACKEND_URL="${_vk_fallback_url}"
    echo "resolve-backend: WARNING — no port file's backend answered /api/health." >&2
    echo "  Falling back to freshest port file: ${VIBE_BACKEND_URL} (from ${_vk_fallback_src})" >&2
  else
    echo "resolve-backend: WARNING — no vibe-kanban.port file found in:" >&2
    printf '  %s\n' "${_vk_candidates[@]}" >&2
    echo "  Is the backend running? Set VIBE_BACKEND_URL to override." >&2
  fi
fi

# --- 3. health check (non-fatal) ------------------------------------------
if [[ -n "${VIBE_BACKEND_URL:-}" ]]; then
  if curl -s -m 3 -o /dev/null -w '%{http_code}' "${VIBE_BACKEND_URL}/api/health" 2>/dev/null | grep -q '^200$'; then
    echo "resolve-backend: backend healthy at ${VIBE_BACKEND_URL}" >&2
  else
    echo "resolve-backend: WARNING — ${VIBE_BACKEND_URL}/api/health did not return 200." >&2
    echo "  Start the app (desktop / CLI / 'pnpm run dev' in the vibe-kanban repo) and retry." >&2
  fi
fi
