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

- **You never arm a timer.** No `/loop`, no `CronCreate`, no `ScheduleWakeup`.
  Ticks arrive as prompts.
- **You do influence the cadence** — through the `CADENCE:` line (§3), which the
  host obeys.
- If you were launched before this change and still hold a `/loop` cron,
  `CronDelete` it: otherwise you tick twice per interval.

## 2. The tick ping (host → agent)

Three blocks, in this order, separated by blank lines. The directives block is
**last**.

```
ORCHESTRATOR TICK (#N, interval 5m). Check the cards, close workspaces that are
done (squashed and merged), choose the next card for execution if there's a free
lane. Ping non-active agents. Resolve anything pending a human action per your
directives. Your full method is your agent definition — this ping never overrides
it. End your report with the CADENCE line as its last non-empty line.

STATUS DIGEST (host-computed; advisory — the API is authoritative; absent ⇒ probe yourself):
- <CARD> [ws <id>, session <id>, run <id>, <executor>]: <status>; <output since last
  tick | no output for <M>m (<K> ticks) | no output ever (<K> ticks)>;
  input-sent-since-last-output: <yes|no>; approvals pending: <n>

Directives enabled for this run — apply each one's behavior as defined in your
agent instructions:
- <one line per enabled directive>
```

**The ping is short on purpose.** It is re-delivered every interval for the life
of a days-long run, so it must survive context compaction without depending on
anything earlier in the transcript — and it must not compete with the agent
definition it was launched under. The *method* lives in the agent file; the ping
only says "tick now, here are the facts I have, here are the flags that are on".

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

Notes that matter:

- **Advisory, never authoritative.** It is a snapshot taken while composing the
  ping. Act on the API.
- **Absent digest ⇒ the host could not look**, which is *not* "nothing is
  running". Probe yourself.
- `- (no non-terminal runs)` **is** a digest: it means nothing is running.
- The orchestrator's own session is excluded — it is not a card being driven.
- Silent-tick counts increment only on **delivered** ticks. A tick the host
  skipped (agent mid-turn) is not the agent's silence.
- **`not observed by this app session (log tail lost on restart)`** is NOT
  silence. A headed agent survives an app restart; its log drain does not, so
  its output stops reaching `run_logs` while it works normally. Such a row never
  accrues silent ticks and is **never nudge-eligible** — check its pane
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
- **Missing or malformed ⇒ `unchanged`**, and the host's own activity oracle
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

## 4. Reaching an agent

| Situation | Call |
|---|---|
| Run is `running` **and** headed (has a tmux session) | `POST /api/runs/<run>/send-input` `{"text":"…"}` |
| Run is terminal, no completion signal | `POST /api/sessions/<session>/follow-up` `{"prompt":"…"}` |
| See what a headed agent is looking at | `GET /api/runs/<run>/pane?lines=40` |

`send-input`'s status codes are the contract — branch on the code, not the prose:

| Code | Meaning | What to do |
|---|---|---|
| `200` | delivered | — |
| `404` | no such run | stop |
| `422 not_interactive` | real run, but headless | use `follow-up` |
| `410 session_gone` | was headed, tmux is gone | stop; the row is stale |
| `409 not_ready_for_input` | mid-turn or on a modal | **retry later** |

A follow-up while a run is live returns **409** from
`createFollowUpRun` — "still working, do not resume", never an error to retry
blindly.

## 5. The nudge

Payload, exactly — no punctuation, no variation:

```
Why are you stuck
```

One literal so an operator grepping a transcript finds every nudge with one
search. (It previously existed in three spellings, one of which carried a `?`.)

**Eligible** = the digest shows no output for **≥2 delivered ticks**.
**Excluded** — never nudge one of these:

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

Gated on the `nudge-stuck` directive. Stall **reporting** is core; stall
**nudging** is opt-in.

## 6. Directives

All four are **opt-in**, default off, and named in the ping's last block when
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
| `Why are you stuck` | `CrewOrchestrator/OrchestratorDirectives.swift` (`OrchestratorNudge.payload`) | the agent definitions, `vibecrew_api.py` docs |
| Directive ids + copy | `CrewOrchestrator/OrchestratorDirectives.swift` | the launch sheet, the agent definitions |
| Agent method | `agents/orchestrator.md` (this repo) | vendored into the app's payload catalog |

The agent definitions in this repo are the **source of truth** for the method.
The app vendors a copy into `CrewPlugins/Resources/Plugins/payloads/` and pins
its SHA-256, so drift is a test failure rather than a surprise at runtime.
