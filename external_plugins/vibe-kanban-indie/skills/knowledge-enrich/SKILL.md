---
name: knowledge-enrich
description: >-
  Record durable, reusable knowledge from what a card shipped into its PROJECT's
  knowledge base (`~/.vibe-kanban/projects/<project_id>/knowledge/`, a standalone
  git repo). Reads `SPEC.md`, the implementation plan, and the git diff; distills
  the cross-card facts (architecture, where-things-live, decisions, gotchas,
  patterns) into new/updated topic pages tagged with this card's id and the
  repo(s) the learning concerns; refreshes the index; then git-commits the
  knowledge base. Use this at the END of a card — before merge — when the card's
  `## Pipeline` opts into "Enrich knowledge base". Says "no new knowledge to
  record" when nothing reusable emerged. Trigger phrases: "enrich knowledge base",
  "enrich stage", "record what we learned", "update the project knowledge base",
  "knowledge enrich".
---

# knowledge-enrich — record reusable knowledge from a finished card

## What this skill is for

This is the **write** half of the project knowledge loop ([`knowledge-recall`] is
the read half). When a card's work is done, it distills the *durable, reusable*
knowledge from what shipped into the **project's** knowledge base, so the next
card can recall it. The goal is a small, high-signal, project-scoped wiki — not a
changelog.

## The knowledge base is PROJECT-scoped and self-versioned

There is exactly **one knowledge base per vibe-kanban project**, stored as its own
git repo (instantly visible to every card, branch-independent) at:

```
<vibe_kanban_home>/projects/<project_id>/knowledge/
    index.md          # one-line-per-page catalog
    <slug>.md         # one durable topic page each
```

You write here and commit here. This directory is **separate** from any code
worktree, so your commit never mixes with the card's feature diff.

## Method

### 1. Resolve the knowledge base location

- **`<project_id>`** — vibe-kanban MCP `get_context` → `project_id`. Also note
  `workspace_repos[].repo_name` (the repos in this workspace). If no `project_id`
  is resolvable (unlinked workspace), report "no project context — skipping
  knowledge enrich" and stop.
- **`<vibe_kanban_home>`** — derive from cwd: walk up to the nearest ancestor dir
  named `worktrees`; its parent is `<vibe_kanban_home>` (handles both
  `~/.vibe-kanban` and the debug `~/.vibe-kanban-dev`). Fall back to
  `~/.vibe-kanban` (else `~/.vibe-kanban-dev`) if cwd isn't under a `worktrees`
  ancestor.
- **KB dir** = `<vibe_kanban_home>/projects/<project_id>/knowledge/`.

### 2. Gather what shipped

- Card **`simple_id`** (e.g. `VIBE-42`) — from the `{{TASK}}` line of your kickoff
  (or `get_issue`).
- `<workspace_root>/SPEC.md` and `<workspace_root>/IMPLEMENTATION_PLAN.md` if
  present.
- The diff in your worktree(s): `git diff <base>...HEAD --stat`, then targeted
  `git diff` for the substance. Note **which repo(s)** the card changed (their
  `repo.name`).

### 3. Reusability gate (be strict — this keeps the KB high-signal)

Distill ONLY **durable, cross-card** facts that a future card would otherwise
rediscover the hard way:

- architecture / how a subsystem fits together,
- where things live (the file/module that owns a behavior),
- non-obvious **decisions** and why,
- **gotchas / footguns**, established **patterns** and conventions.

**Exclude**: this card's changelog, transient TODOs, restating the spec, or
anything the code/docs already state plainly. **If nothing clears the bar: write
nothing, do not commit, report `no new knowledge to record`, and stop.** A clean
"nothing reusable" is a perfectly good outcome — do not invent filler.

### 4. Knowledge-base on-disk format (author pages in exactly this shape)

**Topic page `<slug>.md`** (`<slug>` is kebab-case and equals the filename):

```markdown
---
title: Session auth flow
slug: session-auth-flow
tags: [auth, backend, gotcha]
repos: [api-server]          # repo.name(s) this learning concerns; [] = project-wide
summary: How login issues + refreshes the session cookie; where the 401 retry lives.
sources: [VIBE-20, VIBE-42]  # contributing card simple_ids
created: 2026-06-30
updated: 2026-06-30
---

# Session auth flow
> <one-line summary repeated>

## What it is
<2–5 sentences of durable, reusable fact>

## Where it lives
- `path/to/file.rs` — <what it does>

## Gotchas / decisions
- <the non-obvious thing a future card would otherwise rediscover>

## See also
- [[other-slug]]
```

`summary` is ≤ 200 chars on one line (it is the cheap grep payload). Cross-link
related pages with `[[slug]]`.

**`index.md`** — the catalog. Page lines live between the markers so it stays
machine-rewritable:

```markdown
# Knowledge base — <project name or id>

This is the project knowledge base for vibe-kanban cards. Recall greps this file;
Enrich maintains it. Do not hand-edit between the markers.

<!-- vk:kb:index:start -->
- [[session-auth-flow]] — Session auth flow — repos: api-server — tags: auth, backend — sources: VIBE-20, VIBE-42 — How login issues + refreshes the session cookie; where the 401 retry lives.
<!-- vk:kb:index:end -->
```

Each index line is one self-contained line: `[[slug]] — Title — repos: … — tags: …
— sources: … — summary`. Keep lines alphabetical by slug so parallel edits stay
conflict-local.

### 5. Write / update pages

For each distilled topic:

- **Update** a closely-matching existing page (grep `index.md`) rather than
  creating a near-duplicate — prefer merging facts into the right page (this is the
  main defense against bloat). On update: merge the new facts, refresh `updated:`,
  add this card's `simple_id` to `sources:` if absent, and extend `repos:`/`tags:`
  as needed.
- Otherwise **create** `<KB dir>/<slug>.md` from the template, with
  `sources: [<simple_id>]`.
- Set each touched page's **`repos:`** to the repo(s) the learning is about (derive
  from which repos the diff touched / what the page discusses); use `[]` for a
  project-wide fact.
- Fix any `[[slug]]` whose target no longer exists; add "See also" links between
  related pages.
- Rewrite the `<!-- vk:kb:index:start -->`…`<!-- vk:kb:index:end -->` block to
  reflect the current page set (one line per page, alphabetical by slug). Create
  `index.md` (and the KB dir) if this is the project's first page.

### 6. Commit the knowledge base

The KB dir is its **own** git repo:

```sh
mkdir -p "<KB dir>"
git -C "<KB dir>" rev-parse --git-dir >/dev/null 2>&1 || git -C "<KB dir>" init -q
git -C "<KB dir>" add -A
git -C "<KB dir>" commit -q -m "kb: <short topic> (<simple_id>)" || true   # tolerate "nothing to commit"
```

Commit **only** inside `<KB dir>` — never stage the card's code repo here. If a
transient git lock fails the commit (another card enriching the same project
concurrently), wait briefly and retry once.

### 7. Report

A short, scannable summary: pages **created** and **updated** (by slug), the
`simple_id` tagged, and the repos covered — or `no new knowledge to record`.

## Hard constraints

- **Write only inside `<KB dir>`** (the project knowledge repo). Never write
  knowledge files into a code worktree, and never commit knowledge into a code
  repo.
- **One project KB.** A multi-repo card still records into the single project KB,
  using `repos:` to tag which repo each fact concerns — do not create per-repo
  knowledge bases.
- **High-signal only.** When in doubt, leave it out; `no new knowledge to record`
  beats filler.
