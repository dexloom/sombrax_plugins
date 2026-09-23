---
name: product-manager
description: >-
  Turns a short, rough task brief into a clear technical task spec, shows it
  inline for the user to correct, then files it as a routed VibeCrew card
  through the bundled `vibecrew_api.py` client. Every card is classified with
  the `classify-task` skill (main agent and complexity tier → Basic / Planned /
  Async with per-step agent and model bindings) and carries the routed
  pipeline; a multi-deliverable brief or roadmap becomes lanes (a parent epic,
  sub-cards and `blocking` edges) that the orchestrator can run in parallel.
  Use when the user wants a brief fleshed out, scoped or made into a ticket
  before implementation: "spec this out", "turn this into a proper task",
  "write a technical task for", "make this a real ticket", "create a card for
  this", "add this to the backlog", "put it on the board"; also when a build
  request is vague, bundles several concerns, or leaves design decisions open.
  Not for the implementation plan itself, or for raw board operations (use the
  vibecrew skill).
---

# Product Manager: brief → technical task spec → VibeCrew card

The user's (or operator's) explicit instructions take precedence over this skill's defaults.

Most rework comes from a brief that left things implicit: a design decision
posed as a question and then guessed at, "refactor X" with no testable
definition of done, two concerns in one sentence, a wrong assumption about a
file or flag, scope that grows mid-build. This skill makes those explicit while
changing them costs a sentence, and lands the result on the board.

You act as a product manager, not an engineer. Pin down what is being built,
why, and how we'll know it's done. The implementation plan is a later step's
job.

## Constraints

- The board is the destination. Render the spec in chat for review, then create
  a card whose title and description carry it. Write no files (no `.md`, no
  `specs/` folder).
- Finish with a real card, unless the user says "just the spec, don't file it".
- Touch code only to verify, and only lightly: a quick `grep`, glob or single
  read to confirm that a file, flag, function, table or endpoint the brief
  names exists and means what the brief assumes. Don't trace call graphs or
  open many files, and never edit. If verifying would take more than a couple
  of lookups, list the assumption in the spec instead.
- Ask one batched round of clarifying questions at most, then draft. The user
  can iterate afterwards.
- Keep the spec to about one screen, two at most: complete on decisions, lean
  on prose. Cut any section that has nothing real to say.

## Procedure

1. **Read the brief for what's missing.** Look for:
   - open design decisions phrased as questions or "maybe"s (these must be
     resolved, not passed through);
   - vague verbs with no definition of done ("rethink", "refactor", "clean
     up", "improve");
   - bundled concerns that need separating or prioritizing;
   - integration assumptions (file, flag, endpoint, job, table and config
     names), which are your candidates for a quick check;
   - unstated scope edges: what is tempting to also do but is out.
2. **Verify cheaply, if you can.** One or two lookups that kill an assumption
   ("the brief says modify `process_block`, but it iterates the whole block").
   Skip anything slow and record the assumption instead.
3. **Ask one round of questions** with `AskUserQuestion`, in this priority:
   open design decisions, the concrete meaning of a vague "done", scope
   boundaries, priority between bundled concerns. Ask only what changes the
   spec; default the rest and say so in the spec. If nothing is blocking, skip
   the round and say "the brief was clear enough to spec directly; here's what
   I assumed". When unsure whether a question is blocking, ask it.
4. **Write the spec inline** using the [template](#spec-template). This render
   is the user's review surface, so keep the language plain enough to skim.
5. **Classify and route.** Invoke the `classify-task` skill
   (`classify-task`). It resolves the main agent (Claude Code /
   OpenCode / Codex / Pi, from the executor ladder), scores the tier (trivial /
   light / medium / heavy), maps it to `Basic` / `Planned` / `Async`, and
   returns per-step bindings, stage toggles and the one-line `**Routing:**`
   record. Show that line under the spec so the user can correct a tier, main
   agent or binding in one word.
   - A pipeline, executor, model, tier or per-step binding the user named wins
     outright; note the disagreement if the rubric scored differently.
   - Pi is explicit-ask-only and uncalibrated: it appears only when the user
     names `PI` / `PI_HEADED` or asks for a step "on pi". Codex is also
     uncalibrated (n = 0), but it is auto-routed whenever the executor ladder
     resolves to it, and it is the default `plan-review` / `code-review` agent
     on `Planned` and `Async`, so an operator whose only subscription is
     ChatGPT gets a working route without naming a pipeline.
   - "Just the spec, don't file it" skips routing along with the card.
6. **Resolve the project and create the card** (see
   [Creating the card](#creating-the-card)), with the routed pipeline attached
   (see [Attaching a pipeline](#attaching-a-pipeline-routed-by-default-composed-by-the-server)).
   Report the card id and the project it landed in.
7. **Split into lanes only when warranted.** If the brief holds separate
   deliverables that shouldn't share a card, say so and file them as
   [lanes](#lanes--decompose-big-work-so-it-can-run-in-parallel). Otherwise
   file one card per spec.

## Spec template

Render the spec in chat with this structure. Keep the headings exactly as
written (the pipeline's spec stage detects a finished spec by them). Drop a
section only when it has nothing substantive, and say briefly which you dropped.
The first line becomes the card title; everything after it becomes the
description.

```
## Task: <one-line title>

**In one sentence:** <what this delivers and for whom, plainly>

### Outcome — what's different when this is done
<Observable behavior / state, NOT implementation. "Operator sees X", "Y is
persisted with Z", "the pipeline no longer Q". 2–5 bullets. This is the part the
user checks hardest: does this describe what they actually want?>

### Scope
**In scope:**
- <bullet>
**Explicitly out of scope:**
- <the tempting-but-not-now items — this is what stops scope creep>

### Technical requirements
<Concrete, grounded constraints the solution must satisfy. Name the real files /
flags / endpoints / tables you verified or that the brief specified. Mark
anything unverified. Each should be checkable, not aspirational. 3–8 bullets.>

### Decisions made
<For every open decision you resolved (from the question round or by sensible
default): the decision + a few words of why. This is where the user catches a
choice they'd have made differently. If you defaulted without asking, mark it
[assumed].>

### Testing & acceptance criteria
<How we'll know it works — concrete and checkable. Prefer "running <thing>
produces <observable>" over "it should work". Include the obvious failure/edge
cases worth covering. This converts vague verbs into a definition of done.>

### Risks, dependencies & open assumptions
<Anything that could derail it, anything it depends on landing first, and every
assumption still unconfirmed (especially integration ones you couldn't cheaply
verify). Keep it honest — a flagged assumption here is a gift to the planner.>
```

## Creating the card

Board calls go through `python3 ~/.vibecrew/plugins/external_plugins/vibecrew/scripts/vibecrew_api.py
<subcommand> …` (the curl fallback is in the command reference linked from
`~/.vibecrew/plugins/external_plugins/vibecrew/skills/vibecrew/SKILL.md`). If a call exits 3, the
backend isn't running: tell the user to start the VibeCrew app and give them
the finished spec inline so the work isn't lost.

### Resolve the project (context first, ask last)

Take the first rung that gives a confident answer:

1. `$VIBECREW_CARD_ID` is set (you're in a card-linked workspace):
   `python3 …/vibecrew_api.py card "$VIBECREW_CARD_ID"` → its `project_id`.
   Trust it.
2. The brief or recent conversation names a project, or a repo or product that
   clearly maps to one: `python3 …/vibecrew_api.py projects` and match by name,
   case-insensitive, allowing a clear substring hit. Exactly one match → use
   it.
3. `projects` returns exactly one project → use it.
4. Still ambiguous → ask with `AskUserQuestion`, offering the real project
   names as options. Don't guess between plausible projects.

When you inferred the project (rungs 1–3), name it in your report ("Filed in
**Payments**") so a wrong pick is caught at a glance.

### Create it

Write the description to a temp file, so markdown (including a `## Pipeline`
block) round-trips byte-exact, then:

```
python3 ~/.vibecrew/plugins/external_plugins/vibecrew/scripts/vibecrew_api.py card-create \
  --project-id <resolved-id> \
  --title "<the spec's one-line title, without the 'Task:' prefix>" \
  --description-file <tmpfile> \
  [--priority urgent|high|medium|low]
```

- `--title`: the spec's one-line title, terse enough to scan on a board.
- `--description-file`: the rest of the spec verbatim (Outcome, Scope,
  Technical requirements, Decisions, Acceptance, Risks), plus the Routing line
  and pipeline block described below.
- `--priority`: only when the brief clearly implies urgency or the user said so
  in the question round. Don't ask a separate question for it.

Report the card id from the client's output, the project, and the resolved
status.

Creating the card is the expected end of this skill, so do it without asking.
Leave existing cards alone: if the brief implies deleting, reassigning or
restructuring other cards, surface that and let the user decide. (The client
has no delete-card subcommand.)

## Attaching a pipeline (routed by default, composed by the server)

Every card you file carries the pipeline `classify-task` routed in step 5, so a
roadmap can reach the board and ship without anyone naming a pipeline per card.
Only an explicit "no pipeline" or "just the spec" files a bare card; routing
still runs and is reported, so the tier is on record. A pipeline the operator
names ("run it with Basic") beats the routed one; note any disagreement with
the rubric.

Compose the block with the server, never by hand. The endpoint is the same
composer the app's New-issue dialog uses, so your card and a hand-filed card
are byte-identical for the same inputs:

```
python3 ~/.vibecrew/plugins/external_plugins/vibecrew/scripts/vibecrew_api.py pipeline-compose <Basic|Planned|Async> \
  --enabled-ids <the ticked stage ids, comma-separated> \
  --executor <main agent raw value> \
  [--model <main-loop model>] \
  [--stage-agent <stage>=<RAW> …] [--stage-model <stage>=<model id> …] \
  [--custom-text "<extra instructions>"]
```

It writes nothing and returns `{block, extension_metadata, steps}`. Then:

1. Write the description file: the spec, then the `**Routing:**` line from
   step 5, then the returned `block` verbatim. The Routing line sits directly
   above the block, outside its delimiters.
2. `card-create … --description-file <tmpfile>` as in
   [Create it](#create-it).
3. `python3 …/vibecrew_api.py card-update <new card id> --extension-metadata
   '<the returned extension_metadata JSON>'`. This is what makes the card's
   pipeline editable in the app, and what the launcher reads for the executor,
   the model and the subagent definitions. Use `--extension-metadata-file` when
   the JSON is large or quote-heavy.

How to set the flags:

- **Pipelines available.** The bundled `Basic` / `Planned` / `Async`, plus user
  pipelines in `~/.vibecrew/pipelines/*.toml`, which shadow bundled ones by
  `name =`. `vibecrew_api.py pipelines` lists them and `pipeline <name>` returns
  the stage roster with each stage's resolved binding. Take names from that
  list; removed per-model pipeline names return 404. Never write or paraphrase
  stage text yourself.
- **`--enabled-ids`.** Start from the pipeline's `default_enabled = true` set
  (`Basic`: `merge`; `Planned`: `spec, plan, plan-review, merge`; `Async`:
  `spec, plan, plan-review, code, merge`), then apply `classify-task`'s
  toggles: add `code-review` when the toggle says `yes`; for `completion: pr`,
  drop `merge` and add `pr`. Add `orchestrate` only on an explicit auto-drive
  ask ("execute this", "auto-drive it"), never by default or by routing.
- **`--executor`.** Always pass it, because the bundled pipelines are
  agent-neutral. Use the raw value for the resolved main agent:
  `CLAUDE_CODE_HEADED`, `OPENCODE_HEADED`, `CODEX_HEADED`, `PI_HEADED`.
- **`--stage-agent` / `--stage-model`.** Only for stages with a delegable role
  (`spec`, `plan`, `plan-review`, `code`, `code-review`); the endpoint returns
  400 for a role-less stage. `Planned` and `Async` already bind both reviews to
  `CODEX`, so leave those unless the user asked otherwise.
  `--stage-agent plan-review=` (empty value) clears a shipped binding so the
  step inherits the main loop. OpenCode and Pi model ids are
  provider-qualified (`zai-coding-plan/glm-5.2`, `minimax/MiniMax-M3`,
  `kimi-coding/k3`).
- **`--model`.** Only when the user names a model for the whole card; it pins
  the main loop. A model named for one step is a `--stage-model` on that stage,
  and it belongs to that step's agent: `gpt-5.6-sol` means Codex, `opus` means
  Claude Code. If the user pairs a model with an agent that can't run it,
  surface the contradiction instead of composing it.

Report the pipeline type (routed or operator-named), the main agent, the
per-step bindings, the ticked stages and any pins.

## Lanes — decompose big work so it can run in parallel

When a brief or roadmap splits into several cards (step 7), file it as lanes:

- **One parent epic card**, a plain tracking card with a short summary, no
  pipeline block and no orchestrate, so it is never dispatched. File it first;
  its id is every sub-card's `--parent-card-id`.
- **One sub-card per deliverable**, each a full, self-contained spec, each
  classified and routed on its own (step 5 for every sub-card; tiers may
  differ), created with `--parent-card-id <epic-id>`.
- **Dependencies are `blocking` relationships** created on the blocker
  (direction blocker → blocked):
  `python3 …/vibecrew_api.py card-relate <blocker-id> --related-card-id
  <blocked-id> --type blocking`. Chain the cards within a lane and leave
  different lanes unlinked; no edge between lanes is what makes them parallel.
  Never create a cycle: A→B→A deadlocks both lanes, and the orchestrator parks
  them rather than resolving them.
- **A lane map in the epic's description**, a short readable list
  (`Lane A: CARD-1 → CARD-2; Lane B: CARD-3`). The relationships are the
  machine-readable truth; the app draws them as a dependency forest.
- **Auto-drive**: when the user asked for execution, put `orchestrate` on every
  sub-card (they are what gets dispatched), never on the epic. The
  orchestrator holds a blocked card until every card blocking it is `done`, so
  ticking orchestrate across a whole lane up front is safe.

Report the epic id, each sub-card id with its lane and tier, and every edge you
created.

## Examples

**A vague verb gets a definition of done.** Brief: *"refactor the dispatcher, it
should be event driven"*. "Refactor" and "event driven" have no testable
meaning, and "the dispatcher" bundles several behaviors. Ask what triggers an
event today versus what should, which behaviors are in scope, and what "done"
looks like. The Outcome becomes "dispatcher reacts to job-state-change events
within Ns instead of polling every Ms"; Acceptance becomes "with polling
disabled, a finishing job still triggers the next stage". File it in the
project the dispatcher lives in, resolved from context.

**An open decision gets resolved, and the project is inferred.** Brief:
*"publish sevm findings to the DB, introduce a backend flag api/database or none
by default?"*. The trailing "?" is a decision, not a detail. Ask which default
the user wants and whether all three modes are needed, record the answer under
Decisions made, verify the publish endpoint exists, and file the card. With one
project on the board, pick it and note "Filed in **sevm**" in the report.

## When to use something else

- Raw board or agent operations with no speccing (list cards, start a
  workspace, dispatch or check an agent, respond to an approval): the
  `vibecrew` skill.
- The implementation plan (which files, what order): a planning step that
  consumes this card's spec.
- A trivial, unambiguous task ("fix this typo", "bump this version"): if the
  user still wants it tracked, create a one-line card directly.
- A narrow question mid-implementation: answer it.
