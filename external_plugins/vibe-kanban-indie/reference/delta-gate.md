# Reference — the delta gate (probe/commit contract)

> Read-on-demand reference for `agents/orchestrator.md`. Read this file before the
> session's **first** delta-gate probe; the contract below then stays in context for the
> rest of the run. Behavior is carried over verbatim from the pre-0.4.0 sweep logic.

**Why.** `get_execution` re-serializes the whole `executor_action` — the entire dispatch
prompt — every single tick. On a tick where nothing about a session has changed, it
returns the exact answer you already applied last tick. `${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator-delta.sh`
is a probe/commit gate that lets you skip that call for sessions whose observable state
provably has not moved. It is the engine of **monitor mode**: on a quiet board every
watched session `SKIP`s and the tick costs a single `Bash` call.

**Soundness + the invariant.** The column decision (*Deciding the column* in
`agents/orchestrator.md`) is a pure function of `final_message`, `pending_approvals`,
`status`/`is_finished`, and the card's PR fields
(`pull_request_count`/`latest_pr_url`/`latest_pr_status`) and column. The
gate's digest covers **all** of those **plus the transcript's content hash** (see
*Two-case coverage* below), so an unchanged digest implies an unchanged decision —
skipping is safe. **In bold, because it is the rule that outlives this feature: add an
input to the column-decision rules ⇒ add it to the fingerprint.** The state file caches
**only the fingerprint** — every fact on a `SKIP` line (`is_finished`, `is_parked`,
`has_approvals`, the headed handles) was read **this tick**, never replayed from the
cache.

**Two-case coverage.** A resume prompt (`run_session_prompt`) either mints a new
execution or reuses the live one, and the gate is sound either way:
- **Non-headed** — a follow-up **always mints a new `ExecutionProcess`**, so the
  execution-id term in the digest catches it.
- **Headed** — a follow-up is instead **injected into the live Claude TUI** and reuses the
  *same* execution row; the **transcript content hash** is what catches it — any agent
  activity, including a re-park with a byte-identical `final_message`, changes the
  transcript's bytes.

Every session is covered by one case or the other.

**Restart/compaction safety.** The gate's state is **per-session recency fingerprints in
a file** (`${VIBE_DELTA_STATE:-$HOME/.vibe-kanban/orchestrator-delta.json}`), never in
your context: `probe` reads that file, you act on the lines it returns, `commit` writes
it back. A session restart, or a compaction of your own context, therefore changes
nothing about the gate's soundness — the file, not your memory, is the source of truth.

## Phase 1 — probe

After the inventory (sweep mode) or from the retained active set (monitor mode),
**before any `get_execution`**, run the probe over the **union** (CR-6): every
orchestrator-managed card with a workspace (always) **∪** every non-archived workspace's
coding session whenever **any** of `auto-unblock` / `auto-answer-questions` /
`auto-compact` / `nudge-stuck` is enabled — a probe that only expanded for `auto-compact`
would starve the other three directives of a line to read from (see
`reference/directives.md` → "extend the tick"). In monitor mode "every non-archived
workspace" means the retained inventory from the last sweep — monitor mode never
re-fetches it. Set `"force": true` on a session's element only per the one rule in
`reference/directives.md` → `nudge-stuck` (a gate entry with **no `sessions{}` entry in
`orchestrator-state.json`**). Card fields (`column`, `pull_request_count`,
`latest_pr_url`, `latest_pr_status`) come from the freshest `list_issues` summary you
hold — in monitor mode that is the retained value from the last sweep (an externally
merged PR is therefore caught by the next sweep, not the monitor tick; the periodic
sweep backstop bounds that delay). `null` for a session with no card.

```
printf '%s' '<the JSON array>' | bash "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator-delta.sh" probe
```

Input, one element per session:

```json
[{"session_id":"f32d1e76-1111-2222-3333-444455556666","column":"In Progress","pull_request_count":0,"latest_pr_url":null,"latest_pr_status":null},
 {"session_id":"aaaabbbb-1111-2222-3333-444455556666","column":null,"pull_request_count":null,"latest_pr_url":null,"latest_pr_status":null}]
```

Output, one JSON object per line, one line per input session, in input order:

```json
{"action":"POLL","session_id":"f32d1e76-1111-2222-3333-444455556666","execution_id":"9a4c0000-0000-0000-0000-000000000001","reason":"fp-changed","fingerprint":"a1b2c3d4e5f6a7b8"}
{"action":"SKIP","session_id":"aaaabbbb-1111-2222-3333-444455556666","execution_id":"9a4c0000-0000-0000-0000-000000000002","fingerprint":"0f1e2d3c4b5a6978","is_finished":false,"is_parked":true,"has_approvals":false,"transcript_path":"/Users/sombrax/.claude/projects/-Users-x/9a4c.jsonl","tmux_session_name":"vk-9a4c0000-0000-0000-0000-000000000002","claude_session_id":"7c1f2e3d"}
```

`reason` ∈ `new-session | fp-changed | no-state | bad-state | bad-input | no-execution |
no-transcript | probe-error | forced`. A `POLL` line always carries `fingerprint` (the
digest the probe already computed, so you can commit it without re-hashing anything
yourself) — `null` exactly when the probe could not compute one. **`fingerprint: null` ⇒
commit NOTHING for that session.**

## Validate the output, then the outer fail-open — WITH its recovery path

The gate script cannot always report per-session, and a *parseable but wrong* output — a
duplicated, reordered, or malformed line — could suppress a read that had to happen.
**Check ALL of the following before trusting any of it. If ANY fails ⇒ fall back for EVERY
session you sent:**
1. exit code is **zero**;
2. stdout is parseable as **one JSON object per line**;
3. there are **exactly N lines for the N sessions you sent**, **in input order**, and each
   line's `session_id` **equals the session_id of the corresponding request** (no
   duplicates, no reordering, no omissions, no extras);
4. every line's `action` is exactly **`POLL`** or **`SKIP`**;
5. every **`SKIP`** line carries a **non-null** `execution_id`, a `fingerprint` matching
   `^[0-9a-f]{16}$`, and real booleans for `is_finished` / `is_parked` / `has_approvals`.

**The fallback (for every session you sent):** `Bash` GET
`$VIBE_BACKEND_URL/api/sessions/<session_id>/executions`, take the last `run_reason ==
"codingagent"` entry to recover the `execution_id`, then call `get_execution(execution_id)`
and decide exactly as before this gate existed. **Never infer a SKIP from a missing,
malformed, duplicated, or out-of-order line.** This fallback **is** the pre-gate code
path — it is the correct fail-open precisely because it needs nothing this gate added.

## Per line

- **`POLL`** ⇒ `get_execution(execution_id)`, decide exactly per *Deciding the column* —
  the gate does **not** change that rule. (`execution_id: null` ⇒ no coding execution
  yet; treat as before.)
- **`SKIP`** ⇒ **do not call `get_execution`.** Nothing decision-relevant changed and the
  transcript's content hash is unchanged, so the column you already set is still correct:
  leave it, **emit no report line**, and feed the line's fresh facts/handles to any enabled
  directive that wants them.

## Phase 2 — commit, after every board write

Run this **after** every `update_issue` and **after** *Adapt the cadence* — **that, and
only that, is what CR-3 protects.** It is not the last tool call of the tick: the
unified state write (`reference/state-file.md` — the tick tail) follows `commit`, as the
tick's actual last tool call. That is safe because the state write is a **pure local
file write that takes no board action** — it cannot cause a fingerprint to be committed
for a board decision that did not land, so this ordering does not touch CR-3 at all.
**THE COMMIT-FAILURE RULE: if `commit` fails, the unified state file is NOT written at
all** — report loudly and change nothing on disk (see `reference/state-file.md` → *Tick
lifecycle*).
**On a backend-down tick, `commit` does not run at all.**

```
printf '%s' '<the JSON array>' | bash "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator-delta.sh" commit
```

Input, one element per probe line you are keeping (extra keys are ignored, so a probe line
can be piped straight through):

```json
{"session_id":"aaaabbbb-1111-2222-3333-444455556666","execution_id":"9a4c0000-0000-0000-0000-000000000002","fingerprint":"0f1e2d3c4b5a6978"}
```

**Pass through, unchanged, every probe line that (a) has a non-null `fingerprint`, and (b)
either was a `SKIP`, or was a `POLL` whose `get_execution` succeeded AND whose resulting
decision was applied** (the card was already in the target column, or `update_issue`
returned success). **Omit** any session whose `get_execution` failed, or whose resulting
`update_issue` failed, or that you did not finish processing.

**Why the apply rule matters:** the column is *itself* part of the fingerprint. If you
committed a fingerprint for a decision that never landed (a failed `update_issue`, or an
aborted tick right after the read), the next tick would recompute the **same** digest —
the column never moved — and SKIP, stranding the card forever. Omitting that session
instead means the next tick reads it as `no-state` ⇒ POLL — fail-safe by construction; do
not "fix" it into always-commit.

*Expected, benign consequence:* when a column **does** move, the committed digest was
computed with the **old** column, so the next tick sees `fp-changed`, POLLs once, finds
the card already in its target column (idempotent no-op), and commits the settled digest.
**A column change costs two polls, then settles.** That is correct, not a bug.

## State file

`${VIBE_DELTA_STATE:-$HOME/.vibe-kanban/orchestrator-delta.json}` — a **sibling** of
`orchestrator-state.json` — a **separate** file, written by the gate **script**, not by
you; **not** part of the unified state:

```json
{
  "version": 1,
  "sessions": {
    "<session_id>": {
      "execution_id": "9a4c0000-0000-0000-0000-000000000002",
      "fingerprint": "0f1e2d3c4b5a6978"
    }
  }
}
```

No booleans, no handles — the cache holds fingerprints only (CR-2). Pruning is
**structural**: a session that leaves the inventory is simply never probed again, so it's
in no commit array, so it drops out of the state file on its own.

## Valve

`VIBE_DELTA_FORCE_MANAGED=1` ⇒ the gate returns `POLL … forced` for **every** session,
unconditionally — an escape hatch if the gate is ever suspected of hiding a transition.
Ships wired, off.

While it is on, **every parked card re-announces every tick** (see
`reference/parks.md` → clause (c)): with every line a `POLL`, every park is re-surfaced.
That is **the valve's documented cost, and it is strictly preferable to the alternative**
— excluding `forced` from clause (c) would make the valve **hide** a headed re-park for
as long as it stayed on, which is precisely what the valve exists to prevent.
