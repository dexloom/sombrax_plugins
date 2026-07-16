# Reference — the per-tick report and progress digest

> Read-on-demand reference for `agents/orchestrator.md`. Read this file before composing
> the session's **first** report that has ≥1 row. Behavior is carried over verbatim from
> the pre-0.4.0 sweep logic, minus the retired `CADENCE:` handshake (you own the timer
> and re-arm the cron yourself — no machine-readable cadence line is emitted anymore).

Your report is the tick's final output to the operator. Keep it tight — this runs on a
timer.

**The report, in THIS EXACT ORDER:**

1. **The tick-mode line** — one short line: `tick: monitor` or
   `tick: sweep (<which trigger fired>)`. This is what lets the operator (and the
   acceptance tests) verify the two-mode behavior from the transcript.
2. **The progress digest** — the `Lane │ Card │ Stage` table — **only if it has ≥1 row**
   (see *The digest table*). **Emit NO code fence around it** (see *Telegram*, below).
3. **Plain lines** — each only when it actually occurred: the **quiesce** line; any
   **validate-on-read drop** line (which section/entry — *it is real news, not noise*); a
   **commit-failure / state-write-failure** line; an **unrecognized executor pin**
   warning; the **plugin-root** note; an **un-dispatchable card** notice. **These are NOT
   rows** — a failure notice must be maximally visible, never buried in a table cell.
4. **The tick-summary line** — **one** line, carrying the `(delta: N/M skipped)` and
   `(cards: N/M cached)` folds. On a **zero-row** tick this **IS** the nothing-happened
   line, e.g.
   `nothing dispatched, nothing advanced, nothing parked, no directive fired (delta: 3/3 skipped)`.
   If there **are** rows and there are **no** folds to carry, **omit this line entirely**
   — never invent content.
5. **The `cadence → …` line** — **only** on a real mode transition.

**Zero-row tick** ⇒ **no table**, plus the nothing-happened summary line (4). Any
**other** mandated plain-line news (3) **still appears**.

**Backend-down tick** ⇒ **no table, no lane allocation, no state write** — exactly
**one** line, byte-for-byte unchanged:
`backend down (Failed to connect to VK API) — tick aborted, nothing changed`.
**The backend-down short-circuit overrides everything here.**

## The row rule — one row per card with activity THIS tick

**One row per card/workspace. NEVER two rows for one.** A row is emitted **iff ≥1 of
these fired:**

| # | Event | Stage cell leads with |
|---|---|---|
| **R1** | **dispatched** (card id/title + executor) | `dispatched → <EXECUTOR>` |
| **R2** | **column advanced** | `<old> → <new>` |
| **R3** | **park surfaced** — the **three-clause surface rule** (`reference/parks.md`; incl. clause (c)'s headed re-park and `reason: forced`) | `awaiting operator approval — <RAW park summary>` |
| **R4** | **directive action taken** (`auto-compact` / `nudge-stuck` / `auto-unblock` / `auto-answer-questions`) | the directive's existing line text **minus** its `<card/workspace>: ` prefix (the Lane/Card columns now carry it) — e.g. `context 312000 > 300000 → sent /compact`. **`auto-compact` walks EVERY non-archived workspace, so an R4 row may belong to a workspace with NO card ⇒ its `Card` cell is `—`** (see *The `Card` cell*). |
| **R5** | **agent progress** (gated below) | a 1–3 line narrative distilled from the `final_message` the POLL **already returned** |

**Several events for one card ⇒ ONE row.** Join them in the Stage cell with `; `, in
precedence order **R3 > R2 > R1 > R4 > R5**. (R5 never co-occurs — it is *defined* as
the "no other row" case.)

**Row order in the table:** by **Lane letter ascending.**

**Explicitly NOT rows** (they are not per-card events): the backend-down notice, the
quiesce line, the cadence-transition line, validate-on-read drop lines,
commit/state-write failure lines, the unrecognized-executor-pin warning, the plugin-root
note, the un-dispatchable-card notice, and the `(delta: …)` / `(cards: …)` folds. They
are **plain lines** (order items 3/4 above).

### R5 — the progress row, precisely gated

Without R5 a card that sits In Progress for hours (spec → plan → review → code, no
column change) would render **no row on any tick**, and "the operator tracks a lane
visually" fails. But R5 is also the clause that could most easily become spam or a new
API read. It fires **iff ALL of:**

1. the card is **orchestrator-managed** (`class: "managed"`); **and**
2. the delta gate returned a **trusted POLL** for its session (**the probe output passed
   its validation contract** — i.e. you are **not** on the outer fail-open path); **and**
3. the POLL's **`reason` is `fp-changed` or `new-session`** — **NOT `forced`**, and
   **not** `no-state` / `bad-state` / `bad-input` / `no-execution` / `no-transcript` /
   `probe-error` (those mean the *gate* lacked state, **not** that the *agent* moved);
   **and**
4. `get_execution` returned a **non-empty `final_message`**; **and**
5. the card produced **no other row** this tick.

**ZERO extra tool calls, ZERO new data collection.** A `POLL` means `get_execution` is
being called **anyway**. R5 only reads a value **already in hand**.

**`SKIP` STAYS ABSOLUTELY SILENT. R5 must NEVER trigger a `get_execution` on a `SKIP`
line** — that would break the delta gate's entire purpose. A quiet session `SKIP`s ⇒ no
`final_message` ⇒ no row, tick after tick.

**`forced` is EXCLUDED here — the exact inverse of park clause (c), ON PURPOSE.** Clause
(c) **must admit** `reason: forced` because a swallowed operator gate is catastrophic
and *"a duplicate is never a loss"*. **A progress row is the opposite kind of value: it
is cosmetic narration, not a safety-critical announcement.** A missed progress row costs
nothing; and under `VIBE_DELTA_FORCE_MANAGED=1` every session POLLs every tick, so
admitting `forced` would re-render **every managed card, every tick, forever** — pure
spam with **no safety upside**. **The asymmetry is principled. Do not "fix" it in either
direction.**

**Accepted, bounded cost — the echo row.** The gate documents that *"a column change
costs two polls, then settles"*: the tick **after** an advance re-POLLs with a stale
digest. Under R5 that produces **one echo row** restating the same narrative.
Suppressing it would require storing `final_message` — **which THE CONSTRAINED-TOKENS
INVARIANT forbids.** ⇒ **One cosmetic echo row per column advance. Do not engineer it
away.**

**The cadence classifier is UNCHANGED, and a progress row does NOT make a tick ACTIVE.**
"Zero rows" is a **rendering** predicate; **EMPTY** is a **cadence** predicate (*Classify
each tick* in `agents/orchestrator.md`). They are **different things**, and a tick may
legitimately be cadence-**EMPTY** *with* a table (an agent grinding away mid-pipeline).
**Conflating them would make every tick with a working agent ACTIVE and silently disable
idle mode.**

## The digest table

**Fixed widths (NORMATIVE):** `Lane` content **6**, `Card` content **9**, `Stage`
content **75**. Each cell renders as `│` + one space + content + one space, so **every
table line YOU AUTHOR is exactly 100 display columns.**

> **The ONE exemption — the RAW park summary (R3).** It is verbatim agent text and
> **must never be altered, truncated, or re-worded.** If it contains a glyph whose
> display width you cannot measure, **render the row anyway** (padding by character
> count) and **accept a ragged right border on THAT row.** **Content outranks alignment,
> always.** Every *other* row — every line you compose yourself — is exactly 100 columns.

### The `Card` cell — always identified, never free text

- **The card's `simple_id`** (e.g. `VIBE-17`) when the workspace **has** a linked card.
  Short ASCII, well inside 9 columns.
- **When the workspace has NO linked card, the `Card` cell is exactly `—`** — **one em
  dash, display width 1**, padded to 9. This is reachable in practice: `auto-compact`
  walks **every** non-archived workspace, so an **R4** row can belong to a card-less
  workspace.
  **NEVER a workspace name, NEVER a UUID, NEVER free text.** Those are **unbounded** —
  they would blow the fixed 9-column width and drag arbitrary Unicode into a structured
  cell, which is exactly what the glyph rule and the constrained-text discipline exist
  to prevent.
- **The row is still NEVER anonymous:** the **`Lane` cell always carries that
  workspace's lane label** (`reference/state-file.md` → *Lane labels*). **The lane
  letter identifies the workspace.**
- **The 9-column width guarantee therefore holds in BOTH cases** — a `simple_id` is
  short ASCII, and `—` is width 1.

### Geometry

**The three rule lines are LITERAL CONSTANTS. COPY THEM. Never count a dash:**

```
┌────────┬───────────┬─────────────────────────────────────────────────────────────────────────────┐
├────────┼───────────┼─────────────────────────────────────────────────────────────────────────────┤
└────────┴───────────┴─────────────────────────────────────────────────────────────────────────────┘
```

**Cell padding — the only arithmetic you do:**

- Content is **left-aligned** in data rows, **centred** in the header row.
- Pad **right** with spaces to exactly the content width.
- **DISPLAY WIDTH = (number of characters) + (1 extra for each `✅`).** `✅` (U+2705) is
  East-Asian **Wide** and occupies **2 terminal columns**, not 1. So
  `spec ✅ (554 lines)` is 18 characters but **19 columns**, and its cell takes **56**
  trailing spaces, not 57. **Pad to the DISPLAY width, never to the character count.**
- **Sanctioned glyphs in a cell: ASCII, plus `✅` (width 2) and `—` (width 1). No other
  emoji, no CJK, no combining marks.** The lane nickname is **filtered to `[A-Z0-9]`**
  and the card-less `Card` cell is **exactly `—`**, precisely so neither can ever
  violate this. **The RAW park summary (R3) is the one exemption** — see above.
- **Wrap** the Stage cell at 75 display columns onto continuation lines whose `Lane` and
  `Card` cells are **blank** (6 and 9 spaces).
- A **divider** line goes **between** rows.

**Stage narrative length.** You **author** the R1/R2/R4/R5 narratives, so **compose them
to fit ≤3 wrapped lines** (≈220 chars). The **RAW park summary (R3) is exempt**. **NEVER
drop, truncate, or re-word a report line to make it fit.**

```
┌────────┬───────────┬─────────────────────────────────────────────────────────────────────────────┐
│  Lane  │   Card    │                                    Stage                                    │
├────────┼───────────┼─────────────────────────────────────────────────────────────────────────────┤
│ VIBE A │ VIBE-2    │ Codex found a real schema/behavior mismatch — card-adjacent bug, being      │
│        │           │ folded in.                                                                  │
├────────┼───────────┼─────────────────────────────────────────────────────────────────────────────┤
│ VIBE B │ VIBE-50   │ spec ✅ (554 lines)                                                         │
└────────┴───────────┴─────────────────────────────────────────────────────────────────────────────┘
```

*(The `Lane` cell is `<NICK> <LETTER>`. A card-less workspace renders the same way but
with `—` in `Card` — see *The `Card` cell*. Note the `✅` row: 18 characters, 19
columns.)*

**Two tiers — alignment is COSMETIC, content is LOAD-BEARING:**

- **Tier 1 (default):** the box table above.
- **Tier 2 (fallback):** if **you** cannot produce a well-formed box for any reason,
  emit **compact single lines** instead — no box, no padding, no fence (the `Card` cell
  rule still applies — a card-less row shows `—`):
  ```
  Lane | Card | Stage
  VIBE A | VIBE-2 | Codex found a real schema/behavior mismatch — card-adjacent bug, being folded in.
  VIBE B | VIBE-50 | spec ✅ (554 lines)
  ```
- **NEVER Tier 0. NEVER drop, truncate, or re-word a report line in order to make a
  table align.** Content outranks alignment, always.

## Telegram — no fence, anywhere

**Emit no code fence around the table, ever.** Your report is plain text: a bare box
table (already monospace in the tmux console) + plain lines.

**Why no fence:** `channel_send`'s `format` **defaults to `'text'`**, which passes **no
`parse_mode`** — so a fence would arrive as **three literal backtick characters**. And a
rich-text mode is not safe either: the Telegram transport **re-chunks long messages at a
limit it does not expose**, so a code block can be **split across chunks**, leaving
every fragment unparseable and **dropping the entire report with no error anywhere**.
Emitting no fence **eliminates that MarkdownV2 parse-failure loss mode** outright.

**What is NOT fixed — state it plainly, and do not overclaim.** **Telegram delivery and
chunking remain best-effort and unobservable**: the listener still chunks at a
configured limit and stops on a failed chunk, and the send is **unacknowledged**.
**Plain text is strictly SAFER, not SAFE.** **The console report is the source of
truth.**

**Cosmetic cost:** on a mobile client with a proportional font the box table may render
**ragged**. That is **accepted** — it is exactly aligned in the tmux console, the
operator's primary surface.
