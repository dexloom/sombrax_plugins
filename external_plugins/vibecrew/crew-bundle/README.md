# Crew bundle — the app's plugin catalog (git source of truth)

This directory is the **complete, self-describing plugin catalog** the VibeCrew
app installs from. The app keeps a git checkout of this repo at
`~/.vibecrew/plugins` (source of truth: `dexloom/sombrax_plugins`) and its
Plugin Manager reads `manifest.json` + the payload tree straight from that
checkout — nothing is vendored into the app bundle any more.

It holds:

- **Pipeline-stage subagents** — `vibecrew-product`, `vibecrew-planner`,
  `vibecrew-coder`, `vibecrew-reviewer` — that run *inside a card's worktree*
  as stages of an execution pipeline.
- **`code-review-checklist`** — a self-review skill invoked before opening a PR.
- **`commit-helper`** — a conventional-commit drafting subagent.
- **`vibecrew-orchestrator`** / **`vibecrew-decider`** — standalone copies of
  the board orchestrator and its decider delegate (see below).
- **`vibecrew-assistant`** — standalone copy of the guide agent (docs,
  process explanations, configuration setup; writes only to the
  configuration). Not host-ticked — a conversation the operator drives.

A separate thing from the **board orchestrator crew** (`orchestrator`,
`product`, `planner`, `coder`, `decider` — unprefixed, living in `../agents/`),
which drives the board from the operator's session.

## Layout

```
crew-bundle/manifest.json                            # the catalog (same schema the app parses)
crew-bundle/<id>/{claude,opencode}/agent.md          (pipeline subagents)
crew-bundle/vibecrew-{orchestrator,assistant,auditor}/{claude,opencode,codex}/agent.md
crew-bundle/code-review-checklist/{claude,opencode,pi}/SKILL.md
```

- The **body is identical** across `claude/`, `opencode/` and `codex/` — only
  the frontmatter format differs (Claude Code: `name:` + flat
  `tools:`/`allowed-tools:` list; opencode: `description:` + `mode:` +
  `permission:` map; codex: `name:` + `description:` only, since Codex has no
  tool-grant frontmatter). Edit one, mirror the others; a drift check enforces
  it.
- The `codex/` payload exists only for the three HOST agents, and Codex does
  NOT discover it natively: VibeCrew reads the installed
  `~/.codex/agents/<id>.md`, strips the frontmatter, and hands the body to the
  CLI as `-c developer_instructions=<body>` at launch. The pipeline
  `vibecrew-<role>` agents deliberately do not ship a `codex` target — a Codex
  pipeline's delegate is a nested `codex exec`, not an installed subagent.
- The `pi/` payload is the same body with plain `name:`/`description:`
  frontmatter (Pi implements the Agent Skills standard; no tools list). Only
  skills target `pi` today — Pi pipelines self-execute stages, so the
  `vibecrew-<role>` agents deliberately do not ship a `pi` target.
- Each pipeline `agent.md` carries no `model:` pin — the pipeline supplies the
  model per call (Claude Code) or per launch (OpenCode env), so a global install
  must not fight the card's binding.

## Two agent layers — do not merge them

| | Layer A — orchestrator crew | Layer B — standalone catalog copies (here) |
|---|---|---|
| **Names** | unprefixed (`orchestrator`, `decider`…) | prefixed (`vibecrew-orchestrator`…) |
| **Runs** | in the operator's session, drives the board | installed by the app into each CLI's global config dir |
| **Model** | carries its own `model:` frontmatter | orchestrator/decider keep theirs; pipeline agents pin **no** model |
| **Lives** | `../agents/*.md`, `../agents-opencode/`, `../agents-codex/` | `<id>/{claude,opencode[,codex]}/agent.md` |

The `vibecrew-orchestrator`/`vibecrew-assistant`/`vibecrew-auditor`/
`vibecrew-decider` payloads are DERIVED from `../agents/*.md`,
`../agents-opencode/*.md`, and `../agents-codex/*.md`. Never edit them by
hand — run:

```bash
scripts/sync-crew-bundle.sh
```

which re-copies with the one rewrite that cannot be verbatim (`name:
orchestrator` → `name: vibecrew-orchestrator`, likewise decider — the
standalone copy must declare the id the app launches it by).

## Workflow (edit → sync → install)

1. Edit the payload (or its layer-A source + run `scripts/sync-crew-bundle.sh`).
2. Bump the plugin's `version` in `manifest.json` — that bump is what makes an
   installed copy show "Update available".
3. Commit + push. In VibeCrew: Settings → Plugins → **Sync Catalog**
   (`git fetch` + reset to `origin/HEAD` in `~/.vibecrew/plugins`), then click
   Update on the flagged rows.

Per-CLI global installs (`~/.config/opencode/agents/vibecrew-*.md`,
`~/.claude/agents/`) are written by the app's Plugin Manager — never edit
those in place.
