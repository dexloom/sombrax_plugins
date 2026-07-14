# PROVENANCE — VIBE-5: orchestrator split into loop-manager + sweeper

This document records where every line of the pre-split `agents/orchestrator.md` (974 lines,
`git show HEAD~1:external_plugins/vibe-kanban-indie/agents/orchestrator.md` before this card's
commit) landed after the split, and the verification gates run against the result. See
`SPEC.md` §4 (the provenance map) and `IMPLEMENTATION_PLAN.md` (rev 7) for the authoritative
design this records against.

## Step 0 — partition proof

The 974 lines of the original `agents/orchestrator.md` were classified into 42 ranges (28
content ranges + 14 blank boundary lines). `diff` between the sorted union of all classified
line numbers and `seq 1 974` was **silent** (exact partition — every line classified exactly
once), and all 14 boundary lines printed empty (`[ ]`), confirming each range's edges land on
whitespace, not truncated content.

## Section map (destination summary)

| Lines (orig) | Class | Destination |
|---|---|---|
| 1–57 · 59–91 | rewritten frontmatter + intro | both agents — R-A |
| 93–109 | **VERBATIM — protected block 1** | `orchestrator.md` — *Arming the loop* (P5) |
| 111–136 | verbatim | `sweeper.md` — control plane / tmux / `Bash` reads / backend-down |
| 138–198 | verbatim | `sweeper.md` — sweep steps 1–8 |
| 199–205 | rewritten | `sweeper.md` — steps 9–10 — R-B |
| 206–207 | verbatim | `sweeper.md` — blank + `TodoWrite` line |
| 209–278 · 280–300 · 302–337 | verbatim | `sweeper.md` — quiesce / executor / dispatch |
| 338–340 | rewritten | `sweeper.md` — "only other exceptions" tail — R-H |
| 342–425 | verbatim | `sweeper.md` — reflecting, through the park bullet |
| 426–436 | rewritten | `sweeper.md` — Done / In Review — R-C |
| 437–462 | verbatim | `sweeper.md` — leave-as-is + guards |
| 464–492 · 493–564 | verbatim | `sweeper.md` — delta gate preamble / probe / Phase-2 heading |
| 565–566 | rewritten | `sweeper.md` — Phase-2 ordering — R-D |
| 567–622 | verbatim | `sweeper.md` — commit body / state file / valve |
| **624–657** | **REWRITTEN — ADAPTED ×6** | `orchestrator.md` — *Operator instruction: create cards* (P24) — R-L |
| 659–698 | rewritten | `sweeper.md` — cadence → CADENCE handshake — R-E |
| **700–716** | **VERBATIM — protected block 2** | `orchestrator.md` — *Changing the loop interval* (P16) |
| 718–729 | verbatim | `sweeper.md` — directives heading + example |
| 730–735 | rewritten | `sweeper.md` — "no block at all" — R-I |
| 736–758 | verbatim | `sweeper.md` — CR-6 + `auto-unblock` |
| 759–767 | rewritten | `sweeper.md` — `auto-answer-questions` inline — R-F |
| 768–948 | verbatim | `sweeper.md` — fanout / auto-compact / nudge-stuck |
| 950–951 · 958–974 | verbatim | `sweeper.md` — Safety (heading + rest) |
| 952–957 | rewritten | `sweeper.md` — Safety bullet 1 — R-J |

Nothing lands in zero destinations; only P2 (`model:`), P3 (`tools:`), and P23 (Safety) land in
two, per SPEC §4's sanctioned duplications (plus the `Read` topic-id-lookup tool, a fourth
sanctioned duplication SPEC §5.1 names explicitly).

## Three-lane operator-instruction triage (loop manager, `## Wake on instruction`)

Precedence **A → C → B**:
- **Lane A** — card creation / attach-pipeline ⇒ loop manager spawns `Agent(intake)` itself,
  per *Operator instruction: create cards* (P24, adapted). Never forwarded to the sweeper.
- **Lane C** — a direct "answer that questionnaire" request ⇒ loop manager spawns
  `Agent(decider)` itself. Never forwarded (the sweeper cannot spawn a subagent).
- **Lane B** — everything else (canonically a Wait-for-approval decision) ⇒ forwarded verbatim
  to the sweeper under `TRIGGER: operator-instruction`.

## P24 — six mandatory adaptations (orig 624–657, `## Operator instruction: create cards`)

| # | Original clause | Adaptation applied |
|---|---|---|
| 1 | "`decider` and `intake` are the only agents you spawn" | → three names: `sweeper`, `decider`, `intake` |
| 2 | "An operator instruction already sets `empty_streak = 0`…" | → lane-A/C cadence carve-out: no bookkeeping, re-arms nothing |
| 3 | "ambiguity ⇒ relay and stop" | → stop scoped to the lane-A sub-request only; lane-B/C in the same message still forwarded |
| 4 | "Your only `update_issue` remains…" | → "You have no board tools at all" |
| 5 | "(see *Adaptive loop cadence*)" | → re-pointed to *Wake on instruction (operator-instruction triage)* |
| 6 | "yours to dispatch" | → "eligible for the sweeper to dispatch" |

A byte-identical P24 would be a failure; verified by the R-L rule manifest below, not a
byte-identical diff (the block is intentionally adapted, unlike P5/P16).

## Step 7 — GATE 1: verbatim moves (9 `chk` diffs)

All nine ranges diffed byte-identical against their destination:

```
OK   138-198  (## The sweep (each loop tick) — sweeper.md)
OK   209-278  (## Quiescing the Orchestrator standby workspace — sweeper.md)
OK   280-300  (## Resolving which execution agent to start — sweeper.md)
OK   302-337  (## Starting a coding agent — sweeper.md)
OK   342-425  (## Reflecting managed-card status — sweeper.md)
OK   464-492  (## The delta gate — sweeper.md)
OK   718-729  (## Directives — sweeper.md)
OK    93-109  (### Arming the loop — orchestrator.md, P5)
OK   700-716  (### Changing the loop interval — orchestrator.md, P16)
```

624–657 (P24) is intentionally absent from this gate — it is ADAPTED, gated by R-L instead.

## Step 8 — GATE 2: duplication

`dup(sweeper, orchestrator)`, `dup(sweeper, prompt)`, `dup(orchestrator, prompt)` all clean
except one **expected, SPEC-sanctioned** overlap: the two `sombrax-telegram` MCP tool
declarations (`channel_send`, `reply`) legitimately appear in both agents' `tools:` frontmatter
(SPEC §5.1 names `tools:` as one of the sanctioned duplications; both agents genuinely need
these two tools for different purposes — the sweeper narrates/fans out during the sweep, the
loop manager relays reports and sends the welcome). This is a tool-allowlist declaration, not
duplicated rule prose.

Tool-line conservation (every tool in the original's frontmatter accounted for in `sweeper.md`
and/or `orchestrator.md`): clean, no output.

## Step 9 — GATE 3: the literal registry

Runner output: **`PASS=209 FAIL=0`** out of **209** TSV rows, **plus all 7 structural checks
pass** (R-A rows 1–5, R-C row 9, and the adaptation-1 count-equality guard) — **216/216
checks pass**.

**Resolution history — this gate previously reported a self-contradiction; it is now
resolved.** The original registry (210 TSV rows) contained a `min=0` (must-be-absent) row for
the literal `` `decider` and `intake` are the only agents ``, meant to guard against the OLD
two-agent sentence surviving adaptation 1. But R-G row 11 and R-L row 37 both *require* the
literal `**\`sweeper\`, \`decider\` and \`intake\` are the only agents you spawn**` to appear
(once in the condensed Safety section, once in P24 — cross-checked by the Step 10 acceptance
sweep's `grep -cF 'eligible for the sweeper to dispatch' … # 2 (P24 + Safety)` pattern, which
expects the parallel sentence twice). That doubly-mandated, three-name string necessarily
*contains* the substring `` `decider` and `intake` are the only agents `` as a contiguous
run, so the `min=0` row could never pass while the two required positive rows also passed — a
literal `grep -F` absence check for the old text can never succeed, because it always matches
inside the new text. No wording could satisfy both a required superset-string and a
required-absent-substring simultaneously; the fragments correctly implemented the two required
positive literals verbatim (the actual regression the guard exists to catch — a surviving
*two-agent-only* sentence that omits `sweeper` — was never present anywhere in
`orchestrator.md`).

**Fix (applied to the plan, not the fragments):** the unsatisfiable `min=0` TSV row was
removed (210 → 209 TSV rows) and replaced with a **structural, sound** count-equality check
that still fails loudly if a genuine two-agent-only sentence survives, without being
self-contradictory:
```sh
A=$(grep -c "are the only agents you spawn" agents/orchestrator.md)
B=$(grep -c '`sweeper`, `decider` and `intake` are the only agents you spawn' agents/orchestrator.md)
[ "$A" = "$B" ] && [ "$B" -ge 1 ]    # every occurrence is the 3-name form
```
Verified: `A=2 B=2` — both occurrences (Safety + P24) are the mandated 3-name form. The
fragments' *implementation* of adaptation 1 was correct throughout; only the verification
harness's check for it was unsatisfiable, and that is now fixed.

Two shell-tooling bugs were found and fixed in the verification harness (not in any
fragment/literal) while running this gate:
- `grep -c` exits 1 (not 0) when the count is genuinely zero, which trips a naive
  `$(grep -cF … || echo 0)` fallback and appends a spurious duplicate `0`, corrupting the
  integer comparison. Fixed by checking for empty output instead of nonzero exit status.
- The `chk()` helper's search pattern for the `## The sweep (each loop tick)` anchor uses
  `\(...\)`, which means *grouping* in POSIX BRE (`grep -n`, no `-E`) and therefore does not
  match the literal parentheses in the heading text. Fixed by running that one anchor lookup
  with `-E`. (The underlying content was already verified byte-identical by the whole-file
  rebuild-diff, which is `-E`/`-F` agnostic.)

Four literals were found wrapped across two physical lines across two runs (real fragment
bugs, per the plan's own predicted failure mode) and fixed by widening the wrap in the source
fragment — never by editing the literal itself:
- `and to **Done** when the merge/PR step has landed` (`01-intro.md`)
- `as a short list of flags, forwarded byte-for-byte by the loop manager` (`01-intro.md`)
- `only when their flag is present in this run's prompt` (`07-adapt-starting-tail.md`)
- `backend down (Failed to connect to VK API) — tick aborted, nothing changed` (`17-your-report.md`,
  caught by Step 10's acceptance sweep, not the Step 9 TSV registry — Step 10 requires this line
  to appear **≥ 2** times in `sweeper.md`, once in *Backend-down short-circuit* and once in *Your
  report*)

## Per-manifest counts (arithmetic check)

R-A 17 + R-B 14 + R-C 9 + R-D 6 + R-E 40 + R-F 15 + R-G 12 + R-H 5 + R-I 8 + R-J 7 + R-K 43 +
R-L 40 = **216 checks total** (209 TSV rows + 7 structural). Confirmed: `wc -l
/tmp/vk5/literals.tsv` = 209; structural checks run separately = 7 (R-A rows 1–5, R-C row 9,
adaptation-1 count-equality); 209 + 7 = 216.

## Step 11 — plugin-root injection (AC-12 fallback, now REQUIRED)

**AC-12 run A (parent, live probe) FAILED**: a spawned subagent reported `CLAUDE_PLUGIN_ROOT`
empty — not inherited from the environment. Per SPEC AC-12, a failing run A makes the
root-injection fallback **mandatory**, not conditional. `agents/sweeper.md` already resolved
the root in the correct order (env first, then a `PLUGIN ROOT: <path>` line in its spawn
prompt — see `agents/sweeper.md:119–121`) and needed **no change**. The gap was that nothing
ever put that line in the sweeper's spawn prompt. Closed in three places:

- **`scripts/orchestrator.sh`** and **`scripts/orchestrate_tg.sh`** — both already compute an
  absolute `PLUGIN_DIR` (for `--plugin-dir`) but never forwarded it into the `/loop` prompt
  body. `PLUGIN_DIR`'s resolution was moved earlier in each script (before `LOOP_BODY` is
  assembled) and a `PLUGIN ROOT: ${PLUGIN_DIR}` line is now appended to `LOOP_BODY`, placed
  **before** the opt-in directives block (which must stay LAST in the prompt — confirmed by a
  manual assembly simulation with and without a directive enabled).
- **`agents/orchestrator.md`** (*The tick*, step 1) — now forwards `PLUGIN ROOT: <path>`
  **verbatim** to the sweeper, alongside `LOOP INTERVAL:`, whenever its own spawn prompt
  carries one. Unlike `LOOP INTERVAL:` (derived from `CronList`), this is a pure pass-through:
  never rewritten, re-derived, or invented. Absent from its own prompt ⇒ forwards nothing
  extra, and the sweeper falls back to its own `$CLAUDE_PLUGIN_ROOT` env read.
- **`scripts/orchestrator.prompt.md`** — the per-tick brief's item 1 now lists `PLUGIN ROOT:
  <path>` alongside `LOOP INTERVAL:` in what the manager passes through verbatim to the
  sweeper. File stays at 28 lines (≤ 28 budget, exactly met).

Because the cron re-arm path (*Changing the loop interval*) always re-uses the **captured
exact prompt** (`CronList` → same `prompt` → `CronCreate`), the injected `PLUGIN ROOT:` line
survives every interval change untouched — it is baked into the one preserved prompt string,
not re-derived per tick.

`agents/sweeper.md`, `agents/decider.md`, `agents/intake.md`, `prompts/pipeline.md`, and
`scripts/directives-block.sh` were **not touched** (confirmed by `git diff --stat`, empty for
all five). Plugin version stays `0.2.16`.

## File sizes (final)

```
148   agents/orchestrator.md   (< 180, target ≤ 170 — met; +1 line for PLUGIN ROOT pass-through)
1032  agents/sweeper.md        (no budget — carries the whole sweep; unchanged)
28    scripts/orchestrator.prompt.md  (≤ 28 — met exactly; +1 line for PLUGIN ROOT pass-through)
```
