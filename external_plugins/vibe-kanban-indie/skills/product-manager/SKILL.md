---
name: product-manager
description: >-
  Turn a short, rough task brief into a clear technical task spec AND file it as a
  vibe-kanban card (issue) on the board. The spec is rendered inline first so the
  user can confirm nothing was missed, then created as a card via the vibe-kanban
  MCP. Use this skill WHENEVER the user hands over a brief, rough, or one-paragraph
  task and wants it fleshed out, scoped, sharpened, "PM'd", "made into a ticket /
  card / issue", or "put on the board / kanban" before implementation — phrases
  like "spec this out", "turn this into a proper task", "flesh this out", "write a
  technical task for", "make this a real ticket", "create a card for this", "add
  this to the backlog", or when they describe a feature/refactor and clearly want
  scope and requirements confirmed before diving into code. Also use it proactively
  when a build request is vague, bundles several concerns, or leaves design
  decisions open — surface and resolve those gaps here, then capture the result as
  a card. Do NOT use it to write the implementation plan itself (the step-by-step
  "how/which files"); this produces the WHAT and acceptance criteria a later
  planning step consumes. For raw board/agent operations with no speccing involved
  (listing issues, starting a workspace, dispatching or checking an agent), use the
  `vibe-kanban` skill instead.
---

# Product Manager: brief → technical task spec → vibe-kanban card

## What this skill is for

Most rework on a task doesn't come from bad code — it comes from a brief that
left things implicit. A design decision gets posed as a question inside the
brief and silently guessed at. "Refactor X" has no testable definition of done.
Two unrelated concerns ride in one sentence with no priority. An assumption
about which file or flag is involved turns out wrong. Scope grows mid-build.

This skill is the cheap insurance against all of that. It takes a rough brief,
turns it into a **medium-length, easy-to-read technical task spec** that the user
reads back and corrects in one pass, and then **files that spec as a card on the
vibe-kanban board** so the work is captured where it gets picked up. The whole
point is to make the implicit explicit *now*, while changing it costs a sentence,
and to land it somewhere durable instead of leaving it in chat scrollback.

You are acting as a product manager here, not an engineer. Your job is to nail
down **what** is being built, **why**, and **how we'll know it's done** — not to
design the implementation. The card you produce is the input to a separate
planning step the user (or an agent) runs later.

## Hard constraints (these define the skill)

- **The spec is reviewed inline, then becomes a card. Write no files.** Render
  the spec in chat first so the user can catch anything wrong, then create a
  vibe-kanban issue whose title + description carry it. Don't create `.md` files
  or write to a `specs/`/`.sombrax/` folder — the board is the destination, not
  the filesystem.
- **Always end with a real card** (unless the user explicitly says "just the
  spec, don't file it"). The card is the deliverable; a spec that only lives in
  chat is the failure mode this version exists to fix.
- **Touch code only lightly, and only to verify — never to explore or edit.**
  You may run a quick `grep`/`glob`/single `read` to confirm that a file, flag,
  function, table, or endpoint the brief names actually exists and means what the
  brief assumes (wrong-integration assumptions are a top rework cause). Do not
  read broadly, do not trace call graphs, do not open many files, and never edit.
  If verifying would take more than a couple of quick lookups, don't — flag the
  assumption in the spec instead.
- **One focused round of clarifying questions, then draft.** Don't drip questions
  across many turns. Gather the genuinely-blocking ambiguities, ask them once
  (batched), then write the spec. The user can still iterate after.
- **Medium size.** Aim for something that reads in under a minute or two —
  roughly one screen, maybe two. Comprehensive on *decisions*, lean on prose. If
  a section has nothing real to say, cut it rather than padding.

## The flow

### 1. Read the brief for what's missing, not just what's there

Before asking anything, parse the brief through the lens of the failure modes
this skill exists to catch. Look specifically for:

- **Open design decisions phrased as questions or "maybe"s.** "introduce a
  backend flag that's api/database or none?" is not a requirement — it's a
  decision the user wants made. These *must* be resolved, not passed through.
- **Vague verbs with no definition of done.** "rethink", "refactor",
  "comprehensive", "clean up", "improve", "make it better" — each needs a
  concrete, observable answer to "done looks like ___".
- **Bundled concerns.** A brief that mixes a refactor + a new feature + a bug
  fix needs them separated and prioritized, or at least explicitly acknowledged
  as one unit. (If they're genuinely separate deliverables, it's fine to file
  more than one card — see step 6.)
- **Integration assumptions.** Names of files, flags, endpoints, jobs, tables,
  config keys — the things most likely to be slightly wrong. These are your
  candidates for a quick verification lookup.
- **Unstated scope edges.** What's tempting to also do but is *out*? Naming the
  out-of-scope items up front is the single best defense against scope creep.

### 2. Do light, targeted verification (optional, fast)

If the brief names concrete things you can cheaply check, do so — one or two
quick lookups. The goal is to avoid baking a wrong assumption into the spec
("the spec said modify `process_block`, but that function iterates the whole
block, not transactions"). Confirm a flag exists in the CLI args, a function is
where the brief implies, an endpoint path is real. If a check is fast and kills
an assumption, do it. If it's not fast, skip it and list the assumption instead.
Never let verification turn into a code-exploration session — that's the opposite
of this skill.

### 3. Ask one focused round of clarifying questions

Use the `AskUserQuestion` tool — it lets the user pick fast. Ask only what
genuinely changes the spec; don't ask things you can reasonably default (and when
you default, say so in the spec rather than asking). Prioritize, in order: (a) the
open design decisions you found, (b) the concrete meaning of any vague "done",
(c) scope boundaries, (d) priority when concerns are bundled.

If the brief is already crisp and nothing is genuinely blocking, skip the question
round — but say "the brief was clear enough to spec directly; here's what I
assumed" and lean on the Assumptions section. When in doubt, ask — a 30-second
question round is far cheaper than a wrong spec (or a wrong card).

### 4. Write the spec inline

Use the template below. Fill every section with real content or cut it. Keep the
language plain — the user should be able to skim it and immediately spot anything
wrong. This inline render is the review surface: it's the user's chance to correct
the spec *before* it lands on the board.

### 5. Resolve the project, then create the card

Once the spec reads right, file it as a vibe-kanban card. See **Creating the
card** below for the project-resolution ladder (resolve from context first, ask
only as a last resort) and the field mapping. Report back the created card's
human-readable ID and URL so the user can spot a wrong project pick.

### 6. Multiple deliverables (only when warranted)

If the brief genuinely contains separate deliverables that shouldn't share one
card, say so, file the primary card, and offer to file the others (or nest them
as sub-issues via `parent_issue_id`). Don't fragment a single coherent task into
many cards — default to one card per spec.

## Spec template

Render the spec in chat using this structure. Keep headings; drop any section
that has nothing substantive (note which you dropped and why, briefly). This same
text becomes the card's title (the one-line title) and description (everything
else).

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

The board lives in vibe-kanban and is reached through its MCP server (tools are
`mcp__plugin_vibe-kanban-indie_vibe-kanban__<tool>`). If a tool returns "Failed to connect to VK API", the
backend isn't running — tell the user to start the vibe-kanban app, and offer to
hand them the finished spec inline in the meantime rather than losing the work.

### Resolve which project the card belongs to (context first, ask last)

Picking the wrong project is annoying to undo, but interrogating the user on
every card is worse. Work down this ladder and stop at the first rung that gives
a confident answer:

1. **Linked workspace context.** Call `get_context`. If you're running inside a
   workspace linked to a remote project, it returns that project — use it. (In
   that case `create_issue` even lets you omit `project_id`.) This is the
   strongest signal; trust it.
2. **A project named in the brief or recent conversation.** If the user mentioned
   a project (or a repo/product that obviously maps to one), call `list_projects`
   and match by name, case-insensitive, allowing a clear substring hit. Exactly
   one match → use it.
3. **A sole project.** If `list_projects` returns exactly one project, use it.
4. **Still ambiguous** (several projects, no contextual signal) → this is the one
   case where you ask. Use `AskUserQuestion` with the actual project names from
   `list_projects` as the options, so it's a single quick click rather than an
   open-ended question. Don't guess between plausible projects — a misfiled card
   is exactly the kind of silent error this skill is supposed to prevent.

Whenever you resolve the project by inference (rungs 1–3), name the project you
chose in your final report ("Filed in **Payments**"), so a wrong pick is caught
in one glance. Resolve the project by inference *before* asking — only rung 4 ever
prompts.

### Map the spec onto the issue and create it

Call `create_issue` with:

- `project_id`: the resolved project's UUID (omit only when `get_context` scopes
  you to a project, per rung 1).
- `title`: the spec's one-line title (the text after "Task:", without the
  "Task:" prefix). Keep it terse and scannable on a board.
- `description`: the rest of the rendered spec, verbatim — Outcome, Scope,
  Technical requirements, Decisions, Acceptance, Risks. Markdown is preserved.
- `priority`: set `urgent`/`high`/`medium`/`low` only when the brief clearly
  implies urgency, or when the user told you in the question round. Otherwise omit
  and let the board default stand — don't open a separate question just for this.

After it's created, report the card's `simple_id` (e.g. `PROJ-42`), the project
it landed in, and the URL/link if the response carries one. That closes the loop:
the user sees the spec *and* knows exactly where it now lives.

### Don't surprise the user with side effects

Creating, and especially deleting, board items are real mutations. Creating the
card is the expected end of this skill, so just do it and report back. But never
`delete_issue`, reassign, or restructure existing cards as a side effect — if the
brief implies touching other cards, surface that and let the user decide.

## Attaching a pipeline (execute "like the UI")

Some briefs don't stop at "spec it" — the user also wants the resulting card to
**run itself**: "create a card and execute Async Fable", "run it through Async
Sonnet", "use the basic pipeline", or any request that asks for the card to be
orchestrated or auto-driven. When you see that, attach a `## Pipeline` block to
the card's description that is byte-for-byte what the vibe-kanban web UI's New
Issue dialog would have produced for the same selection. This mirrors
`packages/web-core/src/shared/lib/pipeline/cardPipeline.ts` in the vibe-kanban
repo: the orchestrator and execution agent parse these exact generated lines
back out of the description (to know which stages are still enabled, to seed
the edit dialog, to track live "stage N of M" progress), so a paraphrase
anywhere inside the block silently breaks that round-trip. Treat the format
below as fixed, not as a style to approximate.

### Discover the pipeline

Pipelines live as TOML files on disk, not behind the MCP — read them directly,
you never invent one:

- `Glob` for `~/.vibe-kanban/pipelines/*.toml`. `Glob` doesn't expand `~`, so
  resolve it to the real absolute home path first (e.g.
  `/Users/<you>/.vibe-kanban/pipelines/*.toml`) before calling the tool.
- `Read` every candidate file. Each one is a pipeline: a top-level `name`, an
  optional `description`, and an ordered list of `[[stage]]` tables. Each stage
  has `id`, `label`, `prompt`, `default_enabled` (bool, defaults to `false` if
  absent), and `heavy` (bool, defaults to `false` if absent).
- Match the pipeline the user named against each file's `name` field,
  case-insensitively, or against the file stem (`async-fable.toml` →
  `async-fable`). "Async Fable", "async fable", and "async-fable" should all
  resolve to the same file.
- If nothing matches, don't guess and don't invent stages. List the real
  pipeline names you found on disk and ask which one via `AskUserQuestion`.

### Select the stages

- **Default selection** is every stage with `default_enabled = true`, kept in
  the order the stages appear in the file.
- If the user names steps to add or drop ("with merge", "skip the codex
  review", "no orchestrate"), apply those as overrides against the stage
  `label`s and `id`s — add stages they named that weren't default-enabled, drop
  ones they named that were.
- The `orchestrate` stage is the one exception to "default = `default_enabled`":
  include it **only** when the user explicitly asked for execution or
  auto-drive — phrasing like "and execute", "run it", "let the orchestrator
  take it", "auto-drive this". Naming a pipeline alone ("use Async Sonnet") is
  not enough; "execute Async Sonnet" or "run it through Async Sonnet" is.
- Note which enabled stages have `heavy = true` so you can flag their cost in
  the final report — never silently include a heavy stage without calling it
  out.

### Compose the block — byte-exact format

Build the block below, then append it to the end of the card's description as
`<spec text>` + one blank line + the block. Exactly one block per card — never
nest or duplicate the delimiters, since they're how the UI replaces the block
idempotently on later edits.

```
<!-- vk:pipeline:start -->
## Pipeline: <Name>

Execute these stages in the order listed. Do not add, skip, or reorder stages. As you begin each numbered stage below, output a single line exactly `VK-PIPELINE-STAGE: N` (N = the number of the stage you are starting) so pipeline progress can be tracked.

1. <stage 1 prompt, verbatim from the TOML>
2. <stage 2 prompt, verbatim>
<!-- vk:pipeline:end -->
```

Rules, all of them load-bearing:

- **The heading** is `## Pipeline: <name>`. If the user's request resolves to
  more than one pipeline combined, join the names with ` + ` (e.g.
  `## Pipeline: Async Sonnet + Basic`) and merge their stages in first-seen
  order, deduplicated by stage `id` — a stage id shared by two pipelines
  appears once, in the position it was first seen.
- **The order-instruction line is a fixed string** — it's the paragraph right
  under the heading in the format above. Reproduce it character-for-character,
  never paraphrased, reworded, or reflowed; that one copy above is the source
  of truth, don't retype it from memory elsewhere.
- **Optional executor pin** — only when the user names an execution agent
  ("with Claude Code", "pin it to Codex"). Place it after the order-instruction
  line and a blank line, before the numbered list, as exactly:

  `- Run this card with the **<AGENT>** execution agent: pass ` `executor: "<AGENT>"` ` when starting the workspace.`

  `<AGENT>` is a `BaseCodingAgent` key such as `CLAUDE_CODE` or `CODEX`.
  Rendered for `CLAUDE_CODE`, this is exactly:

  - Run this card with the **CLAUDE_CODE** execution agent: pass `executor: "CLAUDE_CODE"` when starting the workspace.
- **Stage prompts go into the numbered list verbatim** — copy the full `prompt`
  string from the TOML exactly as written, no paraphrasing, no summarizing, no
  extra prose inside the delimiters. The list is 1-indexed, in the same order
  as the stage selection above.
- **Placement:** append at the very end of the card description as
  `<spec text>\n\n<block>`. Exactly one block per card.

### Golden example

A card asking for "create a card and execute Async Fable" — the pipeline's
default stages plus explicit execution, so `orchestrate` is included:

```
<!-- vk:pipeline:start -->
## Pipeline: Async Fable

Execute these stages in the order listed. Do not add, skip, or reorder stages. As you begin each numbered stage below, output a single line exactly `VK-PIPELINE-STAGE: N` (N = the number of the stage you are starting) so pipeline progress can be tracked.

1. Have the orchestrator agent pick this card up and drive it to done autonomously, running the card's pipeline stages in order — regardless of which board column the card is in (it may be started even from Todo).
2. <prompt of stage "spec" ("Spec via Fable subagent"), verbatim from async-fable.toml>
3. <prompt of stage "plan" ("Plan via Fable subagent"), verbatim>
4. <prompt of stage "plan-review-codex" ("Codex plan review"), verbatim>
5. <prompt of stage "code-subagent" ("Code via Opus subagent"), verbatim>
6. <prompt of stage "code-review" ("Review via Codex"), verbatim>
<!-- vk:pipeline:end -->
```

Stage 1 is reproduced in full above because it's short and stable across
pipelines; stages 2–6 are shown as placeholders only so this doc doesn't
duplicate the entire TOML file. In real output there are no placeholders —
every numbered line is the stage's full `prompt` string copied
character-for-character out of the file you read.

If the user had instead said "use the Async Fable pipeline" (no mention of
executing it), the block would be identical except stage 1 (`orchestrate`)
would be dropped and the rest renumbered 1–5.

### Report what you attached

- Name the pipeline you attached (or the combined names, if merged).
- List the stages you enabled, flagging any with `heavy = true`.
- State whether `orchestrate` was included, and why (explicit ask vs. not
  requested).
- State the executor pin, if any, or note that none was set.

## Examples of the transformation

**Example 1 — a vague verb gets a definition of done, then a card**

Input brief: *"refactor the dispatcher, it should be event driven"*

The skill notices "refactor" + "event driven" have no testable meaning, and "the
dispatcher" is bundled (which behaviors change?). It asks: what triggers an event
today vs. what should? which behaviors are in scope? what does "done" look like —
a specific observable? The **Outcome** becomes "dispatcher reacts to
job-state-change events within Ns instead of polling every Ms", **Acceptance**
becomes "with polling disabled, a finishing job still triggers the next stage",
and that spec is filed as a card in the project the dispatcher lives in (resolved
from context, not asked).

**Example 2 — an open decision gets resolved, and the project is inferred**

Input brief: *"publish sevm findings to the DB, introduce a backend flag api/database or none by default?"*

The skill treats the trailing "?" as the most important thing in the brief — it's
a decision, not a detail. It asks which default the user wants and whether all
three modes are needed, records the answer under **Decisions made**, verifies the
publish endpoint path exists, then files the card. There's only one project on the
board, so it picks it silently and notes "Filed in **sevm**" in the report rather
than interrupting to ask.

## When NOT to use this skill

- The user wants raw board or agent operations with no speccing — list issues,
  start a workspace, dispatch or check a coding agent, respond to an approval.
  That's the **`vibe-kanban`** skill; point there instead.
- The user wants the actual implementation **plan** (which files, what order, the
  diff strategy). That's a planning step that consumes this card's spec — point
  them there instead of producing a plan here.
- The task is genuinely trivial and unambiguous ("fix this typo", "bump this
  version"). A spec is overhead; if they still want it tracked, just create a
  one-line card directly rather than running the full flow.
- The user is mid-implementation and asks a narrow question. Answer it; don't
  stop to write a spec.
