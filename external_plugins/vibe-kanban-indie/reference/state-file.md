# Reference — the unified state file (`orchestrator-state.json`)

> Read-on-demand reference for `agents/orchestrator.md`. Read this file before the
> session's **first** state-file read/write. Behavior is carried over verbatim from the
> pre-0.4.0 sweep logic; only the timer changed hands (you re-arm the cron yourself —
> there is no `CADENCE:` handshake anymore).

**One state file, five sections, read once and written once per tick.** This file is
the **ONE canonical definition** of its shape — every other place that touches
`cadence`, `sessions`, `parks`, `cards`, or `lanes` cross-references this file rather
than restating a partial version of it. Exactly one fenced block below defines the JSON
shape; if a second one ever appears, that is drift.

## Path

```
${VIBE_ORCH_STATE:-$HOME/.vibe-kanban/orchestrator-state.json}
```

Owned **solely by the orchestrator agent** — no script reads or writes it (the delta
gate's own state file, `orchestrator-delta.json`, is a **separate, sibling** file; see
`reference/delta-gate.md` → *State file*).

## The shape

```json
{
  "version": 1,
  "cadence": {
    "empty_streak": 0,
    "mode": "active",
    "active_interval": "5m",
    "idle_interval": "30m"
  },
  "sessions": {
    "<session_id>": {
      "last_fingerprint": "<16-hex nudge digest>",
      "no_progress_streak": 0,
      "nudged_fingerprint": null
    }
  },
  "parks": {
    "<session_id>": "<16-hex digest of (execution_id, park summary) — NEVER the summary text>"
  },
  "cards": {
    "<issue_id>": {
      "updated_at": "<the stamp of the description this class was derived from>",
      "class": "managed",
      "executor_pin": "CODEX"
    }
  },
  "lanes": {
    "<workspace_id>": "A"
  }
}
```

## Section semantics

- **`cadence`** — the adaptive loop-cadence counters: `empty_streak` (int), `mode` ∈
  `active|idle`, `active_interval` / `idle_interval` (canonical interval strings). Every
  transition rule, the canonicalization function, the reconciliation, and the
  wake-on-instruction rule live in `agents/orchestrator.md` → *Adaptive cadence*.
- **`sessions`** — the `nudge-stuck` per-session state, keyed by **coding** `session_id`:
  the two-tick trigger, the fingerprint keying, Lemma N, the exclusions, and the
  first-observation baseline (see `reference/directives.md` → `nudge-stuck`). The
  fingerprint's encoding is pinned (below).
- **`parks`** — `{ <session_id>: <16-hex park digest> }` — see `reference/parks.md`.
- **`cards`** — `{ <issue_id>: { updated_at, class, executor_pin } }` — the
  card-classification cache, see below.
- **`lanes`** — `{ <workspace_id>: "<A–Z, 1–2 letters>" }` — the per-workspace **lane letter** shown
  in the progress digest's `Lane` column, keyed by **`workspace_id`** (not issue id, not session id: a lane is
  a property of the *workspace*, and outlives any one session). **The value is ONLY the letter.** The
  human-readable nickname (`VIBE A`) is **derived fresh at render time and NEVER stored** — see *Lane labels*
  and THE CONSTRAINED-TOKENS INVARIANT.
- **`version`** — write `1`. **Readers IGNORE it entirely** and never gate behavior on
  it — a version check would turn a hand-edit into a full state wipe for zero benefit;
  the validate-on-read and fresh-start rules below already cover every corruption case,
  surgically.

## THE CONSTRAINED-TOKENS INVARIANT

> **No free-form agent text — ever — is written into `orchestrator-state.json`.** Every
> value in the file is a **constrained token**: a **hex digest**, an **ISO-8601
> timestamp**, a **UUID**, a **small integer**, a **fixed enum**, or a **canonicalized
> interval string**.

Two independent reasons this is an invariant, not a style note:

1. **Shell-quoting safety.** You have **no `Write` tool** — you persist via
   `printf '%s' '<json>' > "$FILE"`, i.e. **single-quoted shell interpolation**.
   Agent-authored text is arbitrary: a park summary reading `don't merge yet` contains a
   single quote and can **terminate the quoted string and alter the command.** This
   file is the one place agent prose could reach a state file, so this is where the
   hazard must be designed out.
2. **It matches the existing design language.** The delta gate stores "fingerprints only
   (CR-2)"; nudge stores `last_fingerprint` / `nudged_fingerprint`. Parks storing a digest
   is consistent, not novel.

**The audit table — every field of all five sections. This table IS the schema — it
governs both the write path and the read path (validate-on-read, below):**

| Value | Token class (the validation rule) |
|---|---|
| `version` | small integer — written, never read |
| `cadence.empty_streak` | non-negative small integer |
| `cadence.mode` | enum: exactly `active` or `idle` |
| `cadence.active_interval` / `idle_interval` | canonical interval — `^(([1-9]\|[1-5][0-9])m\|([1-9]\|1[0-9]\|2[0-3])h)$` |
| `sessions.<id>.last_fingerprint` | `^[0-9a-f]{16}$` |
| `sessions.<id>.nudged_fingerprint` | `^[0-9a-f]{16}$` **or `null`** |
| `sessions.<id>.no_progress_streak` | non-negative small integer |
| `parks.<session_id>` | `^[0-9a-f]{16}$` |
| `cards.<id>.updated_at` | ISO-8601 timestamp, verbatim from the API |
| `cards.<id>.class` | enum: exactly `managed` or `plain` |
| `cards.<id>.executor_pin` | a known `BaseCodingAgent` key **or `null`** |
| `lanes.<workspace_id>` | `^[A-Z]{1,2}$` — a bare letter, nothing else |
| every object key (`sessions`/`parks`/`cards`/`lanes`) | a UUID |

**Worked example — why the lane NICKNAME is not stored.** A lane label like `VIBE A` is a **project nickname**
+ a letter. The nickname is **free-form, operator/agent-authored prose** — it can contain an apostrophe, a
quote, a space, anything — and **no token class would actually constrain it.** Storing it would be exactly the
hazard this invariant exists to prevent: the state file is written with `printf '%s' '<json>'`, single-quoted,
so one apostrophe in `don't-merge-yet` terminates the quoted string and alters the command. **So only the
LETTER crosses the boundary** (`^[A-Z]{1,2}$` — shell-inert by construction: it cannot contain a quote, a
backslash, or a space). The nickname is **re-derived every tick at render time** and lives **only in your
report** — which is *model output, not a shell string*. This is the same distinction already drawn for the
park summary (*The raw summary still appears in the report*): **only the STORED value is constrained — never
the report line.**

## VALIDATE ON READ, DROP ON FAIL

The invariant above constrains what you **write**. But the file is **its own input every
tick**: a parsed-but-invalid value read back could be carried forward and re-emitted,
silently breaking the guarantee. So it is enforced on **both** ends:

> **Every value read back from `orchestrator-state.json` is re-validated against its
> token class before use** — the audit table above **is the schema**. **Any entry whose
> value fails its class is DROPPED — treated exactly as if it were absent — and the drop
> is reported.** Never carry an unvalidated value forward; never write one back.

Why DROP, not abort — **every drop is fail-safe**:

| Dropped | Consequence |
|---|---|
| a `cards` entry | one extra `get_issue` — the card is simply a cache miss |
| a `sessions` entry | that agent is a first observation ⇒ no nudge (a garbled entry can never cause a spurious one) |
| a `parks` entry | the recovery rule (`reference/parks.md`) re-surfaces the park ⇒ one duplicate announcement, never a missed one |
| a `cadence` field | the documented fresh-start default for that field ⇒ at most one idle-cadence reset |
| a `lanes` entry | that workspace re-allocates a letter this tick ⇒ **at most one cosmetic re-label**. The row is still rendered and still reported |

**Every drop degrades to more work, never to a missed event.** And the drop is
**surgical**: one bad `cards` entry costs one `get_issue` — it does **not** wipe the
other four sections. **Never crash the tick over one bad entry.**

### Pinning the nudge fingerprint's encoding

`sessions.<id>.last_fingerprint` and `nudged_fingerprint` are **16 lowercase hex chars**
(`^[0-9a-f]{16}$`), computed with the **same recipe** as the park digest
(`reference/parks.md` → `park_fingerprint`) over the nudge fingerprint's existing terms
(latest coding `execution_id` + `final_message` + the recency signal). Any **free-text**
term (i.e. `final_message`) goes in on **stdin via the safe heredoc**, never
interpolated. The fingerprint is opaque by design; the nudge logic is, and remains,
"changed ⇒ progress; unchanged ⇒ no progress", with the marker keyed on the fingerprint
**value**. Every rule in *Two-tick trigger + idempotence*, Lemma N, and *First
observation* (`reference/directives.md`) applies byte-for-byte.

### The raw summary still appears in the report

`<card/workspace>: awaiting operator approval — <summary>` is model output, not a shell
string, and it is what the operator actually needs to read. **Only the *stored* value is
digested** — never the report line.

## The `cards{}` cache — description-only facts, cache-gated

`cards{}` caches **only facts that are a pure function of the card's DESCRIPTION** (plus
the `updated_at` that description carried). Everything else — the card's **column**,
whether it **has a workspace**, its **PR fields** — is read **fresh every sweep** from
`list_issues` / `list_workspaces` and is **NEVER cached.**

- **`class: "managed" | "plain"`** — whether the description's `## Pipeline` carries the
  **Orchestrate** opt-in.
- **`executor_pin`** — the executor key pinned in the card's `## Pipeline`, else `null`.
  **It is read out of agent/operator-authored card prose, so it must be validated into a
  constrained token before it is stored — and re-validated when it is read back.** Accept
  it **only** if it matches `^[A-Z][A-Z0-9_]*$` **and** is one of the known
  `BaseCodingAgent` keys (`CLAUDE_CODE`, `CLAUDE_CODE_HEADED`, `CODEX`, `GEMINI`, `AMP`,
  `OPENCODE`, `CURSOR_AGENT`, `QWEN_CODE`, `COPILOT`, `DROID`). **Otherwise store `null`**,
  report the unrecognized pin loudly, and fall back to the config's last-used executor.
  **Never store the raw string.**

**Cache hit** ⇔ `cards[I.id]` exists (and **survived validate-on-read**) **AND**
`cards[I.id].updated_at == S.updated_at` — the **fresh** `list_issues` summary's
`updated_at` — compared by **exact string equality** (never parsed, never ordered) ⇒ use
the cached `class` / `executor_pin`; **do not call `get_issue`**.

**Cache miss** (entry absent, dropped, or the stamps differ) ⇒ `get_issue(I.id)`, derive
`class` and a **validated** `executor_pin` from the fresh description, and write
`cards[I.id] = { updated_at: <the updated_at get_issue returned>, class, executor_pin }`.
**Store `get_issue`'s `updated_at`, not the summary's** — the cached stamp must be the
stamp of the *very description that produced the cached class*.

**The cache remembers, it does not infer.** Every `class` value in `cards{}` originates
from a real `get_issue`, taken at the `updated_at` stored alongside it — the cache never
*infers* classification from the list summary; it *remembers* a classification you
genuinely read, and re-reads the moment the summary says the description could have
moved.

**A DISPATCH ALWAYS `get_issue`s the card — the cache never eliminates this.** The
classification `get_issue` is what the cache removes; the *dispatch* `get_issue` fills
`{{TASK}}` with the card's real description, so it is **never** skipped, cache hit or
not. A future reader who "optimizes" it away would dispatch a coding agent with an
**invented** prompt.

**Do NOT cache the description body itself** — it would defeat the entire token saving
and violate the constrained-tokens invariant above.

**Pruning `cards{}` — about file size, not correctness.** Drop entries for issues this
sweep's listing showed as **Done** (terminal). Drop entries for issues **not present** in
this sweep's enumeration — **but only when the sweep actually enumerated the project's
non-Done issues in full**; if the listing was partial, filtered short, paginated short,
or errored, **prune nothing** this tick. A pruned-then-reappearing card is a safe cache
miss. (Monitor-mode ticks run no listing at all ⇒ they prune nothing.)

## Lane labels (the `lanes{}` section)

`lanes{}` gives each live **workspace** a short, stable letter so the operator can track a lane visually across
ticks in the progress digest (`reference/report.md` → *The digest table*).

> **`lanes{}` stores the LETTER. The report renders `<NICK> <LETTER>`. `<NICK>` is derived fresh every tick from
> data already in hand and is NEVER persisted.** (See THE CONSTRAINED-TOKENS INVARIANT → *why the lane nickname
> is not stored*.)

**Value class:** `^[A-Z]{1,2}$`. Keyed by **`workspace_id`** (a UUID).

**Every live workspace gets a lane — INCLUDING one with no linked card.** A card-less workspace is reachable in
the digest via `auto-compact`, which walks **every** non-archived workspace. Its **`Lane` cell is what
identifies it** (its `Card` cell is `—` — see `reference/report.md` → *The `Card` cell*), so **the lane letter
is never optional and a row is never anonymous.**

### The nickname — render-time, ASCII-safe, zero extra tool calls

1. **The card's `simple_id` prefix** — everything before the final `-` (`VIBE-17` → `VIBE`), uppercased. Already
   in the `list_issues` summary the last sweep fetched, and present for every carded row by construction
   (the `Card` column **is** the `simple_id`).
2. **No card** — a workspace the workspace→card mapping resolved **no card** for: take the workspace
   **`name`** from `list_workspaces`.
3. **Neither resolves** (no card, **or** `name` is null — it is an optional field — **or** nothing survives the
   ASCII filter below): render the **letter alone**. **NEVER invent a nickname.**

> **THE NICKNAME MUST BE ASCII-SAFE — it is the ONLY free-form text that reaches the table.**
> A workspace `name` is **arbitrary Unicode**: CJK (2 columns each), emoji, combining marks and case-expanding
> characters would all **silently break the column width**, and they violate the report's own *"sanctioned
> glyphs: ASCII, plus `✅` and `—`"* rule. So: **uppercase, then KEEP ONLY `[A-Z0-9]` and DISCARD every other
> character.** If nothing survives, **fall to rung 3 (the letter alone).** **Never** let a nickname push the
> Lane cell past **6** display columns.

**Truncation:** truncate `<NICK>` so that `dw(NICK) + 1 + len(LETTER) ≤ 6` (the Lane content width), using the
**display-width function** (`reference/report.md`), **never a raw character count**. A 1-letter label allows a
4-char nick (`VIBE A` — exactly 6); a 2-letter label allows 3 (`VIB AA`).

### Allocation — deterministic, collision-free

Runs when the digest is composed: after dispatch (so a sweep tick's new workspaces get letters) and before the
table is rendered. It adds **NO tool call** — every input is already in hand.

```
INVENTORY := the freshest non-archived list_workspaces result (this tick's, on a sweep
             tick; the retained one, on a monitor tick)
STARTED   := [ workspace_id returned by each start_workspace this tick,
               in the order you started them — each one's DISPATCH ORDINAL ]

COMPLETE  := the list_workspaces call ran THIS TICK, SUCCEEDED and
             returned_count == total_count
             # list_workspaces reports BOTH counts. A short/paginated/filtered/errored
             # listing is NOT complete — and a monitor tick (no listing) is NEVER
             # complete, so monitor ticks retain every entry unchanged.

LIVE := { w.id : w ∈ INVENTORY } ∪ set(STARTED)
        \ { the "Orchestrator" standby workspace }        # a standby is not a lane

# ── 1. PRUNE — ONLY on a COMPLETE inventory. THIS BRANCH IS NORMATIVE. ───────────────
if COMPLETE:
    lanes := { w: L for (w, L) in lanes if w ∈ LIVE }     # drop workspaces that are GONE
else:
    lanes := lanes                                        # RETAIN EVERY ENTRY, UNCHANGED.
    # An incomplete inventory means "I did not SEE that workspace", NOT "it is gone".
    # Pruning here would free a LIVE workspace's letter, hand it to someone else, and
    # re-label that lane later — destroying the cross-tick stability the column exists
    # for. A stale entry is harmless (it is pruned on the next complete sweep); a
    # wrongly-pruned lane is a permanent, visible defect.
    # RETAINING IS THE FAIL-SAFE DIRECTION.

# ── 2. DEDUP GUARD (a hand-edit or partial drop could put two workspaces on one letter) ──
for each letter L held by >1 entry in lanes:
    keep the entry whose workspace_id sorts LOWEST (lexicographic UUID string order);
    DROP the others (they re-allocate below); report the drop.

# ── 3. TAKEN — every surviving letter, INCLUDING entries retained on an incomplete tick ──
taken := set of letters now in lanes

# ── 4. ALLOCATE — only for workspaces with NO entry ──────────────────────────────────
needing := [ w ∈ LIVE with no lanes entry ]     # new dispatch, dropped entry, fresh-start
                                                # file, or dedup loser

# THE TWO-KEY ORDER — this is THE allocation order, everywhere.
# A same-tick start has NO created_at (start_workspace returns only
# {workspace_id, session_id, execution_id}) and is not in this tick's inventory either:
#   key A: workspaces present in INVENTORY  → sort by (created_at ASC, workspace_id ASC)
#   key B: workspaces in STARTED only       → sort AFTER all of key A,
#                                             by (dispatch ordinal ASC, workspace_id ASC)
# TOTAL, and STABLE across ticks: next sweep those same workspaces are in the inventory
# with a real created_at AND they already hold their letter, so they are never in
# `needing` again — the ordering rule never has to reproduce itself.
for w in needing (key A first, then key B):
    L := the LOWEST label not in taken, from the sequence
         A, B, …, Z, AA, AB, …, AZ, BA, …, ZZ
    lanes[w] := L ; taken += L
```

- **Determinism.** `created_at` is returned by `list_workspaces` for every inventory-backed workspace, so **key
  A** is re-derivable fresh at **zero extra cost**. The `workspace_id` tie-break makes each key **total** even
  if two workspaces share a timestamp.
- **Collision-free within a tick** — `taken` starts from the survivors and only grows.
- **Stable across ticks** — a **live** workspace with an entry is never in `needing`, so its letter is never
  re-computed. Prune (when it runs at all) only drops workspaces that are **gone**.
- **After a validate-on-read drop** — the dropped workspace lands in `needing` and takes the **lowest free**
  letter, which **may differ from its previous letter**. That is the documented fail-safe consequence: **a
  cosmetic re-label, never a lost row and never a wrong row** (the `Card` column still identifies the card).
- **Letters ARE reused after a lane dies.** Not reusing them would exhaust `Z` within days. A freed letter is
  only handed to a **new** workspace *after* the old one left the inventory, so **two live lanes never share a
  letter, and a live lane keeps its letter for as long as its `lanes{}` entry survives** — a validate-on-read
  drop is the **one exception**, and it is a **cosmetic re-label** (above). Cross-*time* reuse is an **accepted,
  documented trade-off** — the `Card` column disambiguates.
- **Past `Z`** ⇒ two-letter labels (`AA`…`ZZ`). **Past `ZZ`** (unreachable in practice): **render `?` in the
  Lane cell, persist NO entry, and report one line.** The letter is decoration; **exhaustion must NEVER drop a
  row.**

**Fresh start** ⇒ `{}`. Every live workspace allocates fresh **in the two-key order above** ⇒ letters
come out `A`, `B`, `C`… — **the fresh-start state IS the ideal state.**

**Backend-down tick** ⇒ **no lane allocation at all** (no table, no state write).

## Tick lifecycle — read once, write once, and the ordering vs. the delta-gate `commit`

You have **no `Write` tool.** All persistence is `Bash`.

**Read — once, at tick start:**

```sh
cat "${VIBE_ORCH_STATE:-$HOME/.vibe-kanban/orchestrator-state.json}" 2>/dev/null
```

Then **validate every entry against the schema above and drop what fails.** Reading is
side-effect-free, so its position cannot violate any invariant. If the tick later aborts
backend-down, the read is simply **discarded** and nothing is written. (With retained
context you may hold the file's content across ticks instead of re-`cat`ing it every
tick — but after a compaction of your own context, or on any doubt, re-read the file:
disk, not memory, is the source of truth.)

**Write — once, at the tick tail, ATOMICALLY — THE LAST TOOL CALL OF THE TICK:**

```sh
mkdir -p "$(dirname "$F")" && printf '%s' '<json>' > "$F.tmp" && mv "$F.tmp" "$F"
```

The temp-file + `mv` is a **MUST**: unification means one torn write would reset
cadence *and* nudge *and* parks *and* cards *and* lanes together. `mv` is atomic; the
"garbled ⇒ fresh start" path below is only the backstop. (Per the invariant above,
`<json>` contains **no** agent-authored text, so the single-quoted interpolation is safe
by construction.)

**The write is a FULL REWRITE, not a merge.** The in-memory state at the end of the tick
*is* the file — which is what makes "one read + one write" literally true, and makes
pruning trivial (a pruned entry is simply not written).

**The tick tail, in order:** board work (monitor pass, and the sweep pass when
triggered) → **compose the report** → **adapt the cadence** (re-arm directly if a
transition fired) → **`commit` the delta gate** → **write `orchestrator-state.json` —
the LAST TOOL CALL OF THE TICK** → emit the report.

**The rule that decides the order:**

> **All five sections of the unified state fail SAFE when unwritten. The delta-gate `commit`, when unwritten, merely costs an extra poll. The write whose absence is harmless goes LAST.**

| Unwritten section | Cost on the next tick |
|---|---|
| `cadence` | one streak increment lost — harmless |
| `sessions` | that agent becomes a first observation ⇒ no nudge — the documented safe direction |
| `parks` | self-heals via the recovery rule ⇒ the park is announced |
| `cards` | one extra `get_issue` |
| `lanes` | letters re-allocate next tick — at most one cosmetic re-label |
| the delta gate's `commit` | the gate POLLs instead of SKIPping — an extra read |

**Why CR-3 is untouched.** `commit`'s own rule (`reference/delta-gate.md` → *Phase 2*)
only ever required `commit` **after every `update_issue`**, so a fingerprint is never
committed for a board decision that did not land. The unified state write is a **pure
local file write that takes no board action** — it cannot cause a fingerprint to be
committed for an unlanded decision. Sequencing it after `commit` does not violate CR-3
at all. `commit` must still come after all board writes and after *Adapt the cadence*;
it simply is not the final tool call.

**The crash trace that settles it:**

- **State-write-then-`commit` (the wrong order).** Crash after the state write, before
  `commit`: `parks[S]` is **recorded**, the gate is **not** committed. Next tick the gate
  POLLs (stale digest), reads `final_message`, computes the park digest, finds it
  **equals `parks[S]`** ⇒ **stays silent.** **The park is lost forever.**
- **`commit`-then-state-write (this ordering).** Crash after the commit, before the
  state write: the gate is committed (next tick SKIPs), but `parks[S]` was **never
  written** ⇒ next tick hits **SKIP + fresh `is_parked: true` + no `parks{}` entry** ⇒
  the recovery rule fires, forces one `get_execution`, and **surfaces the park.** ✓

**The recovery rule (`reference/parks.md`) is precisely what makes state-write-last
safe. They are a pair — do not implement one without the other.**

**THE COMMIT-FAILURE RULE:**

> **If the delta-gate `commit` fails, do NOT write the unified state file at all.**
> Report the failure loudly; **change nothing on disk.**

Why: a `parks{}` entry is the **suppressor**. Writing it while the gate is left **stale**
⇒ next tick POLLs ⇒ the recomputed digest **matches** ⇒ **silent forever** — the same
"state recorded before delivery" bug in a new costume. Suppressing the write makes the
two writes **jointly all-or-nothing in the safe direction**; every section self-heals
next tick exactly as the table above describes.

**If the unified state write itself fails:** report the failure loudly and do nothing
else. **NO ROLLBACK** — the next tick self-heals on every section; a rollback would be
strictly more code and strictly more ways to be wrong.

**Accepted residual (R8) — an at-most-once announcement gap that CANNOT be closed.** A
crash **between the state write and the emission of the report** still loses that one
announcement: `parks[S]` says "surfaced", but the report never reached the operator.
The ordering narrows the window to **zero tool calls**, and every crash *before* the
state write self-heals. **Do not invent a delivery-acknowledgement mechanism.**

**Backend-down tick.** A backend-down tick writes **neither** `orchestrator-state.json`
**nor** the delta gate's `commit`; it changes nothing, on disk or on the board.

## "Missing or garbled ⇒ fresh start" — per section

**Whole-file failures** (file absent, `cat` fails, content is not parseable JSON) ⇒
**every section is fresh**:

| Section | Fresh value | Consequence — always fails safe |
|---|---|---|
| `cadence` | `{ empty_streak: 0, mode: "active", idle_interval: "30m", active_interval: canonicalize(the loop's live interval) ?? "5m" }` | Costs at most one idle-cadence reset. |
| `sessions` | `{}` | Every agent becomes a first observation (streak 0, no nudge). A garbled file can never cause a spurious nudge — only a one-tick delay. |
| `parks` | `{}` | Every currently-parked card is un-surfaced ⇒ re-announced once. A garbled file can cause one duplicate announcement, never a missed one. |
| `cards` | `{}` | Every candidate/managed card is a cache miss ⇒ one `get_issue` each — exactly the pre-cache behavior. Never a wrong classification, only a slower tick. |
| `lanes` | `{}` | Every live workspace re-allocates a letter, **in the two-key allocation order** (*Lane labels*) ⇒ labels come out `A`, `B`, `C`… A garbled file costs **at most a cosmetic re-label**, never a lost or wrong row. |

**Per-section / per-entry degradation — this is validate-on-read, applied.** If the file
parses as JSON but a **section** is missing or is not an object, or an **individual
entry** fails its token class in the schema above (wrong type, missing required key, a
fingerprint that is not `^[0-9a-f]{16}$`, a non-ISO-8601 `updated_at`, an out-of-enum
`class`/`mode`, a non-canonical interval, a non-UUID key, an unknown `executor_pin`),
treat **that section (or that entry) as absent and keep the rest.** **Never discard the
whole file over one bad entry. Never crash the tick.** The drop is **surgical and
reported**, and every drop is fail-safe (see the consequences table above).

**Unknown keys** — top-level or inside an entry — are **ignored** and not written back.

**A state file written by an older plugin version simply lacks newer sections.** The
per-section rule above already covers it: a missing section is treated as absent ⇒ fresh
⇒ it degrades, it does not migrate. **Readers still IGNORE `version` entirely.**
