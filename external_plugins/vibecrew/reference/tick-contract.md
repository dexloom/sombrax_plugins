# The orchestrator tick contract

The wire format between VibeCrew's **host loop worker** (Swift,
`CrewOrchestrator.OrchestratorLoopWorker`) and the **orchestrator agent** (the
markdown in this plugin). Both repos cite this file; changing a literal here
means changing it in both.

Nothing in this contract is negotiated at runtime — the host composes a ping in
this shape, the agent replies ending in a `CADENCE:` line, and neither side asks
the other what it supports.

---

## 1. Who owns the loop

**The host does.** One runtime-owned worker ticks the orchestrator for every
executor.

This replaced three separate arrangements: Claude armed its own `/loop` cron
inside its session, OpenCode got a loop living in the app's UI layer (so it died
with the window), and any other executor had none. The consequences were not
cosmetic — a self-armed cron is invisible and uncontrollable from outside the
agent's own session, and a UI-scoped loop stops the moment the operator closes a
window.

Consequences for the agent:

- You never arm a timer: no `/loop`, no `CronCreate`, no `ScheduleWakeup`.
  Ticks arrive as prompts.
- In stateless tick mode (F1), each tick is a fresh process, and nothing
  survives between ticks except the `ORCH-MEMORY:` block (§3.5). That is the
  hypothesis the mode exists to test. The mode is off by default and the
  long-lived session is the incumbent; when it is off, everything in this
  contract reads exactly as it did before F1.
- You set the cadence through the `CADENCE:` line (§3), which the host obeys.
- If you were launched before this change and still hold a `/loop` cron,
  `CronDelete` it: otherwise you tick twice per interval.

## 2. The tick ping (host → agent)

Three blocks, in this order, separated by blank lines. The directives block is
**last**.

```
ORCHESTRATOR TICK (#N, interval 5m). Check the cards, close workspaces that are
done (squashed and merged), and dispatch from the DISPATCHABLE NOW block below —
that list is the host's, it is already WIP-capped and priority-ordered, and a
start outside it is refused. Ping non-active agents. Resolve anything pending a
human action per your directives. Your full method is your agent definition —
this ping never overrides it. End your report with the CADENCE line as its last
non-empty line.

ORCHESTRATOR MEMORY (yours, not the host's — these 5 lines are ALL that survives from your last tick; every other fact below is recomputed fresh):
  - <your line 1>
  … (the ask, the grammar and the cap, restated inline)

STATUS DIGEST (host-computed; advisory — the API is authoritative; absent ⇒ probe yourself):
- <CARD> [ws <id>, session <id>, run <id>, <executor>]: <status>; <output since last
  tick | no output for <M>m (<K> ticks) | no output ever (<K> ticks)>;
  input-sent-since-last-output: <yes|no>; approvals pending: <n>[; nudges: <n>/3[ — cap
  reached; do NOT nudge (the host reported it for operator review)]]

DISK LOW: <F> GB free on the data volume (warning threshold <T> GB). Ask the
assistant to check free disk space and run its disk-cleanup skill — over the
inter-agent protocol, not a paste: curl -s "$VIBECREW_URL/api/host-messages"
… (exact curl in the block)

DISPATCHABLE NOW (host-computed and ENFORCED — a start outside this list is refused 409; 2 of 3 lanes free):
- <CARD> [lane <L>, <priority|no priority>, <tier|unrouted>, <column>, opt-in: <yes|no>]: <title>
- +<N> more held by the WIP cap (not shown)

Directives enabled for this run — apply each one's behavior as defined in your
agent instructions:
- <one line per enabled directive>
```

The `ORCHESTRATOR MEMORY` block is optional and sits between the instruction
and the digest: present only in stateless tick mode
(`orchestrator.stateless_ticks = "1"`), absent in the long-lived default. It is
"what you knew last tick" and the digest is "what is true now" — the order a
fresh process needs to orient in. It is self-contained (grammar and cap
restated inline) because a fresh process has only this ping and its system
prompt. The two blocks that are acted on, `DISPATCHABLE NOW` and the
directives, keep the last slots regardless.

The `DISK LOW:` block is optional and sits between the digest and the
directives: present only when the host measures the data volume below
`orchestrator.disk_free_warning_gb` (default 20 GB; `0` disables). It carries
the exact protocol ask inline — a compacted context must be able to act on the
block alone. The agent never arms its own disk probe; absence of the block
means "not low, or not measured", not "healthy".

### The `DISPATCHABLE NOW` block (D1) — the one block that is not advisory

Everything else the host sends is a fact to act on. This block is a
**permission set**, and it is enforced: `POST /api/workspaces/start` on a card
outside it returns **409** with

```
dispatch refused: <CARD> is not dispatchable now — <reason>
```

`<reason>` is one of `at the WIP cap (<n>/<cap> running)`,
`at the waiting cap (<n>/<cap> cards awaiting review, merge or the operator) — stop for the operator`, `blocked by <SIMPLE-ID>[, …]`,
`a workspace already exists for this card (<workspace-id>)`, or
`not a wave-0 candidate — …`. There is no `force` field on that body and no
way to ask for one: a cap the agent can talk itself past is not a cap. An
operator who needs to start something at the cap uses the app's own Start
button or raises `orchestrator.max_concurrent`.

Lanes count non-archived workspaces with a live run, minus host agents,
minus cards that are `done`/`cancelled`, minus **waiting** cards: an
`inreview` card with any PR (open, or closed by a decline) and a card whose PR
merged but which is not `done` yet. Waiting agents are not developing — they
idle beside a PR for the Auditor, a merge, or the operator — so they hold no
lane. They count against the **waiting cap** instead,
`orchestrator.max_in_review`, which defaults to **twice**
`orchestrator.max_concurrent` (6 at the default 3); an explicit value wins.
That cap is the one point at which development stops for a human decision:
the block says STOP, and the host mirrors a 30-minute-deduped
`orchestrator.waiting_cap` line to Telegram.

It is **always present**, in one of four shapes — the absence of a block
means the host could not compute one (a failed read), exactly as with the
digest, and you should probe the API:

```
DISPATCHABLE NOW (host-computed and ENFORCED — …; 2 of 3 lanes free):
DISPATCHABLE NOW: none — at the WIP cap (3/3 running). Do not start anything; close or finish a card first.
DISPATCHABLE NOW: none — STOP, awaiting the operator: at the waiting cap (6/6 cards awaiting review, merge or the operator). Do not start anything; drive the PR LOOP and tell the operator the board is stopped.
DISPATCHABLE NOW: none — no unblocked wave-0 candidates (3 of 3 lanes free).
```

"Nothing to do" and "no room" are opposite facts; they never render alike.

What the host filters, and what it does not:

| Rule | Owner |
|---|---|
| Unsatisfied `blocking` edge ⇒ never listed | **host** (`ShipPlanner` waves) |
| A card with a non-archived workspace ⇒ never listed | **host** (covers running, parked, and the host agents' own home cards) |
| `orchestrator.max_concurrent` (default 3) ⇒ the list is capped to free lanes | **host** |
| Ordering: card `priority` → routing tier → `simple_id` → title | **host**, deterministic and stable |
| The `Orchestrate` opt-in | **you** — the host only annotates `opt-in: yes\|no` |
| Adopt-before-dispatch, executor resolution, prompt composition | **you** |

Your rules can only narrow this list, never widen it.

The unit of concurrency is a **workspace**, not a run: one worktree, one
agent. The four pinned host-agent homes (orchestrator, product, assistant,
auditor) do not count — the cap governs card work, not every process on the
machine. The count is taken after the tick's reconcile pass, so it is correct
across an app restart rather than counting ghosts.

Ordering is advice; membership and the cap are enforced. Starting the
second card on the list while the first waits is legal — the host will not
arbitrate a tie it computed a tick earlier. Starting a card that is not on the
list is not.

**The ping is short on purpose.** It is re-delivered every interval for the life
of a days-long run, so it must survive context compaction without depending on
anything earlier in the transcript — and it must not compete with the agent
definition it was launched under. The *method* lives in the agent file; the ping
only says "tick now, here are the facts I have, here are the flags that are on".

### The `PR LOOP` block — every PR in the review loop, with whose move it is

Rendered just before `DISPATCHABLE NOW`. The host folds each card's
first-line markers (`VC-PR-READY`, `VC-PR-UPDATED`, `PR-REVIEW-ASKED`,
`PR-REVIEW <verdict> [reason=]`, `PR-REVIEW merge-failed`, `PR-NOTIFY failed`,
`AUDIT-REQUEST`, `ORCH-ACK`) and the PR row into one row per PR on an
`inprogress`/`inreview` card (`PRLoop` in CrewKit; the same fold serves
`GET /api/cards/:id/pr-loop`):

```
PR LOOP (host-computed from the cards' marker comments; owner = whose move it is; OVERDUE = waited over 20m — nudge the owner):
  - LPRO-8 #5 state=review-asked owner=auditor round=1/3 head=93f2389 for=34m asks=1 OVERDUE
  - LPRO-9 #6 state=held owner=orchestrator round=1/3 head=abc1234 for=3m reason=checks-pending
  - LPRO-10 #7 state=held owner=orchestrator round=1/3 head=def5678 for=1m request=register-pr
```

| state | owner | meaning |
|---|---|---|
| `awaiting-ready` | dev | PR open, no `VC-PR-READY` yet |
| `awaiting-review` | orchestrator | READY/UPDATED posted, nobody asked the Auditor |
| `review-asked` | auditor | `PR-REVIEW-ASKED` posted, no verdict yet |
| `changes-requested` | dev | fixes owed, then `VC-PR-UPDATED` |
| `approved-unmerged` | auditor | `merge` verdict, PR still open |
| `merge-failed` | orchestrator | the merge did not land |
| `held` | orchestrator, or operator for `rounds-exhausted` / `operator` / an untyped hold | typed hold |
| `declined` / `closed` | operator | the Auditor declined, or the PR closed unmerged |
| `merged-unreflected` | orchestrator | merged on GitHub; the card is not `done` yet |

`round=k/limit` — `limit` is `orchestrator.pr_fix_rounds` (default 3).
`OVERDUE` marks a non-operator wait older than
`orchestrator.pr_loop_overdue_minutes` (default 20): the orchestrator's cue to
nudge that row's owner. Absent block ⇒ the host could not look; `none — …` ⇒
nothing is in the loop. The marker comments that hand the orchestrator its
move (READY, UPDATED, a verdict, `PR-NOTIFY failed`, `AUDIT-REQUEST`), a PR
status flip, a discovered PR and a merge all **wake** a parked loop, so a
round no longer waits out the idle cadence.

### The digest

Host-computed from one SQL join over non-terminal runs. Facts only — the host
never judges whether a run is stalled, only reports how long it has been quiet.

| Field | Meaning |
|---|---|
| `<CARD>` | card `simple_id`, else workspace name, else workspace id |
| `<status>` | the run row's status verbatim |
| activity | output since last tick, how long it has been silent (and for how many **delivered** ticks), or `not observed by this app session` |
| `input-sent-since-last-output` | the host already delivered input to this run since its last output |
| `approvals pending` | count of unresolved approvals on that run |
| `nudges: <n>/3` | optional, appended last: stall nudges the host has counted for this run since its last progress. Omitted at 0, so every other row is unchanged. At `3/3` it adds `— cap reached; do NOT nudge …`: the host has stopped nudging and reported the run (§5) |

Notes that matter:

- Advisory, never authoritative: it is a snapshot taken while composing the
  ping. Act on the API.
- An absent digest means the host could not look, not that nothing is
  running. Probe yourself.
- `- (no non-terminal runs)` **is** a digest: it means nothing is running.
- The orchestrator's own session is excluded — it is not a card being driven.
- Silent-tick counts increment only on **delivered** ticks. A tick the host
  skipped (agent mid-turn) is not the agent's silence.
- `not observed by this app session (log tail lost on restart)` is not
  silence. A headed agent survives an app restart; its log drain does not, so
  its output stops reaching `run_logs` while it works normally. Such a row never
  accrues silent ticks and is never nudge-eligible; check its pane
  (`GET /api/runs/<run>/pane`) instead, which reads the screen directly.
- Capped at 30 rows, **stalest first**, with a `+N more` line. The rows that get
  cut are the ones producing output — the ones you least need told about.

### The first tick

Identical, with the digest replaced by a bootstrap line: verify the backend,
enumerate what you will be driving, record a baseline. At launch there is no
previous tick to diff against, so a digest would be a baseline dressed up as an
observation.

## 3. The `CADENCE:` line (agent → host)

The **last non-empty line** of every report:

```
CADENCE: unchanged
CADENCE: re-arm <interval>
```

- `<interval>`: `1m`–`59m` or `1h`–`23h`. Nothing else parses.
- The host clamps to `[1m, 1h]`, so a legal `re-arm 4h` becomes 1h.
- Missing or malformed ⇒ `unchanged`, and the host's own activity oracle
  decides instead. A truncated or compacted report can never stall or thrash the
  loop.
- Only the last non-empty line is read, so quoting the grammar mid-report is
  safe.

**When to emit what:**

| Situation | Line |
|---|---|
| Second consecutive tick with nothing to do | `CADENCE: re-arm 30m` |
| Work reappeared while idling at 30m | `CADENCE: re-arm 5m` |
| Backend down, or you are unsure | `CADENCE: unchanged` |

The host's fallback oracle: any fleet output since the last tick ⇒ 5m, else 30m.
Deliberately crude — you have the context to be subtle, the host does not.

This grammar is byte-compatible with vibe-kanban-indie's `vk-sweeper.md`, so an
operator who has read one has read both. That product is **out of scope** here
(different backend); the shared grammar is documentation, not a dependency.

## 3.5 The `ORCH-MEMORY:` block (agent → host)

Present only in stateless tick mode, and only in a report answering a ping that
carried an `ORCHESTRATOR MEMORY` block.

```
ORCH-MEMORY:
- <line 1>
- <line 2>
```

- **At most 5 lines, 200 characters each.** Both caps are enforced by the
  HOST, not requested of the agent: a sixth line is dropped and the drop is
  logged (`orchestrator.memory_truncated`, never deduped). The cap IS the
  hypothesis — an uncapped note is the long-lived session with extra steps, so
  an experiment that let it grow would reproduce the thing it was measuring
  against.
- Read from the last `ORCH-MEMORY:` marker in the report, so quoting the
  grammar mid-report cannot rewrite the memory — the same protection §3's
  last-non-empty-line rule gives `CADENCE:`.
- The block ends at the first line that is not a `- ` bullet; blank lines
  inside it are skipped, not terminal.
- Malformed, truncated or absent ⇒ the host keeps the previous note
  unchanged. Never destructive: a compacted report must not be able to erase
  the agent's memory.
- Ordering: the block goes before the `CADENCE:` line. `CADENCE:` is read
  as the report's last non-empty line, so a memory block placed after it would
  silently disable every cadence change.

## 4. Reaching an agent

| Situation | Call |
|---|---|
| Run is `running` **and** headed (has a tmux session) | `POST /api/runs/<run>/send-input` `{"text":"…"}` |
| Run is terminal, no completion signal | `POST /api/sessions/<session>/follow-up` `{"prompt":"…"}` |
| See what a headed agent is looking at | `GET /api/runs/<run>/pane?lines=40` |
| Get the host-composed stall nudge (§5) | `GET /api/runs/<run>/nudge` → `{text, nudges_sent, cap, cap_reached, open_items}` |
| Message a host agent (assistant, auditor, orchestrator, product) over its own protocol | `POST /api/host-messages` `{"target_kind":"…","text":"…","await_reply_seconds":0}` — 404 not launched / home gone / no session, 409 `not_ready_for_input` |

`send-input`'s status codes are the contract — branch on the code, not the prose:

| Code | Meaning | What to do |
|---|---|---|
| `200` | delivered | — |
| `404` | no such run | stop |
| `422 not_interactive` | real run, but headless | use `follow-up` |
| `410 session_gone` | was headed, tmux is gone | stop; the row is stale |
| `409 not_ready_for_input` | mid-turn or on a modal | retry later |
| `409 nudge_cap_reached` | a `VC-NUDGE:` text for a run already nudged 3 times without progress | stop; the host has reported it for operator review |

A follow-up while a run is live returns **409** from
`createFollowUpRun` — "still working, do not resume", never an error to retry
blindly.

`POST /api/workspaces/start` has one more code worth branching on:

| Code | Meaning | What to do |
|---|---|---|
| `409 dispatch refused: …` | the card is not in the `DISPATCHABLE NOW` set | don't retry this tick: read the reason, report it, and move on. A lane frees, a blocker merges, or the operator raises the cap. |

### The PR review loop (VC-ORCH-CONTRACT v9 / VC-AUDIT-CONTRACT v4)

The Auditor owns pull requests; the orchestrator owns every wait. The full
method is in the two agent definitions; the wire is:

- **Asking the Auditor:** the orchestrator posts `PR-REVIEW-ASKED #<n> @<sha7> round=<k>[ nudge=<m>]`
  on the card, then sends, with `"from":"orchestrator","queue_if_busy":true`:

  ```
  VC-PR-REVIEW: <CARD-N> card=<card_id> workspace=<workspace_id> pr=#<number> <url> head=<sha7> round=<k> internal_review=<yes|no> — review this PR against its card, then request changes, merge it, or decline it.
  ```

- **The verdict:** the Auditor posts `PR-REVIEW <merge|changes|decline|hold> #<n> @<sha7> round=<k>[ reason=<code>] — … — <PR comment url>`,
  notifies the dev agent (`VC-PR-FIX`, `VC-PR-APPROVED`, `VC-PR-HOLD`,
  `VC-PR-DECLINED`) through `card-message --from auditor --queue-if-busy`,
  and acts. A failed merge adds `PR-REVIEW merge-failed … reason=<code>`.
- **Auditor → orchestrator:** `AUDIT-REQUEST <CARD> #<n> need=<register-pr|ready-notice|nudge-dev|relaunch-dev|rebase|rerun-checks|operator> — …`,
  posted on the card and sent with `target_kind: "orchestrator"`,
  `"from":"auditor"`. The orchestrator acts and answers `ORCH-ACK <CARD> #<n> need=<need> — done|failed: …`
  on the card and to the Auditor. The operator never relays between them.
- **Holds are typed:** `checks-pending` is re-asked by the orchestrator;
  `rounds-exhausted` and `operator` are the only human stops.
- **Timeouts:** every wait has an owner and the `PR LOOP` block's `OVERDUE`
  flag; the orchestrator nudges the owner (re-ask the Auditor, re-send the fix,
  nudge or resume the dev agent), and surfaces to the operator after three.
- **No Auditor running (404):** nothing automatic. The PR waits for a human
  merge; the card holds no dev lane meanwhile.
- **`queue_if_busy`:** a mid-turn target answers `202 queued` and the host
  retries every minute until it lands (`host_message_outbox`, 6 h TTL). A
  dropped notice logs `host_message.dropped`.
- **Session close:** only after the merge, when the orchestrator deletes the
  workspace — never on PR open.

## 5. The nudge

Every nudge starts with one fixed prefix at byte 0:

```
VC-NUDGE:
```

The prefix is the only contract literal: an operator grepping a transcript
finds every nudge with one search, and the host's delivery chokepoints
recognise a nudge by it. The rest of the text is host-composed, not a literal.
Fetch it from `GET /api/runs/<run>/nudge` and send its `text` verbatim over the
channel you already use (`send-input`, or `host-messages` for a host agent).
Never compose your own.

The host composes one of two shapes from the workspace's task list (the
agent's TodoWrite checklist; Codex and Pi keep none, so they always get the
second):

```
VC-NUDGE: (nudge <n> of 3) No new output from you for a while. Your task list still has <m> open item(s):
- [in_progress] <content>
- [pending] <content>
Continue with the next open item now. If something blocks you, say exactly what it is and what you need. A reply that only reports status is read as a report, not as the task being done: after 3 nudges with no progress the host stops nudging and reports this run to the operator as stuck.
```

```
VC-NUDGE: (nudge <n> of 3) No new output from you for a while, and no open task-list items are on record for this run. State briefly what remains to be done, then continue with it. If something blocks you, say exactly what it is and what you need. A reply that only reports status is read as a report, not as the task being done: after 3 nudges with no progress the host stops nudging and reports this run to the operator as stuck.
```

Items are one line each, cut at 160 characters, at most 10 shown, then
`- +<k> more open items`.

Eligible: the digest shows no output for ≥2 delivered ticks.
Excluded (never nudge these):

- pending approvals > 0 (it is blocked on a human, not stuck),
- parked on `AWAITING OPERATOR APPROVAL` or `VK-ESCALATE:`,
- finished (terminal run with a completion report),
- no session yet,
- `not observed by this app session` — the host lost the tail, so the silence is
  its blind spot, not the agent's stall,
- `input-sent-since-last-output: yes` — you already nudged; wait for an answer.

That last field is the idempotence mechanism, and it is host-computed on
purpose: it removes any need to remember what you sent last tick, which a
compacted context cannot do reliably.

The cap, host-counted per run:

- Every `VC-NUDGE:` delivery through a host channel is counted. After 3 with no
  progress, the host refuses a fourth (`409 nudge_cap_reached`) and the digest
  row shows `nudges: 3/3 — cap reached`. Don't nudge that row.
- On the next eligible tick at the cap the host sends nothing and writes one
  stuck report for the operator (a Radar ▸ Failures row, "Agent stuck — nudges
  exhausted", and an `orchestrator.run_stuck` Logbook pulse). One report per
  stall.
- Progress resets the count. The first new output after a nudge is the agent's
  reply to it and does not reset; output after that does.
- A text-only reply to a nudge is a report of where the agent stands, not proof
  the task is done. The Done gate is unchanged.
- Known limits: the count lives in host memory, so an app restart grants up to
  3 more nudges; a terminal run's `follow-up` nudge is not counted.
- An older app without `/nudge` answers 404: report the stall and don't nudge.

Gated on the `nudge-stuck` directive. Stall reporting is core; stall nudging
is opt-in.

## 6. Directives

All four are opt-in, default off, and named in the ping's last block when
enabled. Their behavior is defined in the agent definition, not in the ping —
the ping only says which are on.

`auto-unblock` · `auto-answer-questions` · `telegram-fanout` · `nudge-stuck`

Ids are byte-identical to vibe-kanban-indie's, and are also the persistence keys
(`orchestrator.directives`).

## 7. Where each literal lives

| Literal | Owner | Consumers |
|---|---|---|
| Ping text | `CrewOrchestrator/OrchestratorTickPing.swift` | this file, the agent definitions |
| Digest row format | `CrewOrchestrator/FleetDigest.swift` | this file, the agent definitions |
| `CADENCE:` grammar | `CrewOrchestrator/CadenceDirective.swift` | this file, the agent definitions, `scripts/orchestrator.sh` |
| `VC-NUDGE:` prefix, the payload shapes, the 3-nudge cap | `CrewLaunch/StallNudge.swift` (`StallNudge.prefix`, `compose`, `cap`; re-exported as `OrchestratorNudge`) | this file, the agent definitions, `vibecrew_api.py` (`send-input --nudge`) |
| Directive ids + copy | `CrewOrchestrator/OrchestratorDirectives.swift` | the launch sheet, the agent definitions |
| `DISPATCHABLE NOW` block | `CrewOrchestrator/FleetDigest.swift` (`dispatchBlock`) | this file, the agent definitions |
| `orchestrator.max_concurrent` + the refusal reasons | `CrewPipeline/DispatchPolicy.swift` | this file, the agent definitions |
| `dispatch refused: …` message | `CrewLaunch/AgentLaunchService.swift` (`AgentLaunchError.dispatchRefused`) | this file, the agent definitions |
| `ORCH-MEMORY:` grammar + both caps | `CrewOrchestrator/OrchestratorMemoryNote.swift` | this file, the agent definitions |
| `ORCHESTRATOR MEMORY` block | `CrewOrchestrator/OrchestratorTickPing.swift` (`memoryBlock`) | this file, the agent definitions |
| `orchestrator.stateless_ticks` + the caps | `CrewOrchestrator/StatelessTickConfig.swift` | this file, `docs/configuration.md` |
| `VC-PR-REVIEW:` request + `PR-REVIEW` verdict line | `agents/orchestrator.md` / `agents/auditor.md` (this repo) | this file, both agents' twins |
| Agent method | `agents/orchestrator.md` (this repo) | vendored into the app's payload catalog |

The agent definitions in this repo are the **source of truth** for the method.
The app reads them from its **git checkout of this repo** at
`~/.vibecrew/plugins` — there is no vendored second copy and no SHA-256 pin
any more (an earlier revision of this file said there was; there isn't). What
enforces the contract instead is `CrewPluginsTests/CatalogPayloadContractTests`,
which asserts against the live checkout: every orchestrator payload carries a
`<!-- VC-ORCH-CONTRACT vN -->` marker at or above the floor the app is written
for, and the claude/opencode/codex bodies from that marker on are
byte-identical. A checkout older than the floor **skips** rather than fails —
that state is "run Sync Catalog", not a contract violation.
