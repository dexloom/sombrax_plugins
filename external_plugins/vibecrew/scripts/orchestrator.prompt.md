Run one tick of the board loop, entirely yourself — you are the orchestrator; your full behavior is
in your agent definition; this is just the per-tick brief. There is no separate per-tick worker to
spawn: you run the sweep yourself, over `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/vibecrew_api.py …`
(resolve the plugin root from `$CLAUDE_PLUGIN_ROOT`, else the `PLUGIN ROOT:` line below).

TRIAGE FIRST (operator instruction only): a direct "answer that questionnaire" ⇒ spawn `decider`
yourself and relay its report. "Create a card / spec this" ⇒ do NOT create it and do NOT spawn
anything — reply that card creation is the `product` agent's / `product-manager` skill's job.
Everything else (canonically a Wait-for-approval decision like "approve and merge") ⇒ handle it
inline yourself via `follow-up`. Then run the sweep as usual and report both.

ONE SWEEP, IN ORDER:

1. HEALTH — `vibecrew_api.py health`. Exit 3 ⇒ report "backend down — launch the VibeCrew app",
   end the tick, emit `CADENCE: unchanged`. Never move the cadence on an outage.

2. INVENTORY — `workspaces` and `cards --project-id <id>` for each project you track. `cards`
   returns every card WITH description included, so readiness is classified from this one call.

3. READY CARDS — a card is ready when its description carries the Orchestrate opt-in sentence
   (quoted verbatim in CLAUDE.md) and it sits in any non-terminal column, OR it is `inprogress`
   with no workspace. NEVER dispatch a plain `todo` card without the opt-in.

4. EXECUTOR — resolve in order: the card's executor-pin line (validate `^[A-Z][A-Z0-9_]*$`, else
   report + fall through) → `config`'s `executor_profile` → `CLAUDE_CODE`.

5. DISPATCH — adopt-before-dispatch (`workspaces --card-id <id>` first; one agent per card). Fill
   `${CLAUDE_PLUGIN_ROOT}/prompts/pipeline.md` (`{{TASK}}` = title + description, `{{BASE_BRANCH}}`
   default `main`) to a temp file, `start --card-id … --prompt-file … --executor …`, then
   `card-update <id> --status inprogress`.

6. REFLECT (forward-only; `done`/`cancelled` terminal, reported once) — parked-marker check FIRST:
   latest run terminal + `final_message` contains `AWAITING OPERATOR APPROVAL` ⇒ leave the column,
   surface one line. Then the delivery-signal gate from your agent definition: PR delivery ⇒ `done`
   ONLY on a `card-prs` PR with `status == "merged"` (`open` and `closed` both stay `inreview`);
   direct-merge delivery ⇒ `done` ONLY on a terminal completion report carrying a concrete
   `merge_commit: <sha>` line (no merge record is queryable server-side; a SHA-less prose claim
   does not qualify); else `inreview` on a terminal completion report with no qualifying delivery
   signal yet; else leave as-is.

7. DIRECTIVES — apply only the flags named in the `Directives enabled for this run:` block at the
   end of this prompt (omit entirely if absent). `auto-unblock` / `auto-answer-questions` are
   INERT today (headless runs skip permissions; nothing raises question approvals yet) — say so,
   don't fake actions. `nudge-stuck` = resume-incomplete: `follow-up` only a managed card whose
   latest run is terminal WITHOUT a completion or park signal — never a `running` run (it would
   409 anyway). `telegram-fanout` mirrors your status lines to the operator topic.

8. REPORT — one line per action taken; say so plainly when nothing happened.

9. CADENCE — emit the re-arm decision per your agent definition's adaptive 5m/30m cadence
   (create-before-delete on re-arm).

Never auto-resume or auto-clear a card you find parked at an operator gate — that decision is the
operator's, and it only ever reaches you as an explicit instruction.
