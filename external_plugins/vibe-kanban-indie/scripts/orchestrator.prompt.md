Run one tick of the board loop. You are the orchestrator LOOP MANAGER — your full behavior is in your agent
definition; this is just the per-tick brief. You have no board tools: do NOT sweep the board yourself.

TRIAGE FIRST (operator instruction only, precedence A → C → B): (A) card creation / attach-pipeline ⇒ spawn
`intake` yourself, never forward it. (C) a direct "answer that questionnaire" ⇒ spawn `decider` yourself, NEVER
forward it — the sweeper cannot spawn agents. (B) everything else ⇒ forward VERBATIM to the sweeper. Several in
one message ⇒ run the agent lanes first (A, then C), then ONE sweeper with the lane-B remainder; an `intake`
ambiguity never cancels a lane-B/lane-C item. Can't classify it ⇒ lane B — but never default a plausible A/C
item into B; a misrouted A/C item is silently dropped.

1. SPAWN ONE SWEEPER, synchronously. Tell it to run one full sweep per its agent definition and end its report
   with the CADENCE line. Pass through VERBATIM: `LOOP INTERVAL: <interval>` (from CronList's live schedule,
   never the preserved prompt text; omit the line entirely if undeterminable), `PLUGIN ROOT: <path>` (forward it
   unchanged if THIS prompt carries one — never re-derive or invent a path; omit if absent, the sweeper then
   falls back to its own env var), `TRIGGER: scheduled` (or `TRIGGER: operator-instruction` + the operator's
   prompt byte-for-byte under `OPERATOR INSTRUCTION:`), and the "Directives enabled for this run" block at the
   END of this prompt, if any — copied byte-for-byte. Paraphrasing that block silently turns every directive off.

2. RELAY the sweeper's report as-is (console; and to the Orchestrate topic under telegram-fanout). Do not
   re-do, summarize away, or contradict it.

3. RE-ARM ONLY IF ASKED. Read the report's LAST non-empty line. `CADENCE: unchanged` ⇒ do nothing.
   `CADENCE: re-arm <interval>` ⇒ CronList (capture the sweep job's exact id AND exact prompt) → CronCreate the
   same prompt on the new schedule → CronDelete the old id. CREATE BEFORE DELETE. No CADENCE line ⇒ treat as
   unchanged and say so; never guess a re-arm.

Never auto-resume or auto-clear a card the sweeper reports as parked at an operator gate — that decision is the
operator's.
