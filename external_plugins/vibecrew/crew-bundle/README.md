# Crew bundle — pipeline-stage subagents + self-review skill (Layer B)

This directory is the **canonical source** for the content the VibeCrew app
ships via its Plugin Manager (`CrewPlugins/Resources/Plugins/payloads/`). It
holds:

- **Pipeline-stage subagents** — `vibecrew-product`, `vibecrew-planner`,
  `vibecrew-coder`, `vibecrew-reviewer` — that run *inside a card's worktree*
  as stages of an execution pipeline.
- **`code-review-checklist`** — a self-review skill invoked before opening a PR.

A separate thing from the **board orchestrator crew** (`orchestrator`,
`product`, `planner`, `coder`, `decider` — unprefixed, living in `../agents/`),
which drives the board from the operator's session.

## Two agent layers — do not merge them

| | Layer A — orchestrator crew | Layer B — pipeline subagents (here) |
|---|---|---|
| **Names** | unprefixed (`product`, `planner`…) | prefixed (`vibecrew-product`…) |
| **Runs** | in the operator's session, drives the board | inside a card worktree, as a pipeline stage |
| **Model** | carries its own `model:` frontmatter | **no model** frontmatter — pinned per call by the launching pipeline |
| **Lives** | `../agents/*.md` | `<id>/{claude,opencode}/agent.md` |

The prefixed names exist so a pipeline stage can delegate (`Agent(vibecrew-product)`)
without colliding with the board-level agent of the same role.

## Layout

```
crew-bundle/<id>/{claude,opencode}/agent.md   (subagents)
crew-bundle/code-review-checklist/{claude,opencode}/SKILL.md
```

- The **body is identical** across `claude/` and `opencode/` — only the
  frontmatter format differs (Claude Code: `name:` + flat `tools:`/`allowed-tools:`
  list; opencode: `description:` + `mode:` + `permission:` map). Edit one, mirror
  the other; a drift check enforces it.
- Each pipeline `agent.md` carries no `model:` pin — the pipeline supplies the
  model per call (Claude Code) or per launch (OpenCode env), so a global install
  must not fight the card's binding.

## Source of truth

This directory is canonical. The app's bundled
`CrewPlugins/Resources/Plugins/payloads/` is a vendored copy (generated at
build), and per-CLI global installs (`~/.config/opencode/agents/vibecrew-*.md`,
`~/.claude/agents/`) are deployed symlinks — never edit those in place.
