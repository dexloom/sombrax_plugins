# SombraX Plugins for Claude Code

A plugin marketplace for Claude Code by [dexloom](https://github.com/dexloom).

## Available Plugins

| Plugin | Description |
|--------|-------------|
| [sombrax-telegram](external_plugins/sombrax-telegram/) | Multi-session Telegram channel with topic routing and listener daemon |
| [vibe-kanban-indie](external_plugins/vibe-kanban-indie/) | Orchestrate vibe-kanban-indie — drive the kanban board and a crew of coding agents (skills, agents, lifecycle prompts, and a bundled MCP server) |
| [sombrax-codex](external_plugins/sombrax-codex/) | Codex CLI code review, plan review, and advisor skills |
| [vibecrew](external_plugins/vibecrew/) | Orchestrate a VibeCrew board MCP-free over its REST API — skills, orchestrator + pipeline-stage agents, lifecycle prompts, and a crew-bundle that is the canonical source the app vendors |

## Installation

### Claude Code plugin marketplace

```bash
# Add the marketplace to Claude Code
/plugin marketplace add dexloom/sombrax_plugins

# Install a plugin
/plugin install sombrax-telegram@sombrax-plugins
/plugin install sombrax-codex@sombrax-plugins
```

### Developer deploy (git → both CLIs)

The `bin/skills` script symlinks the vibecrew plugin's orchestration skills +
crew-bundle subagents and the vibe-kanban-indie opencode orchestrator agents
from this repo into both CLIs' config dirs, so a skill is edited once in git
and every agent sees the same content (copies drift; symlinks can't).

```bash
# Show what's deployed and whether each unit is linked
python3 bin/skills sombrax status

# Symlink every unit (first time)
python3 bin/skills sombrax install all

# Replace existing copies with symlinks (backs up drifted copies to .bak)
python3 bin/skills sombrax adopt --all --force
```

Skills land in `~/.claude/skills/` (opencode reads that dir too); opencode-only
agents land in `~/.config/opencode/agents/`. Override the plugin root with
`SOMBRAX_HOME=...` if your checkout lives elsewhere — by default the script
resolves it relative to its own location.

## VibeCrew plugin catalog (git-backed)

The VibeCrew app's Plugin Manager keeps a checkout of this repo at
`~/.vibecrew/plugins` as its plugin catalog — `external_plugins/vibecrew/
crew-bundle/` (`manifest.json` + payloads) is self-describing, so a
"Sync Catalog" click in the app (git fetch + reset to `origin/HEAD`) is all it
takes to pick up new plugin content. No app update or vendoring step is
involved; see `external_plugins/vibecrew/crew-bundle/README.md`.

## License

Apache-2.0
