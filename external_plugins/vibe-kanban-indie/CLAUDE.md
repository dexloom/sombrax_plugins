# CLAUDE.md — vibe-kanban-indie pipeline conventions

This file records how the **vibe-kanban-indie** plugin interprets a card's pipeline,
the canonical ordering of pipeline items, how the **Update documentation** stage is
performed, and the full **Wait for approval** lifecycle. It is the single source of
truth for the **park marker** literal that `prompts/pipeline.md` (the coding agent that
*emits* it) and `agents/orchestrator.md` (the orchestrator that *matches* it) both
reference — they must stay in sync with the definition here.

## Pipeline-item conventions

A card's description may carry a `## Pipeline` block delimited by
`<!-- vk:pipeline:start -->` / `<!-- vk:pipeline:end -->`. vibe-kanban composes this
block from the pipeline **file** the operator picked
(`~/.vibe-kanban/pipelines/*.toml`) and the stages they ticked: a **numbered list,
already in execution order**. The coding agent **runs the listed stages in that order —
it does not select, skip, or reorder them** (its always-on implementation work is one of
those stages).

- **The block is composed by the vibe-kanban app from a pipeline file, not this repo.**
  The plugin only *interprets* it. The pipeline "brain" (which stages exist, their text,
  their order) now lives in the file, not in these prompts. This plugin still recognizes
  a stage by its **name / intent** ("Wait for approval", "Update documentation", "spec",
  …) — not an exact app-emitted string — to know *how* to run each (delegate spec →
  `product`, plan → `planner`, reviews → `codex`) and to spot the `Orchestrate` opt-in.
  If the app ever emits different canonical phrasing for a stage, the matching language
  in `pipeline.md` / `orchestrator.md` must be realigned to it; the **park marker** below
  is independent of that wording because the agent emits it.
- A card lists **only the subset of stages the operator ticked**, in the file's order
  (which follows the canonical relative order below).
- **`Orchestrate` is the orchestrator's auto-drive opt-in, not a coding-agent step.**
  When present it is listed **first**. It tells the orchestrator to pick the card up and
  drive it to done (dispatch + status reflection); the coding agent ignores it as a step
  and still implements + runs the other listed stages itself.

## Canonical stage ordering (Orchestrate first)

When a card lists several of these, they appear in this relative order:

1. **Orchestrate** — opt-in; the orchestrator auto-drives the card (not an agent step). Listed first.
2. **spec** — `product` subagent writes `SPEC.md` at the workspace root.
3. **recall-knowledge** — the coding agent invokes `knowledge-recall`: greps the project
   knowledge base and writes `PRIOR_KNOWLEDGE.md` at the workspace root for the spec/plan
   stages to build on. Read-only on the knowledge base (see below).
4. **plan** — `planner` subagent writes `IMPLEMENTATION_PLAN.md` at the workspace root.
5. **plan-review** — codex reviews the plan (`codex exec --sandbox read-only … < /dev/null` —
   codex reads stdin too, so an unredirected `exec` blocks forever); resolve blockers.
6. **implement** — *always*; the coding agent's own core work, committed as it goes.
7. **code-review** — codex reviews the diff (the piped `echo "…" | codex review --base <base>`,
   whose pipe closes stdin — no redirect); address findings.
8. **Update documentation** — update the docs the change affects (see below), before merge.
9. **enrich-knowledge** — the coding agent invokes `knowledge-enrich`: records reusable
   knowledge from what shipped into the project knowledge base (its own git repo) and
   commits it, before merge (see below).
10. **Wait for approval** — an operator gate. Its slot here (just before merge) is only
   its **most common** placement; unlike the other stages it is **freely placeable** —
   the card can position it wherever an operator sign-off is wanted (e.g. right after
   `plan` to approve the plan before coding, or after `code-review` to approve the change
   before merge). Wherever it sits, it pauses the pipeline at that point (see below).
11. **merge / pr** — **the coding agent performs the delivery itself**, autonomously, and
   **each action is conditional on its own stage**: `merge` listed → it **squash-merges** its
   branch into the base branch (and opens no PR); `pr` listed → it **pushes the branch and
   opens the PR** (`gh pr create`, and merges nothing); both listed → both, in the order the
   card gives them; **neither listed → it does neither** and simply reports complete. Both
   stages are **default-off**, and **ticking one IS the operator's authorization** — there is
   no further go to wait for and nothing to hand back. The merge rebases onto the latest
   base, **re-runs the checks**, and squashes **without checking out the base**
   (`git commit-tree` plus a **compare-and-swap** `git update-ref` — a `git checkout` of the
   base fails from a linked worktree, and an unguarded ref write would silently clobber
   another card's merge). Once the merge lands it also **restores the base branch's own
   checkout to clean** — the ref-only CAS leaves the old index behind there as staged
   residue, and step 7 of the protocol removes it with a guarded `reset --hard HEAD`
   (only when the checkout holds nothing but that residue; the pre-merge tip stays
   recoverable via the reflog, so the residue is no backup worth keeping). The protocol
   lives in `prompts/pipeline.md`.

The numbered list is the **default relative order** the other stages keep when several
are listed; **Wait for approval** is the one stage that may appear earlier than its slot
above, at whatever point the card places the gate.

**Wait for approval is the SOLE operator gate.** `merge` no longer stops for anything —
the operator's merge decision is made **up front**, by ticking (or not ticking) the
default-off `merge`/`pr` stage. **Wait for approval** is therefore the *only* stage that
pauses the pipeline, and it is **freely placeable**: put it immediately **before** `merge`
when a human look at the change is wanted before it lands, or right after `plan` to sign
off on the plan before any code is written.

## "Update documentation" — how it is done

- **When.** After the change is implemented (and code-reviewed, if that stage ran),
  before merge.
- **What docs.** The documentation the change *actually* affects — at minimum the
  repo/plugin's own docs that describe the changed behavior: the relevant `README.md`(s),
  this `CLAUDE.md`, the prompt/agent docs (`prompts/`, `agents/`), or the module docs the
  change touches. Update docs to reflect **what shipped**, not speculative or aspirational
  docs.
- **Convention.** Keep the docs consistent with the code/markdown as shipped, and
  **commit the doc updates as part of the same pipeline run** (commit-as-you-go). If
  nothing user-visible changed and no doc is now stale, **say so explicitly** ("no docs
  needed updating") rather than silently skipping the stage.

## "Recall prior knowledge" — how it is done

- **When.** Before the plan stage (after spec, if any). Read-only; it never blocks.
- **Where the knowledge base lives.** One per **project**, a standalone git repo at
  `~/.vibe-kanban/projects/<project_id>/knowledge/` (debug builds:
  `~/.vibe-kanban-dev/...`). It is shared and **branch-independent** — every card sees
  every recorded page immediately, with no merge required. The skill derives the home dir
  from its cwd (the `worktrees` parent) and the `project_id` from `get_context`.
- **What it does.** Greps `index.md` + page frontmatter for pages relevant to the card
  topic (title + `SPEC.md`), reads the top 3–5, and writes a token-bounded
  `PRIOR_KNOWLEDGE.md` at the **workspace root** (next to `SPEC.md`, outside every repo
  worktree, so it is never committed). The coding agent passes that workspace root to the
  `product`/`planner` subagents so the spec/plan build on it.
- **Convention.** Read-only on the knowledge base — recall never writes or commits there.
  An empty KB (first card) or unresolvable project context is a normal outcome: it writes a
  short "no prior knowledge yet" note and the pipeline continues. The method lives in
  `${CLAUDE_PLUGIN_ROOT}/skills/knowledge-recall/SKILL.md`.

## "Enrich knowledge base" — how it is done

- **When.** After implement (and code-review / update-docs, if those ran), before merge.
- **What it records.** Only **durable, cross-card** knowledge — architecture, where things
  live, non-obvious decisions, gotchas, established patterns — distilled from `SPEC.md` /
  `IMPLEMENTATION_PLAN.md` / the git diff. It **excludes** changelog, transient TODOs, and
  anything the code/docs already state. Each page carries a `summary` (≤200 chars, the grep
  payload), `sources:` (contributing card `simple_id`s), and `repos:` (the repo(s) the
  learning concerns); `index.md` keeps one self-contained line per page between
  `<!-- vk:kb:index:start -->` / `<!-- vk:kb:index:end -->` markers.
- **One project KB.** A multi-repo card still records into the single project knowledge
  base, tagging each fact's `repos:` — never per-repo knowledge bases. Prefer updating an
  existing page over creating a near-duplicate (anti-bloat).
- **Convention.** Commit **only** inside the knowledge repo
  (`git -C <kb> add -A && git -C <kb> commit`, `git init` on first use) — never mix the KB
  commit with the card's code diff. If nothing reusable emerged, **say so explicitly** ("no
  new knowledge to record") rather than writing filler. The method lives in
  `${CLAUDE_PLUGIN_ROOT}/skills/knowledge-enrich/SKILL.md`.

## "Wait for approval" — the gate, end to end

This is the deliberate exception to the coding agent's default "do not pause for approval
between steps". The agent parks; the orchestrator holds and surfaces; the operator
decides; the agent resumes.

### The park marker (single definition — keep byte-identical everywhere)

```
AWAITING OPERATOR APPROVAL
```

- The agent emits this as the **first line of its `final_message`** when it reaches the
  gate, followed by a one-line summary of *what* is awaiting decision and *what the
  operator can say to proceed*. A leading `⏸️` is optional decoration and is **not** part
  of the marker.
- The orchestrator detects a parked agent by matching the **case-sensitive substring**
  `AWAITING OPERATOR APPROVAL` in `final_message`. The marker is the load-bearing,
  byte-identical literal referenced from `prompts/pipeline.md` (producer) and
  `agents/orchestrator.md` (consumer, with the surfacing long-form in
  `reference/parks.md`); change it in one place and you must change it in all of them.
- **The marker now has a second consumer: `scripts/orchestrator-delta.sh`** (the
  orchestrator's delta-polling gate). It derives `is_parked` by testing `final_message`
  for the same case-sensitive literal, and it hashes `final_message` as one term of its
  fingerprint — so the marker living **in `final_message`** is what guarantees a park is
  never skipped: any transition into or out of the parked state changes `final_message`,
  which changes the digest, which forces a `POLL`. Moving the marker out of
  `final_message`, or changing the literal in one place only, would break the gate (a
  script that no longer recognizes the marker could `SKIP` a session that is actually
  parked, or fail to recognize the ambient park state at all).

### Lifecycle

1. **Agent parks.** At the gate the coding agent **commits everything first** (nothing is
   lost while parked), emits the marker + one-line summary in `final_message`, then
   **STOPS** — it advances no later stage on its own.
2. **Orchestrator holds.** Status reflection recognizes the marker and classifies the
   card as **parked / mid-pipeline — leave the column as-is** (explicitly **not** In
   Review, **not** Done). This check runs **before** the Done / In Review checks so a
   parked summary can't be mistaken for completion. A parked agent is also **excluded
   from the `nudge-stuck` directive** even when its `pending_approvals` is empty, so it is
   never sent "Why are you stuck".
3. **Orchestrator surfaces.** It emits an awaiting-approval line (`<card/workspace>:
   awaiting operator approval — <summary>`) so the operator knows a decision is wanted;
   under `telegram-fanout` it mirrors that line to the operator topic. Surfacing is
   **once per distinct park** — the orchestrator records each surfaced park's **fingerprint**
   (a digest of the park's `execution_id` + its summary line) in the `parks{}` section of
   its `orchestrator-state.json`, so an unchanged park is announced **once**, not once
   per tick. **A re-park is a distinct park** — including a **headed** re-park with an
   identical summary, which the orchestrator detects from the delta gate's POLL. A **newly** surfaced park **does** count the tick as **ACTIVE** for adaptive cadence (blocked work
   is work); a park already surfaced and unchanged does **not**.
4. **Operator decides.** The decision/instructions are relayed to the parked agent as a
   prompt via `run_session_prompt(session_id, <decision>)` — the same sanctioned MCP
   channel `/compact` uses (or console / Telegram). This is **operator-initiated**: the
   orchestrator **never auto-resumes or auto-clears** the gate, and `auto-unblock` (which
   only clears tool-permission approvals) must **not** be read as clearing it.
5. **Agent resumes.** On receiving the prompt the agent treats it as the approval
   decision — proceed as approved (carrying out any instructions) or revise as instructed
   — then continues the remaining pipeline stages.

## `VK-ESCALATE` — the misclassification tripwire (second park marker)

Cards routed by the **`classify-task`** skill carry a `**Routing:**` line (their
complexity tier — `trivial` / `light` / `medium` / `heavy` — and the pipeline it chose;
see `skills/classify-task/SKILL.md` and `reference/routing.md`). When **grounding
contradicts the tier** — a plan blows past its size envelope, a "trivial" fix turns out
to have a deeper root cause, an unpriced design decision appears — the coding agent
**stops instead of pushing through** and parks on the second marker:

```
VK-ESCALATE: <tier>-><proposed-tier> — <one-line evidence>
```

- **Producer:** the coding agent makes this the **first line of its `final_message`**
  (committing safe work first, same discipline as the approval gate). The `planner` /
  `coder` subagents emit the same line at the top of their *reports*; the main-loop
  agent relays it into its `final_message` rather than advancing stages.
- **Consumers:** `agents/orchestrator.md` (status reflection: hold the column, surface
  once per distinct park through the same `parks{}` store) and `reference/parks.md`
  (→ *Escalation parks*: summary = that first line verbatim; the delta-gate script does
  **not** recognize this marker, so detection is the orchestrator's own substring test
  on `final_message` — transitions still force a POLL because the gate hashes
  `final_message`).
- **Resolution is an operator/orchestrator re-route, never an auto-resume:** `attach
  <proposed pipeline> to <CARD-ID>` (routed to `intake`, idempotent block replacement),
  then resume the parked session with a "re-routed — re-read the card and continue"
  prompt, or archive the workspace so the next sweep re-dispatches fresh.
- The marker is **case-sensitive** and matched as a **first-line prefix**; keep it
  byte-identical everywhere, same discipline as the approval marker above.

## The two pipeline families, and the late-binding literals (2026-08-05)

Pipelines split into two **families by executor, never mixed**: **Claude Code**
(`CLAUDE_CODE` executor — Async Sonnet/Opus/Fable, build models Sonnet / Opus /
Fable only; files `async-claude-*.toml`) and **OpenCode** (`OPENCODE` executor —
Async OpenCode GLM, a self-drive pipeline; build models MiniMax / GLM / Kimi
only). **Quick** / **Basic** are family-neutral and carry the family's executor
pin instead. **Codex is the shared reviewer** in both families and is never a
build model. No stage, pin, or advice may name a model from the other family.
Family resolution and the per-family tier maps are `classify-task`'s job;
`merge` is now **default-on** in every deployed pipeline (squash-merge is the
default delivery; `pr` is the opt-in swap for heavy / R = 2 cards).

Three late-binding report lines ride in run output (producers: the deployed
stage prompts in `~/.vibe-kanban/pipelines/*.toml` + `prompts/pipeline.md`;
consumers: the next stages and the telemetry loop) — keep them byte-stable:

- `PLAN-FACTS: <size> KB, <n> steps, <n> files, <n> open decisions` — emitted
  when the plan is verified.
- `PLAN-GATE: plan-review skipped|running (<size> KB, <n> open decisions)` —
  the plan-review stage runs only when the plan is ≥ 40 KB, has open
  decisions, or the Routing line forces `plan-review: yes`; two-pass cap.
- `CODER-MODEL: <model> — <reason>` — the coder model bound after the plan,
  within the family (sonnet→opus step-up on blown plans; operator pin wins).

## Lanes — dependent and parallel cards

A multi-card brief files as **lanes**: one parent (epic) card, sub-cards via
`parent_issue_id`, and **`blocking` relationships** chained within a lane
(`create_issue_relationship`, direction blocker → blocked). No edge between
lanes IS the parallelism. The orchestrator's sweep gates readiness on these
edges (read via `GET /api/issue-relationships?issue_id=<id>` — **outgoing rows
only**, so blockers are discovered from the blocker side; capped at 50 cards
per sweep, holding whatever it could not verify; see `reference/sweep.md`), and
a blocker reaching a terminal column frees its dependents on the next sweep. A
blocking cycle is a filing error: surfaced, never "resolved" by dispatching one
side.

**A parent is never dispatched — that is now a rule, not a filing habit.** The
orchestrator derives the parent set from `parent_issue_id` on the rows it
already lists and refuses to start any card that has children, in any column.
Filing an epic without a pipeline block is still good practice, but it is no
longer what protects it: the board UI lets anyone drag an epic into the start
column, and the backend enforces nothing.

**The parent's column, on the other hand, IS rolled up — by the orchestrator,
because the backend still derives no status from hierarchy.** In its sweep pass
it moves each parent to the furthest rung its children's columns positively
confirm: **≥1 child in flight** (live workspace, or at/past the start-signal
column) ⇒ the **start-signal** column; **every child at review-or-better, none
still working** ⇒ the **review** column (their pipelines finished, nothing
landed — the same "complete but not merged" distinction the card-level rule
makes, one level up); **every child terminal** ⇒ the **terminal** column. The
review and terminal rungs require a **verified** child roster (`list_issues`
paged to completeness, membership corroborated via `get_issue` because a child
may sit on another board) — an unverified roster is **held and reported**, never
closed on a guess. The roll-up is **forward-only**, written **once per role**
(the `parents{}` ledger in `orchestrator-state.json`), sourced **only** from
children's columns and never from an agent's report, and it never makes a parent
dispatchable. Long form: `reference/sweep.md` → *Parent roll-up*.

## Boards are per-project, and their columns are custom

A "board" is a project row; `parent_id` nests boards under a parent project,
and a parent project still owns its own kanban. Columns live in
`project_statuses` **per project** with arbitrary names — `Todo / In Progress /
In Review / Done` is only the seeded default. Nothing in the schema flags which
column means "done", so the orchestrator resolves roles the same way the app's
own board UI does: **terminal** = hidden columns ∪ the last visible column by
`sort_order`; **start-signal** = the second visible column; everything else is
open. Read them from `/api/project-statuses?project_id=<id>`, per board, and
never hardcode a column name into a filter or a write.

A board can also carry its own **orchestrator prompt** (per project and per
sub-board, edited live in the sidebar). Read the resolved stack from
`/api/projects/<id>/orchestrator-prompt/resolve` once per sweep per board;
`source: "default"` means none is set. It ranks with the directives block —
board instructions add to behaviour, never override the safety rules.

## Cross-references

- `prompts/pipeline.md` — the coding-agent kickoff; defines the Wait-for-approval and
  Update-documentation stage behaviors (producer of the park marker).
- `agents/orchestrator.md` — recognizes/holds/surfaces the gate (consumer of the
  marker); `nudge-stuck` exclusion, status-reflection short-circuit, report +
  telegram-fanout surfacing, and the no-auto-resume safety rule. One long-running
  session that owns the timer AND the tick (monitor-first two-mode loop), routes
  card-creation to `intake` and a direct "answer that questionnaire" request to
  `decider`, and owns the unified `orchestrator-state.json` (its six sections:
  `cadence`, `sessions`, `parks`, `cards`, `lanes`, `parents` — see
  `reference/state-file.md`).
  The park-surfacing long-form lives in `reference/parks.md`.
- `scripts/orchestrator-delta.sh` — the delta-polling gate; second consumer of the marker
  (derives `is_parked` from the same literal, and hashes `final_message` into its
  fingerprint so a park transition is never invisible to it).
- `prompts/README.md` — the prompt set overview and the stage flow diagram.
