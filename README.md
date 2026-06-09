# SombraX Plugins for Claude Code

A plugin marketplace for Claude Code by [dexloom](https://github.com/dexloom).

## Available Plugins

| Plugin | Description |
|--------|-------------|
| [sombrax-telegram](external_plugins/sombrax-telegram/) | Multi-session Telegram channel with topic routing and listener daemon |
| [sombrax-codex](external_plugins/sombrax-codex/) | Codex CLI code review, plan review, and advisor skills |

## Installation

```bash
# Add the marketplace to Claude Code
/plugin marketplace add dexloom/sombrax_plugins

# Install a plugin
/plugin install sombrax-telegram@sombrax-plugins
/plugin install sombrax-codex@sombrax-plugins
```

## License

Apache-2.0
