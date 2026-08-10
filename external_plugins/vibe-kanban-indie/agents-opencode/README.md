# vibe-kanban-indie opencode orchestrator agents

opencode-format counterparts of the plugin's claude orchestrator crew
(`../agents/`). These carry the `vk-` prefix because opencode's global
`~/.config/opencode/agents/` dir is flat (no plugin namespace), so the prefix
disambiguates them from other plugins' agents — the same role the
`vibecrew-` prefix plays for the vibecrew crew-bundle.

| opencode (here) | claude counterpart (`../agents/`) |
|---|---|
| `vk-decider.md` | `decider.md` |
| `vk-intake.md` | `intake.md` |
| `vk-sweeper.md` | `orchestrator.md` |

These are **intentionally leaner** than the claude versions: opencode has a
different tool surface (no per-tool MCP name allowlist in frontmatter, no
`Skill` tool, no `${CLAUDE_PLUGIN_ROOT}`), so the claude agents' detailed
mechanics don't port verbatim. The behavioral guardrails are preserved; the
mechanism references are generic ("via the vibe-kanban MCP tools").

Deployed as symlinks by `skills sombrax` → `~/.config/opencode/agents/`.
