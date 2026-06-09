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
