---
name: knowledge-recall
description: >-
  Surface prior project knowledge before planning a card. Reads the
  PROJECT-scoped knowledge base for this card's project
  (`~/.vibe-kanban/projects/<project_id>/knowledge/`), greps it for pages
  relevant to the card topic, reads the top matches, and writes a compact
  `PRIOR_KNOWLEDGE.md` at the workspace root for the spec / plan / coding stages
  to build on. Use this at the START of a card — before the plan stage — when the
  card's `## Pipeline` opts into "Recall prior knowledge". It is READ-ONLY on the
  knowledge base: it never edits or commits knowledge pages. Trigger phrases:
  "recall prior knowledge", "recall stage", "what does this project already know",
  "pull prior knowledge", "knowledge recall".
---

# knowledge-recall — pull prior project knowledge into a card

## What this skill is for

A vibe-kanban **project** accumulates a small knowledge base over time: durable,
reusable facts each finished card recorded (where things live, non-obvious
decisions, gotchas, established patterns). This skill reads that knowledge base
**before** a new card is planned and distills the relevant parts into a single
`PRIOR_KNOWLEDGE.md` at the workspace root, so the `product` / `planner` /
coding agents build on what's already known instead of re-deriving it.

It is the **read** half of the knowledge loop; [`knowledge-enrich`] is the write
half. This skill **never writes into the knowledge base** and **never commits** —
its only output is `PRIOR_KNOWLEDGE.md` at the workspace root (which lives outside
every repo worktree and is never committed, exactly like `SPEC.md` /
`IMPLEMENTATION_PLAN.md`).

## The knowledge base is PROJECT-scoped

There is exactly **one knowledge base per vibe-kanban project**, stored as its own
git repo at:

```
<vibe_kanban_home>/projects/<project_id>/knowledge/
    index.md          # one-line-per-page catalog (the cheap grep target)
    <slug>.md         # one durable topic page each
```

This is shared and **branch-independent** — it is NOT inside any code worktree, so
you see every card's recorded knowledge immediately, with no merge required.

## Method

### 1. Resolve the knowledge base location

- **`<project_id>`** — call the vibe-kanban MCP `get_context`; use its `project_id`.
  If `get_context` is unavailable or returns no `project_id` (an unlinked
  workspace), there is no project to recall for → go to the **no-context grace**
  below.
- **`<vibe_kanban_home>`** — derive it from your current working directory (do NOT
  hardcode `~/.vibe-kanban`; debug builds use `~/.vibe-kanban-dev`). Your cwd is a
  repo worktree under `<home>/worktrees/<workspace>/<repo>/`. Walk up to the
  nearest ancestor directory named `worktrees`; its **parent** is
  `<vibe_kanban_home>`. If your cwd is not under a `worktrees` ancestor (a custom
  workspace dir), fall back to `~/.vibe-kanban` if it exists, else
  `~/.vibe-kanban-dev`.
- **KB dir** = `<vibe_kanban_home>/projects/<project_id>/knowledge/`.
- **Workspace root** = the parent of your repo worktree (the dir that holds
  `CLAUDE.md`); your caller passes it to you. `PRIOR_KNOWLEDGE.md` is written
  there.

### 2. Empty-KB / no-context grace (always succeed)

If `<KB dir>/index.md` does not exist or has no page entries, OR you could not
resolve a `project_id`, write a short `PRIOR_KNOWLEDGE.md` and **stop cleanly**:

```markdown
# Prior knowledge

No project knowledge base entries are available yet (first card for this project,
or none recorded / project context not resolvable). Proceed without prior
knowledge; the Enrich stage will seed the knowledge base.
```

This is a normal outcome, not an error. Never fail the stage over an empty KB.

### 3. Build the query

Read the card topic: the card title (from the `{{TASK}}` line of your kickoff) and
`<workspace_root>/SPEC.md` if it exists (else the card description). Extract the
**salient terms**: referenced file/dir paths, module / function / symbol names,
domain nouns, and the card's feature area. These are what you'll grep for.

### 4. Search & rank (grep-first, no embeddings)

- `grep -i` each salient term against `<KB dir>/index.md`. Each index line packs
  the page's slug, title, repos, tags, sources, and summary onto one line, so a
  single grep surfaces enough to rank without opening files.
- Rank candidate pages by the **number of distinct query terms** that hit.
- Take the **top 3–5** pages. (If `index.md` yields fewer than 2 hits, do a second
  pass grepping the `title:` / `tags:` / `summary:` frontmatter of the `<slug>.md`
  pages directly.)

### 5. Read the top matches and write `PRIOR_KNOWLEDGE.md`

Read the top 3–5 pages in full; ignore the rest. Write a **token-bounded** digest
(aim ≤ ~4–6k tokens, hard cap ~5 pages) to `<workspace_root>/PRIOR_KNOWLEDGE.md`:

```markdown
# Prior knowledge (from this project's knowledge base)

Distilled from the project knowledge base. Reuse these established
decisions/patterns instead of re-deriving them; cite the source card ids if a
plan step leans on one. Each fact applies to the repo(s) named in its scope.

## <Page title>  (scope: <repos or "project-wide">, sources: VIBE-xx, VIBE-yy)
<the page summary>
- <most relevant where-it-lives / gotcha / decision bullets>
_source page: projects/<project_id>/knowledge/<slug>.md_

## <next page> …
```

End with a one-line `Not covered:` note if the query had weak coverage, so the
planner knows the KB didn't speak to part of the card.

### 6. Report

One line: e.g. `Wrote PRIOR_KNOWLEDGE.md from 3 knowledge pages (VIBE-20,
VIBE-34).` or `No prior knowledge base yet — wrote first-card note.`

## Hard constraints

- **Read-only on the knowledge base.** Never create, edit, move, or delete
  anything under `<KB dir>`, and never run `git` there.
- **Write exactly one file:** `<workspace_root>/PRIOR_KNOWLEDGE.md`. Never write it
  inside your repo worktree (it would get committed).
- **Always succeed.** Empty KB, missing context, or a grep that finds nothing all
  resolve to the graceful note in step 2/5 — never a hard failure.
