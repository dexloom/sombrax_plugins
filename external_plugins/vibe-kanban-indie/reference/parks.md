# Reference — the park store (Wait-for-approval surfacing)

> Read-on-demand reference for `agents/orchestrator.md`. Read this file the first time a
> tick meets a parked session (the park marker in a `final_message`, or `is_parked: true`
> on a gate line). Behavior is carried over verbatim from the pre-0.4.0 sweep logic. The
> park marker itself is defined **once**, in the plugin's `CLAUDE.md`: the case-sensitive
> substring `AWAITING OPERATOR APPROVAL` in the agent's `final_message`.

## The park fingerprint — a digest over (`execution_id`, summary)

**Step 1 — extract the park summary (this is the REPORT text):**

```
park_summary(final_message) :=
  1. Find the FIRST occurrence of the case-sensitive substring "AWAITING OPERATOR APPROVAL".
  2. Take the remainder of final_message after the end of that occurrence.
  3. Split it into lines; take the FIRST line whose trimmed content is non-empty; trim
     leading/trailing whitespace. That string is the PARK SUMMARY.
  4. If no such line exists, the park summary is the literal: awaiting operator approval
```

**Step 2 — digest it together with the `execution_id` (this is the STORED value):**

```
park_fingerprint(execution_id, park_summary)
  := first 16 lowercase hex chars of sha256( "<execution_id>\n<park_summary>" )
```

Matches `^[0-9a-f]{16}$` — the same shape the delta gate's fingerprints use.

**⚠ The digest ALONE is NOT a sufficient park identity.** An earlier revision claimed a
same-execution re-park **cannot happen**, on the reasoning that parking twice requires a
resume. **That claim is FALSE** — the gate's *Two-case coverage* says so itself: a
**headed** resume is *injected into the live Claude TUI and reuses the same execution
row*. So a **headed re-park with a byte-identical summary yields an identical digest** —
the gate correctly hands it to us as a POLL (its transcript hash moved), and a
digest-only comparison would **throw it away.** A permanently unannounced operator gate
is the exact catastrophe this mechanism exists to prevent — **the three-clause surface
rule below is the fix.** The digest still does the real work in clauses (a)/(b).

**Computing it safely — the summary is arbitrary agent text and MUST NOT be interpolated
into a quoted shell string.** Pass it on **stdin via a quoted heredoc** (a quoted
delimiter disables *all* expansion, so `don't merge yet` is inert):

```sh
park_fp=$(
  {
    printf '%s\n' "$EXECUTION_ID"          # a UUID — safe to interpolate
    cat <<'VK_PARK_EOF'
<the park summary, verbatim, one line>
VK_PARK_EOF
  } | shasum -a 256 | cut -c1-16
)
```

> **Delimiter-collision rule (makes the recipe total).** A quoted heredoc is still unsafe
> if the one-line summary happens to **equal the delimiter exactly** — it would terminate
> the heredoc early and what follows would be parsed as shell. **Before emitting the
> heredoc, compare the summary line against the delimiter; if they are equal, extend the
> delimiter (`VK_PARK_EOF` → `VK_PARK_EOF_2` → …) until it differs.**

`shasum` is **verified present** — use **`shasum -a 256`**; no fallback hedge needed.

**Keyed by `session_id`** (not issue id) — the park is a property of the agent's session.

**The raw summary still goes in the report line.** Only the **stored** value
(`parks[session_id]`) is a digest.

## The three-clause surface rule

**Surface the park iff ANY of:**

- **(a)** there is **no `parks[session_id]` entry** — first sight, or the state was
  lost/dropped (this is the recovery path below).
- **(b)** the computed digest **≠** `parks[session_id]` — the summary changed, **or** a
  **non-headed** re-park minted a new `execution_id`.
- **(c)** the gate returned a **trusted POLL** for this session **and** the digest
  **equals** `parks[session_id]`. Per *Two-case coverage*, an unchanged digest on a
  POLLed parked session can only be a **headed re-park with a byte-identical summary.**
  Surface it and re-record.

**Otherwise: SILENT.** The steady state is `SKIP` + unchanged digest — precisely the
every-tick spam this mechanism kills.

> **"Trusted POLL" — the exact definition (TWO conjuncts, not three):** the probe output
> **passed its validation contract** (i.e. you are **not** on the outer fail-open path)
> **AND** the line's `action` is **`POLL`**. **The `reason` is IRRELEVANT — `forced`
> COUNTS.**

**Why `forced` MUST be admitted.** An earlier revision excluded `reason == forced` from
clause (c), to stop the `VIBE_DELTA_FORCE_MANAGED=1` valve from re-announcing every
parked card every tick. **That priority was backwards, and it re-opened the permanent
swallow:**

> `parks[S] = P` exists. A **headed** session resumes and re-parks with the same summary
> in the same execution row. The valve is **on**, so every probe line is `POLL
> reason=forced`. Clause (a) is false (the entry exists), clause (b) is false (the digest
> is unchanged), and clause (c) was **excluded because the POLL was `forced`**. ⇒ **The
> park is never announced, on any tick, for as long as the valve is on.**

That is not an accepted trade-off — it is the **same permanent-swallow bug in a new
place, introduced by a debugging tool.** The valve's *entire stated purpose* is *"an
escape hatch if the gate is ever suspected of hiding a transition."* **It must never be
the thing that hides one. Do NOT "optimize" the `forced` exclusion back in.**

**The cost, stated honestly instead of engineered away:**

> While `VIBE_DELTA_FORCE_MANAGED=1` is on, **every** session POLLs **every** tick, so
> **every parked card re-announces every tick.** That is **the valve's documented cost,
> not a regression.** The valve ships **wired, off**; turning it on is a deliberate
> operator action taken *because the gate is under suspicion*, and it already forces a
> full `get_execution` for every session. **Noise under an emergency debug valve is
> acceptable; a silently-lost operator gate is not. A duplicate is never a loss.**

**The other `force` path is accounted for and is moot here:** `nudge-stuck`'s
**per-session** baseline force fires only for a session with **no `sessions{}` entry** —
which in practice means the state file was lost or dropped, in which case `parks{}` has
no entry for it either and **clause (a) fires anyway.**

**Why clause (c) is sound, at ZERO extra reads.** A parked, idle agent moves **nothing**
observable — no new execution, no transcript bytes, no approvals — so on an unforced gate
it `SKIP`s. **A POLL on a parked session therefore means the agent actually did
something**, and for a parked agent the only thing that makes it act is a **resume**. The
gate is handing us the re-park; we must not throw it away.

**Accepted false positive — a DUPLICATE, never a loss.** Three sources can produce a POLL
on an unchanged park: the valve (above), the gate's fail-safe "omit the commit for a
session whose decision did not land" path, and a change to a non-`final_message` digest
term (e.g. the card's PR fields). Each re-announces the park **once** (or, under the
valve, once per tick). **All are duplicates, never missed announcements** — they err in
exactly the direction this mechanism is built to protect.

**Accepted residual — the fail-open path.** On an outer fail-open tick (the gate script
errored or violated its output contract) there are no trustworthy probe lines, so clause
(c) cannot be evaluated and you fall back to (a)/(b) alone. A headed identical-summary
re-park landing on **that** tick is not surfaced *that tick* — but it is **not lost**: a
fail-open tick commits nothing for those sessions, so the **next healthy tick reads
`no-state`/`fp-changed` ⇒ POLL ⇒ clause (c) fires ⇒ the park is surfaced.** A **one-tick
delay, not a loss.**

Column handling is **unchanged**: a parked card is a mid-pipeline hold — **not In
Review, not Done** — and the park check still runs **FIRST**, before the Done / In
Review checks.

**Not parked** (`is_parked == false`) ⇒ **delete `parks[session_id]`**; no surface line.
(Un-parking clears the memory, so a *future* park is correctly a **distinct** park and is
announced.)

**On any surface** ⇒ set `parks[session_id] = fingerprint`, emit the report line, and,
under `telegram-fanout`, mirror it to the Orchestrate topic — and **mark the tick
ACTIVE** (*Classify each tick* in `agents/orchestrator.md`, clause 4).

## `SKIP` reasoning — why silence is safe

On a `SKIP` line you do **not** call `get_execution`, so you do not hold
`final_message` this tick. You do not need to:

> **An unchanged gate digest implies an unchanged `execution_id`, an unchanged
> `final_message`, AND a byte-identical transcript** — the gate hashes all three (CR-5).
> **Every input to the park decision is therefore provably unmoved: the digest cannot
> have changed, and no re-park — headed or not — can have occurred**, because a headed
> re-park would have moved the transcript's bytes, which would have moved the gate's
> digest, which would have produced a POLL. This is the exact analogue of nudge's
> *Lemma N*, resting on the same property.

So on a `SKIP` line whose `parks[session_id]` entry is **present**: **stay silent, carry
the entry forward untouched, call nothing.** Zero extra cost. **The transcript term is
what makes `SKIP` safe here — and its absence from the digest-only comparison is exactly
what made clause (c) necessary.**

## The recovery rule — the one hole this closes (LOAD-BEARING)

**The gap:** if `parks{}` has no entry for a session (the state file was lost, an entry
was **DROPPED by validate-on-read**, a write failed, the `commit` failed and suppressed
the write, the tick crashed before its state write, or the card was parked before this
feature shipped) while that card **is** parked *and* its gate digest is already settled,
the gate returns `SKIP`, you never read `final_message`, and **the park is never
announced — forever.** Without a rule for this, the park store would silently *swallow*
the very event it exists to surface.

> On a **`SKIP`** line with a freshly-derived **`is_parked: true`** and **no
> `parks[session_id]` entry**, call `get_execution(execution_id)` **for that one
> session** — read `final_message`, compute the park fingerprint, surface the line
> (raw summary), and record it. This is a bounded exception to "`SKIP` ⇒ no
> `get_execution`": it fires only when a park exists that has no recorded surface.

**Cost, stated accurately:** **one successful recovery per recorded park.** Once the
forced `get_execution` **and** the state write have **both** succeeded, the entry exists
and the rule never fires again for that park. **If either the read or the persistence
fails, the entry stays absent and recovery correctly retries on the next tick.** That is
the desired behavior — it is what makes the announcement *eventually* certain.

**This rule is what makes the state-write-last ordering, the commit-failure rule, AND
validate-on-read's drop of a `parks` entry safe.** They are a set. Do not implement one
without the others; do not weaken this rule into "best effort".

## The full algorithm (per managed card with a workspace)

1. Determine `is_parked`, `execution_id`, and the line kind **for this tick**:
   - **POLL** line ⇒ `execution_id` from the line; `is_parked` from
     `get_execution().final_message` (case-sensitive substring test). *(The `reason`
     does not matter — see the three-clause rule above.)*
   - **SKIP** line ⇒ `execution_id` from the line; `is_parked` from the line's own
     **freshly-derived** boolean.
   - **Outer fail-open** ⇒ no trustworthy line; `get_execution` for every session as
     the fallback dictates; treat as "no trusted-POLL signal available" (clause (c)
     unavailable — see the accepted residual above).
2. `is_parked == false` ⇒ `delete parks[session_id]`; no surface line. **Done.**
3. `is_parked == true`:
   - **SKIP** and `parks[session_id]` **present** ⇒ every digest input provably
     unchanged and **no re-park possible** ⇒ **silent**, carry the entry forward.
     **Done.**
   - **SKIP** and `parks[session_id]` **absent** ⇒ the recovery rule:
     `get_execution(execution_id)` for this one session ⇒ `final_message`.
   - **POLL** ⇒ you already have `final_message`.
   - Compute `summary = park_summary(final_message)` and
     `fp = park_fingerprint(execution_id, summary)`.
   - **Surface iff** (a) `parks[session_id]` is **absent**, **or** (b)
     `fp != parks[session_id]`, **or** (c) this was a **trusted POLL** (any `reason`,
     incl. `forced`; not fail-open) **and** `fp == parks[session_id]`.
   - On surface ⇒ report the **raw `summary`**, set `parks[session_id] = fp`, mark the
     tick **ACTIVE**.
   - Else ⇒ **silent**.

**Pruning `parks{}`:**
- **Delete** when the session's fresh `is_parked` is `false` (step 2 above — the primary
  rule; it covers both line kinds without needing `final_message`).
- **Delete** when the session is no longer in this tick's non-archived
  workspace/session inventory (workspace archived, card Done). A re-created session gets
  a fresh UUID, so it is correctly a fresh, un-surfaced park.
