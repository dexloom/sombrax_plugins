# CLAUDE.md — vibecrew pipeline conventions

This file is the **single source of truth** for how the **vibecrew** plugin
interprets a card's pipeline: the byte-exact strings VibeCrew's own New-Card UI
composes into a card description, the canonical stage ordering, VibeCrew's
run/park/delivery semantics, and the full **Wait for approval** lifecycle. It is
the reference `prompts/pipeline.md` (the coding agent that *emits* the park
marker) and `agents/orchestrator.md` / `scripts/orchestrator.prompt.md` (the
consumers that *match* it) all stay in sync with.

## Pipeline-item conventions

A card's description may carry a `## Pipeline` block delimited by
`<!-- vk:pipeline:start -->` / `<!-- vk:pipeline:end -->` (the `vk:` prefix is
kept verbatim — VibeCrew deliberately reuses vibe-kanban's marker literal).
**The block is composed by VibeCrew's own New-Card UI** (`CardPipeline.composeBlock`
over the built-in stage catalog in `Pipeline.swift`) — **not** from pipeline TOML
files (`~/.vibe-kanban/pipelines/*.toml` is a vibe-kanban-indie concept and does
not apply here). The plugin only *interprets* the block.

**Block shape:** a `## Pipeline` heading, a blank line, then one `- <promptFragment>`
bullet per ticked stage **in catalog order**, with the executor-pin line (if any)
listed **first**. The whole block is wrapped between the start/end markers.

- A card lists only the subset of stages the operator ticked, in catalog order.
- **`Orchestrate` is the orchestrator's auto-drive opt-in, not a coding-agent
  step.** When present it is listed first. It tells the orchestrator to pick the
  card up and drive it to done (dispatch + status reflection); the coding agent
  ignores it as a step and still implements + runs the other listed stages itself.
  `orchestrate` **defaults off** and is added only on an explicit "execute /
  auto-drive" ask. Only `orchestrate` matters to the orchestrator's dispatch
  decision — the other eight are coding-agent stages.

## The byte-exact strings (copied verbatim from `Pipeline.swift` lines 13–54)

**Block markers** (`CardPipeline.start` / `.end`):

```
<!-- vk:pipeline:start -->
<!-- vk:pipeline:end -->
```

**The 9 stage fragments** (id → label → exact `promptFragment`):

1. `orchestrate` — "Orchestrate (auto-drive)" — **this fragment is also the
   "Orchestrate opt-in sentence"** the orchestrator's dispatch step keys off:

   > Have the orchestrator agent pick this card up and drive it to done autonomously, running the card's pipeline stages in order — regardless of which board column the card is in (it may be started even from Todo).

2. `spec` — "Create spec":

   > Write a technical spec for this card and save it to `SPEC.md` at the repo root before implementing.

3. `plan` — "Create plan":

   > Write a step-by-step implementation plan and save it to `IMPLEMENTATION_PLAN.md` at the repo root.

4. `plan-review` — "Review plan":

   > Have the implementation plan reviewed (e.g. a codex plan review, read-only) and resolve blockers before writing code.

5. `wait-for-approval` — "Wait for approval":

   > Pause for operator approval at this point: commit the work so far, then stop and wait for the operator's decision or instructions before continuing to later stages — do not advance on your own until the operator responds.

6. `code-review` — "Review via Codex":

   > After implementing, run an independent Codex review of the card's diff (the `codex-review` skill / Codex CLI), iterating until it reports no significant findings. Address confirmed findings and re-verify before marking the card ready.

7. `update-docs` — "Update documentation":

   > Update the documentation affected by this change so the docs match what shipped, and commit it before marking the card ready.

8. `merge` — "Merge to base":

   > When the work is implemented and reviewed, merge this card's branch into the base branch.

9. `pr` — "Open pull request":

   > When the work is implemented and reviewed, open a pull request for this card against the base branch.

**The executor-pin line** (`CardPipeline.executorLine`), with `<executor>`
substituted, byte-exact including the backticks and embedded quotes:

```
- Run this card with the **<executor>** execution agent: pass `executor: "<executor>"` when starting the workspace.
```

## VibeCrew semantics

- **Park marker** — the literal `AWAITING OPERATOR APPROVAL`, emitted by a
  coding agent as the **first line of its final message** when it reaches a
  Wait-for-approval gate, followed by a one-line summary of what awaits
  decision. Consumers detect a park by matching the **case-sensitive substring**
  `AWAITING OPERATOR APPROVAL` in the run's **derived `final_message`**. A
  leading `⏸️` is optional decoration, not part of the marker. This literal is
  byte-identical between `prompts/pipeline.md` (producer) and
  `CLAUDE.md`/`agents/orchestrator.md`/`scripts/orchestrator.prompt.md`
  (consumers).
- **`final_message` derivation** — there is no `final_message` column; the
  server derives it (`FinalMessage.derive`) as the highest-`/entries/<n>`-index
  `assistant_message` text across the run's `run_logs` wire frames, returned
  **verbatim** (no trimming). `GET /api/runs/:id` surfaces it as `final_message`
  (absent when no assistant message yet). The park marker is visible precisely
  because it rides *inside* `final_message`.
- **Card status ids** (ids, not display names): `todo`, `inprogress`,
  `inreview`, `done`, `cancelled`. `card-create` defaults to `todo`.
- **Run status vocabulary:** `running` → terminal `completed` / `failed` (plus a
  `stop`ped run persisting as **`killed`**, not "stopped"). Terminal = any
  non-`running` state.
- **Parked = latest run `completed` + marker present.** The headless per-run
  agent **process exits while parked** (VibeCrew spawns each run as its own
  `claude` process; it does not idle in-session waiting). So a parked card
  looks like: latest run terminal (`completed`) **and** its `final_message`
  contains the marker.
- **Resume = `follow-up`, NEVER while the session's latest run is `running`.**
  Resume dispatches a fresh `claude --resume` process into the **same
  worktree**; a second concurrent process there corrupts the tree. The
  `follow-up` route already guards this with a **409** when a run is in
  progress — treat a 409 as "still working, do not resume", never as an error
  to retry blindly.
- **Env contract in every spawned agent:** `VIBECREW_URL`, `VIBECREW_CARD_ID`,
  `VIBECREW_WORKSPACE_ID`, `VIBECREW_SESSION_ID`, `VIBECREW_RUN_ID` (injected by
  the server's launcher; `VIBECREW_CARD_ID` present whenever the workspace has a
  linked card). Prompts/agents rely on these for callbacks (e.g.
  `vibecrew_api.py merge $VIBECREW_WORKSPACE_ID`) instead of re-resolving ids.

## Canonical stage ordering (Orchestrate first)

When a card lists several of these, they appear in this relative order (minus
`recall-knowledge`/`enrich-knowledge`, which this plugin does not ship —
knowledge-recall/enrich/release are deliberately deferred; see the README):

1. **Orchestrate** — opt-in; the orchestrator auto-drives the card (not an agent
   step). Listed first.
2. **spec** — `product` subagent writes `SPEC.md` at the workspace root.
3. **plan** — `planner` subagent writes `IMPLEMENTATION_PLAN.md` at the
   workspace root.
4. **plan-review** — codex reviews the plan (`codex exec --sandbox read-only …
   < /dev/null` — codex reads stdin too, so an unredirected `exec` blocks
   forever); resolve blockers.
5. **implement** — *always*; the coding agent's own core work, committed as it
   goes.
6. **code-review** — codex reviews the diff (the piped `echo "…" | codex review
   --base <base>`, whose pipe closes stdin — no redirect); address findings.
7. **Update documentation** — update the docs the change affects, before merge.
8. **Wait for approval** — an operator gate. Its slot here (just before
   merge/pr) is only its **most common** placement; unlike the other stages it
   is **freely placeable** — the card can position it wherever an operator
   sign-off is wanted (e.g. right after `plan`, or after `code-review`).
   Wherever it sits, it pauses the pipeline at that point (see below).
9. **merge / pr** — **the coding agent performs the delivery itself**,
   autonomously, and **each action is conditional on its own stage**: `merge`
   listed → it merges its branch into the base branch (and opens no PR); `pr`
   listed → it pushes the branch and opens the PR (`gh pr create`, and merges
   nothing); both listed → both, in the order the card gives them; neither
   listed → it does neither and simply reports complete. Both stages are
   default-off, and **ticking one IS the operator's authorization** — there is
   no further go to wait for and nothing to hand back. The protocol lives in
   `prompts/pipeline.md`.

**Wait for approval is the SOLE operator gate.** The operator's merge/PR
decision is made **up front**, by ticking (or not ticking) the default-off
`merge`/`pr` stage.

## Delivery-signal asymmetry (the orchestrator's Done gate)

A **PR** is durably queryable via `card-prs` (`PullRequestRecord.status`, domain
exactly `open`/`merged`/`closed`; **landed = `status == "merged"` only** —
`closed` is closed-unmerged, not landed, and stays at `inreview`), but a
**direct merge** writes **no** client-queryable record (no `merges` GET route in
`WorkspaceService+Merge.swift`) — so a merge-only card's only durable delivery
evidence is a concrete **`merge_commit: <sha>` line** in the run's completion
report (`final_message`), which `prompts/pipeline.md` is required to emit after
a successful direct merge. A completion report **without** that line — a bare
"done"/"merged into base" prose claim — is **not** a delivery signal and does
**not** move the card to `done`. The orchestrator's Done gate keys off exactly
these two signals (a merged PR, or a SHA-bearing report), and nothing weaker.

## "Update documentation" — how it is done

- **When.** After the change is implemented (and code-reviewed, if that stage
  ran), before merge.
- **What docs.** The documentation the change *actually* affects — at minimum
  the repo/plugin's own docs that describe the changed behavior: the relevant
  `README.md`(s), this `CLAUDE.md`, the prompt/agent docs (`prompts/`,
  `agents/`), or the module docs the change touches. Update docs to reflect
  **what shipped**, not speculative or aspirational docs.
- **Convention.** Keep the docs consistent with the code/markdown as shipped,
  and **commit the doc updates as part of the same pipeline run**
  (commit-as-you-go). If nothing user-visible changed and no doc is now stale,
  **say so explicitly** ("no docs needed updating") rather than silently
  skipping the stage.

## "Wait for approval" — the gate, end to end

This is the deliberate exception to the coding agent's default "do not pause
for approval between steps". The agent parks (and, being a headless per-run
process, **exits**); the orchestrator holds and surfaces; the operator decides
via a `follow-up`; a fresh process resumes.

### The park marker (single definition — keep byte-identical everywhere)

```
AWAITING OPERATOR APPROVAL
```

- The agent emits this as the **first line of its final message** when it
  reaches the gate, followed by a one-line summary of *what* is awaiting
  decision and *what the operator can say to proceed*. A leading `⏸️` is
  optional decoration and is **not** part of the marker.
- The orchestrator detects a parked agent by matching the **case-sensitive
  substring** `AWAITING OPERATOR APPROVAL` in the run's derived `final_message`.
  The marker is load-bearing, byte-identical literal referenced from
  `prompts/pipeline.md` (producer) and `agents/orchestrator.md` /
  `scripts/orchestrator.prompt.md` (consumers) — change it in one place and you
  must change it in all.

### Lifecycle

1. **Agent parks and exits.** At the gate the coding agent **commits everything
   first** (nothing is lost while parked), emits the marker + one-line summary
   as the first line of its final message, then **the process exits**. Unlike a
   session that idles waiting for a prompt, VibeCrew spawns each run as its own
   `claude` process — there is no live session to "wait" inside; the run simply
   goes terminal (`completed`) with the marker sitting in its `final_message`.
2. **Orchestrator holds.** Status reflection recognizes the marker (latest run
   terminal + marker in `final_message`) and classifies the card as **parked /
   mid-pipeline — leave the column as-is** (explicitly **not** In Review, **not**
   Done). This check runs **before** the Done / In Review checks so a parked
   summary can't be mistaken for completion. A parked agent is also excluded
   from the `nudge-stuck` directive.
3. **Orchestrator surfaces.** It emits an awaiting-approval line (`<card>:
   awaiting operator approval — <summary>`) so the operator knows a decision is
   wanted; under `telegram-fanout` it mirrors that line to the operator topic.
4. **Operator decides.** The decision/instructions are relayed to the parked
   agent as a **`follow-up`** — a **new prompt in the same session** — which
   dispatches a **fresh process** (`claude --resume`) into the same worktree.
   This is **operator-initiated**: the orchestrator **never auto-resumes or
   auto-clears** the gate. **Never `follow-up` while the session's latest run is
   `running`** — the route 409s; treat a 409 as "still working", never retry
   blindly.
5. **Agent resumes.** The new process treats the `follow-up` prompt as the
   approval decision — proceed as approved (carrying out any instructions) or
   revise as instructed — then continues the remaining pipeline stages.

## Cross-references

- `prompts/pipeline.md` — the coding-agent kickoff; defines the
  Wait-for-approval and Update-documentation stage behaviors (producer of the
  park marker, and emitter of the `merge_commit: <sha>` completion-report line).
- `agents/orchestrator.md` + `scripts/orchestrator.prompt.md` — recognize/hold/
  surface the gate (consumers of the marker); the delivery-signal Done gate;
  `nudge-stuck` exclusion; the no-auto-resume safety rule.
- `prompts/README.md` — the prompt set overview and the stage flow diagram.

## Deferred (not in this plugin)

`knowledge-recall`, `knowledge-enrich`, and `release` (present in
`vibe-kanban-indie`) are deliberately **omitted** here — see the README's
Deferred section. No `recall-knowledge` / `enrich-knowledge` stage exists in
this plugin's catalog; `Pipeline.swift`'s 9-stage catalog above is exhaustive.
