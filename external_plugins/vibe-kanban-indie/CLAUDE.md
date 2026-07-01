# CLAUDE.md — vibe-kanban-indie pipeline conventions

This file records how the **vibe-kanban-indie** plugin interprets a card's pipeline,
the canonical ordering of pipeline items, how the **Update documentation** stage is
performed, and the full **Wait for approval** lifecycle. It is the single source of
truth for the **park marker** literal that `prompts/pipeline.md` (the coding agent that
*emits* it) and `agents/orchestrator.md` (the orchestrator that *matches* it) both
reference — they must stay in sync with the definition here.

## Pipeline-item conventions

A card's description may carry a `## Pipeline` block delimited by
`<!-- vk:pipeline:start -->` / `<!-- vk:pipeline:end -->`. Each bullet inside is an
**optional stage** the coding agent runs *around* its always-on implementation work.

- **The bullets are authored by the vibe-kanban app, not this repo.** The plugin only
  *interprets* them. So this plugin recognizes a stage by its **name / intent**
  ("Wait for approval", "Update documentation", "spec", …) — not by an exact
  app-emitted string. If the app ever emits different canonical phrasing for a stage,
  the matching language in `pipeline.md` / `orchestrator.md` must be realigned to it;
  the **park marker** below is independent of that wording because the agent emits it.
- A card lists **only the subset of stages it opts into**, in the canonical relative
  order below.
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
5. **plan-review** — codex reviews the plan (`codex exec --sandbox read-only`); resolve blockers.
6. **implement** — *always*; the coding agent's own core work, committed as it goes.
7. **code-review** — codex reviews the diff (`codex review --base <base>`); address findings.
8. **Update documentation** — update the docs the change affects (see below), before merge.
9. **enrich-knowledge** — the coding agent invokes `knowledge-enrich`: records reusable
   knowledge from what shipped into the project knowledge base (its own git repo) and
   commits it, before merge (see below).
10. **Wait for approval** — an operator gate. Its slot here (just before merge) is only
   its **most common** placement; unlike the other stages it is **freely placeable** —
   the card can position it wherever an operator sign-off is wanted (e.g. right after
   `plan` to approve the plan before coding, or after `code-review` to approve the change
   before merge). Wherever it sits, it pauses the pipeline at that point (see below).
11. **merge** — the operator owns the merge/PR decision; the agent stops and awaits it.

The numbered list is the **default relative order** the other stages keep when several
are listed; **Wait for approval** is the one stage that may appear earlier than its slot
above, at whatever point the card places the gate.

**Wait for approval vs. merge.** The `merge` stage already stops for the operator's
*merge* decision. **Wait for approval** is the general-purpose gate for *any*
mid-pipeline operator sign-off before later stages run — distinct from, and usable
alongside, `merge`.

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
  `agents/orchestrator.md` (consumer); change it in one place and you must change it in
  all three.

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
   once-per-distinct-park and does **not** count the tick as ACTIVE for adaptive cadence.
4. **Operator decides.** The decision/instructions are relayed to the parked agent as a
   prompt via `run_session_prompt(session_id, <decision>)` — the same sanctioned MCP
   channel `/compact` uses (or console / Telegram). This is **operator-initiated**: the
   orchestrator **never auto-resumes or auto-clears** the gate, and `auto-unblock` (which
   only clears tool-permission approvals) must **not** be read as clearing it.
5. **Agent resumes.** On receiving the prompt the agent treats it as the approval
   decision — proceed as approved (carrying out any instructions) or revise as instructed
   — then continues the remaining pipeline stages.

## Cross-references

- `prompts/pipeline.md` — the coding-agent kickoff; defines the Wait-for-approval and
  Update-documentation stage behaviors (producer of the park marker).
- `agents/orchestrator.md` — recognizes/holds/surfaces the gate (consumer of the marker);
  `nudge-stuck` exclusion, status-reflection short-circuit, report + telegram-fanout
  surfacing, and the no-auto-resume safety rule.
- `prompts/README.md` — the prompt set overview and the stage flow diagram.
