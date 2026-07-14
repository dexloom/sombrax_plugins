#!/usr/bin/env bash
#
# orchestrator-delta.sh — the delta gate: skip `get_execution` for sessions whose
# observable state has not changed since the last tick.
#
# Two subcommands, JSON in / JSON(-lines) out:
#
#   probe   <  JSON array of {session_id, column, pull_request_count,
#              latest_pr_url, latest_pr_status, force?} on stdin
#           >  one JSON object per line, one per input session, IN INPUT ORDER:
#              {"action":"POLL"|"SKIP", "session_id":…, "execution_id":…,
#               "reason":…, "fingerprint":…, [is_finished, is_parked,
#               has_approvals, transcript_path, tmux_session_name,
#               claude_session_id — SKIP only]}
#
#   commit  <  JSON array of probe lines (only session_id/execution_id/fingerprint
#              are read; every other key is ignored) on stdin
#           >  nothing on stdout; rewrites the state file atomically
#
# FAIL-OPEN IS THE WHOLE POINT (CR-4). This script's caller — the sweeper
# agent — has `Bash` but no `Write` tool, so it cannot itself parse a broken
# output stream reliably. The agent therefore validates this script's output as
# a strict CONTRACT (exit 0; one JSON object per line; exactly N lines in input
# order with matching session_ids; action is POLL or SKIP; every SKIP carries a
# non-null execution_id, a ^[0-9a-f]{16}$ fingerprint, and real booleans) and, on
# ANY violation — including a non-zero exit or unparseable stdout — falls back
# for EVERY session it sent: raw `Bash` GET
# `$VIBE_BACKEND_URL/api/sessions/<session_id>/executions`, take the last
# `run_reason == "codingagent"` entry, then `get_execution(execution_id)`, and
# decide exactly as before this gate existed. That fallback is the pre-change
# code path and is the correct fail-open — see `agents/sweeper.md` →
# "The delta gate". This script therefore NEVER emits N POLL lines as a
# substitute for a hard failure: a hard failure means NO stdout at all, so the
# agent's fallback is unambiguously triggered rather than silently degraded.
#
# THE SUPERSET + DISCRIMINATOR INVARIANT (CR-5) — the invariant that outlives
# this card: the fingerprint computed by `probe` must remain a SUPERSET of every
# input the column-decision rules in `agents/sweeper.md` ("Deciding the
# column") consume, PLUS a discriminator for every way a turn can change without
# changing any of those inputs. Today that discriminator is the sha256 CONTENT
# HASH of the headed transcript file — never file metadata (size + modification
# time), which cannot distinguish a same-size in-place rewrite within one second
# from no change at all. If you add an input to the column-decision rules, add it
# to the digest below AND bump `v` in the digest document (a version bump makes
# every session POLL once — the safe direction).
#
# THIS IS THE FIRST PLUGIN SCRIPT TO REQUIRE `jq`. The other scripts
# (`resolve-backend.sh`, `directives-block.sh`) deliberately avoid it. `jq`'s
# absence is a hard failure (exit 3, checked FIRST, before any stdin read) —
# handled by the agent's CR-4 fallback above, not by a `jq`-free parser here.
#
# `commit` MUST be fed every SKIPped session, not only POLLed ones, or the state
# file empties every other tick and the gate sawtooths between "everything looks
# new" and "everything looks stale" — see `agents/sweeper.md` → "The delta
# gate" and CR-3/AC-1.
#
# DIGEST INPUTS ARE CANONICAL TYPED JSON, ASSEMBLED WITH `jq -n` AND CANONICALIZED
# WITH `jq -cS`, NEVER joined shell strings and NEVER `-`/sentinel placeholders
# for a missing value (CR-1): a real `null` and the literal string "-" must hash
# to DIFFERENT digests. Never `jq -r` a digest input — `-r` strips the JSON
# quoting a trailing newline needs to survive a shell command substitution.
#
# THE STATE FILE CACHES FINGERPRINTS ONLY — never a boolean, never a handle
# (CR-2). Every fact a SKIP line reports (`is_finished`, `is_parked`,
# `has_approvals`, the headed handles) is derived FRESH, this tick, from the
# same responses that produced the fingerprint; nothing is ever replayed from
# the cache. A forged or stale cache entry can therefore never inject a false
# fact — at worst it produces a wrong SKIP/POLL classification, never a wrong
# fact on a line the orchestrator trusts.
#
# CR-3'S APPLY RULE: `commit` is the LAST operation of a tick. A fingerprint
# must be committed for a POLLed session ONLY IF that session's decision was
# actually applied this tick (the card was already in the target column, or
# `update_issue` returned success) — never for a POLLed session whose
# `get_execution` or `update_issue` failed or was never attempted. The column is
# itself part of the fingerprint, so committing a fingerprint for a decision
# that never landed would make the next tick recompute the SAME fingerprint,
# SKIP, and strand the card forever. Omitting that session's entry instead makes
# the next tick read `no-state` for it ⇒ POLL — fail-safe by construction.
#
# State file: ${VIBE_DELTA_STATE:-$HOME/.vibe-kanban/orchestrator-delta.json}
# Global valve: VIBE_DELTA_FORCE_MANAGED=1 (truthy) ⇒ POLL "forced" for every
#   session, unconditionally. Ships wired, off.

set -uo pipefail
# NOTE: deliberately NOT `set -e` — a single session's failure must degrade to a
# POLL line for that session, never abort the whole sweep mid-stream.

STATE="${VIBE_DELTA_STATE:-$HOME/.vibe-kanban/orchestrator-delta.json}"
PARK_MARKER='AWAITING OPERATOR APPROVAL'

usage() {
  cat >&2 <<'EOF'
Usage:
  <json-array-on-stdin> | orchestrator-delta.sh probe
  <json-array-on-stdin> | orchestrator-delta.sh commit

  probe  — one JSON object per input session (POLL or SKIP) on stdout.
  commit — persists probe lines' {session_id, execution_id, fingerprint} to the
           state file (${VIBE_DELTA_STATE:-$HOME/.vibe-kanban/orchestrator-delta.json}).

Non-zero exit, empty stdout ⇒ the caller must fall back (see CR-4 in the header).
EOF
}

# poll_line <sid> <reason> — the generic "nothing computed yet" POLL line: both
# execution_id and fingerprint are null. Used whenever we bail out before (or
# without ever) resolving a real execution id.
poll_line() {
  local sid="$1" reason="$2"
  jq -cn --arg sid "$sid" --arg reason "$reason" \
    '{action:"POLL", session_id:$sid, execution_id:null, reason:$reason, fingerprint:null}'
}

# poll_line_eid <sid> <reason> <eid> — a POLL line where the execution id IS
# known (fetched this tick) but no fingerprint could be computed (e.g. the
# headed transcript is unreadable, or a later fetch failed). Carrying the real
# eid here matters: the orchestrator's per-line handling treats
# `execution_id: null` as "no coding execution yet" and skips `get_execution`
# entirely — which would be WRONG here, since a real execution exists.
poll_line_eid() {
  local sid="$1" reason="$2" eid="$3"
  jq -cn --arg sid "$sid" --arg reason "$reason" --arg eid "$eid" \
    '{action:"POLL", session_id:$sid, execution_id:$eid, reason:$reason, fingerprint:null}'
}

# poll_line_fresh <sid> <reason> <eid> <fp> — a POLL line carrying a freshly
# computed fingerprint (new-session / fp-changed), so the orchestrator can
# commit it later without re-hashing anything itself.
poll_line_fresh() {
  local sid="$1" reason="$2" eid="$3" fp="$4"
  jq -cn --arg sid "$sid" --arg reason "$reason" --arg eid "$eid" --arg fp "$fp" \
    '{action:"POLL", session_id:$sid, execution_id:$eid, reason:$reason, fingerprint:$fp}'
}

# skip_line <sid> <eid> <fp> <is_finished> <is_parked> <has_approvals>
#           <transcript_path> <tmux_session_name> <claude_session_id>
# Every field here was read/derived THIS TICK — nothing is replayed from the
# state file (CR-2a). transcript_path / tmux_session_name / claude_session_id
# may legitimately be the JSON string "null" (bash string) meaning JSON null.
skip_line() {
  local sid="$1" eid="$2" fp="$3" is_finished="$4" is_parked="$5" has_approvals="$6"
  local tpath="$7" tmux="$8" claude="$9"
  jq -cn \
    --arg sid "$sid" --arg eid "$eid" --arg fp "$fp" \
    --argjson is_finished "$is_finished" --argjson is_parked "$is_parked" \
    --argjson has_approvals "$has_approvals" \
    --argjson tpath "$tpath" --argjson tmux "$tmux" --argjson claude "$claude" \
    '{action:"SKIP", session_id:$sid, execution_id:$eid, fingerprint:$fp,
      is_finished:$is_finished, is_parked:$is_parked, has_approvals:$has_approvals,
      transcript_path:$tpath, tmux_session_name:$tmux, claude_session_id:$claude}'
}

# is_truthy <value> — same truthy vocabulary as directives-block.sh.
is_truthy() {
  case "${1:-}" in
    1 | true | yes | on | TRUE | YES | ON) return 0 ;;
    *) return 1 ;;
  esac
}

cmd_probe() {
  local input="$1"

  # CR-2c — hard fail (exit 2) if ANY element lacks a non-empty string
  # session_id: we cannot even key a POLL line to it, so this is not a
  # per-session degradation — it aborts the whole probe (CR-4 makes the agent
  # fall back for every session it sent).
  if ! printf '%s' "$input" \
    | jq -e '[.[] | (.session_id? // null) | (type == "string" and length > 0)] | all' \
    >/dev/null 2>&1; then
    echo "orchestrator-delta.sh: every probe element must have a non-empty string session_id" >&2
    exit 2
  fi

  if is_truthy "${VIBE_DELTA_FORCE_MANAGED:-}"; then
    while IFS= read -r elem; do
      local sid
      sid="$(printf '%s' "$elem" | jq -r '.session_id')"
      poll_line "$sid" "forced"
    done < <(printf '%s' "$input" | jq -c '.[]')
    return 0
  fi

  local state_ok=1
  if [[ -n "$STATE" && -s "$STATE" ]] \
    && jq -e '.version == 1 and (.sessions | type == "object")' "$STATE" >/dev/null 2>&1; then
    state_ok=0
  fi

  if [[ $state_ok -ne 0 ]]; then
    while IFS= read -r elem; do
      local sid
      sid="$(printf '%s' "$elem" | jq -r '.session_id')"
      poll_line "$sid" "no-state"
    done < <(printf '%s' "$input" | jq -c '.[]')
    return 0
  fi

  while IFS= read -r elem; do
    local sid
    sid="$(printf '%s' "$elem" | jq -r '.session_id')"
    probe_one "$sid" "$elem"
  done < <(printf '%s' "$input" | jq -c '.[]')
  return 0
}

# probe_one <sid> <elem> — the per-session probe: validate input (CR-2c),
# fetch+validate executions/agent-progress/approvals (CR-2b), hash the headed
# transcript's CONTENT (CR-5), assemble the injective digest (CR-1), and
# compare it against the stored fingerprint (CR-2d).
probe_one() {
  local sid="$1" elem="$2"

  # --- Rule 2c: validate the rest of this element's fields. ---------------
  if ! printf '%s' "$elem" | jq -e '
      ((.column? // null)                 | type == "null" or type == "string")
      and ((.pull_request_count? // null) | type == "null" or type == "number")
      and ((.latest_pr_url? // null)      | type == "null" or type == "string")
      and ((.latest_pr_status? // null)   | type == "null" or type == "string")
      and ((.force? // false)             | type == "boolean")
    ' >/dev/null 2>&1; then
    poll_line "$sid" "bad-input"
    return
  fi

  if [[ "$(printf '%s' "$elem" | jq -r '.force? // false')" == "true" ]]; then
    poll_line "$sid" "forced"
    return
  fi

  # --- 1. executions: validate EVERY row (types+enums), project in one pass.
  local exec_raw
  if ! exec_raw="$(curl -sf -m 10 "$VIBE_BACKEND_URL/api/sessions/$sid/executions" 2>/dev/null)"; then
    poll_line "$sid" "probe-error"
    return
  fi

  local core_json
  core_json="$(printf '%s' "$exec_raw" | jq -c --arg sid "$sid" '
    if .success != true or (.data|type) != "array" then error("bad-envelope") else . end
    | ( .data[] | select(
          (.id|type) != "string" or (.session_id|type) != "string"
          or ((.run_reason) as $r | ($r|type) != "string"
               or (["setupscript","cleanupscript","archivescript","codingagent","devserver"]
                   | index($r)) == null)
          or ((.status) as $s | ($s|type) != "string"
               or (["running","completed","failed","killed"] | index($s)) == null)
          or ((.completed_at|type) as $t | $t != "null" and $t != "string")
          or ((.exit_code|type)    as $t | $t != "null" and $t != "number")
        ) | error("bad-row") ) // .
    | [ .data[] | select(.run_reason == "codingagent") ] | last
    | if . == null then null
      elif .session_id != $sid then error("sid-mismatch")
      else {eid: .id, status: .status, completed_at: .completed_at, exit_code: .exit_code,
            is_finished: (.status != "running")}
      end
  ' 2>/dev/null)"
  if [[ $? -ne 0 ]]; then
    poll_line "$sid" "probe-error"
    return
  fi
  if [[ "$core_json" == "null" ]]; then
    poll_line "$sid" "no-execution"
    return
  fi

  local eid is_finished
  eid="$(printf '%s' "$core_json" | jq -r '.eid')"
  is_finished="$(printf '%s' "$core_json" | jq -r '.is_finished')"

  # --- 2. agent-progress: validate, extract latest_message as JSON (never -r
  #        on the digest path), derive is_parked inside jq via `contains`.
  local ap_raw
  if ! ap_raw="$(curl -sf -m 10 "$VIBE_BACKEND_URL/api/execution-processes/$eid/agent-progress" 2>/dev/null)"; then
    poll_line_eid "$sid" "probe-error" "$eid"
    return
  fi

  local ap_doc
  ap_doc="$(printf '%s' "$ap_raw" | jq -c --arg marker "$PARK_MARKER" '
    if .success != true or (.data|type) != "object" then error("bad-envelope") else . end
    | .data
    | if ((.latest_message|type)   != "null" and (.latest_message|type)   != "string")
         or ((.transcript_path|type)   != "null" and (.transcript_path|type)   != "string")
         or ((.tmux_session_name|type) != "null" and (.tmux_session_name|type) != "string")
         or ((.claude_session_id|type) != "null" and (.claude_session_id|type) != "string")
      then error("bad-row")
      else {
        message: .latest_message,
        transcript_path: .transcript_path,
        tmux_session_name: .tmux_session_name,
        claude_session_id: .claude_session_id,
        is_parked: ((.latest_message // "") | contains($marker))
      }
      end
  ' 2>/dev/null)"
  if [[ $? -ne 0 ]]; then
    poll_line_eid "$sid" "probe-error" "$eid"
    return
  fi

  local is_parked message_json tpath_json tmux_json claude_json headed
  is_parked="$(printf '%s' "$ap_doc" | jq -r '.is_parked')"
  message_json="$(printf '%s' "$ap_doc" | jq -c '.message')"
  tpath_json="$(printf '%s' "$ap_doc" | jq -c '.transcript_path')"
  tmux_json="$(printf '%s' "$ap_doc" | jq -c '.tmux_session_name')"
  claude_json="$(printf '%s' "$ap_doc" | jq -c '.claude_session_id')"
  headed="$(printf '%s' "$ap_doc" | jq -r 'if .tmux_session_name != null then "true" else "false" end')"

  # --- 3. activity (CR-5): hash the transcript's CONTENT — never its metadata.
  local activity_json="null"
  if [[ "$headed" == "true" ]]; then
    local tpath
    tpath="$(printf '%s' "$ap_doc" | jq -r '.transcript_path // empty')"
    if [[ -z "$tpath" || ! -r "$tpath" ]]; then
      poll_line_eid "$sid" "no-transcript" "$eid"
      return
    fi
    local hex
    hex="$(shasum -a 256 -- "$tpath" 2>/dev/null | cut -d' ' -f1)"
    if [[ -z "$hex" ]]; then
      poll_line_eid "$sid" "no-transcript" "$eid"
      return
    fi
    activity_json="$(jq -cn --arg h "$hex" '$h')"
  fi

  # --- 4. approvals: validate, project sorted approval_id array (NOT .id). ---
  local apv_raw
  if ! apv_raw="$(curl -sf -m 10 "$VIBE_BACKEND_URL/api/approvals/pending/$eid" 2>/dev/null)"; then
    poll_line_eid "$sid" "probe-error" "$eid"
    return
  fi

  local apv_json
  apv_json="$(printf '%s' "$apv_raw" | jq -c '
    if .success != true or (.data|type) != "array" then error("bad-envelope") else . end
    | [ .data[] | if (.approval_id|type) != "string" then error("bad-row") else .approval_id end ]
    | sort
  ' 2>/dev/null)"
  if [[ $? -ne 0 ]]; then
    poll_line_eid "$sid" "probe-error" "$eid"
    return
  fi
  local has_approvals
  has_approvals="$(printf '%s' "$apv_json" | jq -r 'length > 0')"

  # --- 5. digest: canonical typed JSON, hashed (CR-1). ------------------------
  local core_for_digest card_json fp_doc fp
  core_for_digest="$(jq -cn --arg eid "$eid" \
    --argjson rest "$(printf '%s' "$core_json" | jq -c '{status, completed_at, exit_code}')" \
    '{eid: $eid} + $rest')"
  card_json="$(printf '%s' "$elem" | jq -c '{
    column: (.column // null),
    pull_request_count: (.pull_request_count // null),
    latest_pr_url: (.latest_pr_url // null),
    latest_pr_status: (.latest_pr_status // null)
  }')"
  fp_doc="$(jq -cnS \
    --argjson core "$core_for_digest" \
    --argjson approvals "$apv_json" \
    --argjson message "$message_json" \
    --argjson activity "$activity_json" \
    --argjson card "$card_json" \
    '{v:1, core:$core, approvals:$approvals, message:$message, activity:$activity, card:$card}' 2>/dev/null)"
  if [[ $? -ne 0 || -z "$fp_doc" ]]; then
    poll_line_eid "$sid" "probe-error" "$eid"
    return
  fi
  fp="$(printf '%s' "$fp_doc" | shasum -a 256 | cut -c1-16)"

  # --- 6. compare against the stored entry (CR-2d). ---------------------------
  local stored
  stored="$(jq -c --arg sid "$sid" '.sessions[$sid] // empty' "$STATE" 2>/dev/null)"

  if [[ -z "$stored" ]]; then
    poll_line_fresh "$sid" "new-session" "$eid" "$fp"
    return
  fi

  local entry_valid
  entry_valid="$(printf '%s' "$stored" | jq -r '
    ((.fingerprint? // null) | (type == "string" and test("^[0-9a-f]{16}$")))
    and ((.execution_id? // null) | (type == "string" and length > 0))
  ' 2>/dev/null)"
  if [[ "$entry_valid" != "true" ]]; then
    poll_line_eid "$sid" "bad-state" "$eid"
    return
  fi

  local stored_eid stored_fp
  stored_eid="$(printf '%s' "$stored" | jq -r '.execution_id')"
  stored_fp="$(printf '%s' "$stored" | jq -r '.fingerprint')"

  if [[ "$stored_eid" != "$eid" ]]; then
    poll_line_eid "$sid" "bad-state" "$eid"
    return
  fi

  if [[ "$stored_fp" != "$fp" ]]; then
    poll_line_fresh "$sid" "fp-changed" "$eid" "$fp"
    return
  fi

  skip_line "$sid" "$eid" "$fp" "$is_finished" "$is_parked" "$has_approvals" \
    "$tpath_json" "$tmux_json" "$claude_json"
}

cmd_commit() {
  local input="$1"

  mkdir -p "$(dirname "$STATE")"

  # Read ONLY session_id/execution_id/fingerprint from each entry; every other
  # key (action, reason, is_*, handles) is ignored, so a probe line can be piped
  # straight in unchanged. Validate each entry independently (two non-empty
  # strings + a ^[0-9a-f]{16}$ fingerprint); an invalid entry is REJECTED (warned
  # to stderr) and skipped — it never aborts the whole commit, since an absent
  # entry just means the next probe reads that session as `no-state` ⇒ POLL,
  # the fail-safe direction.
  # `valid` is shared by the accept-list and the reject-warning pass below, so
  # the two can never disagree on what counts as a well-formed entry.
  local jq_valid_def='
    def valid:
      ((.session_id?    // null) | (type == "string" and length > 0))
      and ((.execution_id? // null) | (type == "string" and length > 0))
      and ((.fingerprint?  // null) | (type == "string" and test("^[0-9a-f]{16}$")));
  '

  local sessions_doc
  sessions_doc="$(printf '%s' "$input" | jq -c "${jq_valid_def}"' [ .[] | select(valid) ]' 2>/dev/null)"
  if [[ $? -ne 0 ]]; then
    echo "orchestrator-delta.sh: commit input was not a well-formed JSON array" >&2
    exit 2
  fi

  # Warn (stderr) about anything rejected, without aborting.
  printf '%s' "$input" \
    | jq -r "${jq_valid_def}"' [ .[] | select(valid | not) | (.session_id // "<unknown>") ] | .[]' 2>/dev/null \
    | while IFS= read -r bad_sid; do
        echo "orchestrator-delta.sh: commit rejected an invalid entry (session_id=${bad_sid})" >&2
      done

  local new_state
  new_state="$(printf '%s' "$sessions_doc" | jq -c '
    {version: 1, sessions: (
      map({key: .session_id, value: {execution_id: .execution_id, fingerprint: .fingerprint}})
      | from_entries
    )}
  ' 2>/dev/null)"
  if [[ $? -ne 0 || -z "$new_state" ]]; then
    echo "orchestrator-delta.sh: failed to build the new state document" >&2
    exit 1
  fi

  # Atomic write: a failed write leaves the previous file intact.
  if ! printf '%s' "$new_state" > "$STATE.tmp"; then
    echo "orchestrator-delta.sh: failed to write ${STATE}.tmp" >&2
    exit 1
  fi
  mv -f "$STATE.tmp" "$STATE"
}

main() {
  # 1. jq check — FIRST, before any stdin read (CR-4: this is the hard-dependency
  #    failure the agent's fallback exists for).
  if ! command -v jq >/dev/null 2>&1; then
    echo "orchestrator-delta.sh: jq is required but was not found on PATH" >&2
    exit 3
  fi

  local sub="${1:-}"
  case "$sub" in
    probe | commit) ;;
    *)
      usage
      exit 2
      ;;
  esac

  if [[ -z "${VIBE_BACKEND_URL:-}" ]]; then
    echo "orchestrator-delta.sh: VIBE_BACKEND_URL must be set" >&2
    exit 2
  fi

  local input
  input="$(cat)" || { echo "orchestrator-delta.sh: failed to read stdin" >&2; exit 2; }

  if ! printf '%s' "$input" | jq -e 'type == "array"' >/dev/null 2>&1; then
    echo "orchestrator-delta.sh: stdin must be a JSON array" >&2
    exit 2
  fi

  case "$sub" in
    probe) cmd_probe "$input" ;;
    commit) cmd_commit "$input" ;;
  esac
}

main "$@"
