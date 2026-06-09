# sombrax-codex

Codex CLI helpers for Claude Code. Three skills that use [Codex CLI](https://github.com/openai/codex)
as an independent second reviewer alongside Claude.

## Skills

| Skill | Triggers on | What it does |
|-------|-------------|--------------|
| `codex-review` | "review my code", "codex review", "check my changes" | Runs an iterative code review of the current branch (diffed against a base branch) via `codex review`, applies fixes, and re-reviews until only minor findings remain. |
| `codex-review-plan` | "review the plan", "approve the plan", after plan mode | Has Codex review a Claude Code implementation plan (in `~/.claude/plans/`) for completeness, architecture fit, risks, and scope creep before you start coding. |
| `codex-advisor` | "which approach", "how should I architect", "help me decide" | Gets an architectural / algorithmic / debugging second opinion from Codex (read-only sandbox) when multiple viable approaches exist. |

Once installed, the skills namespace as `sombrax-codex:codex-review`,
`sombrax-codex:codex-review-plan`, and `sombrax-codex:codex-advisor`.

## Prerequisite

These skills shell out to the `codex` CLI, which must be installed and on your
`PATH`. If Codex is not installed, each skill **falls back to performing the
review/advice inline** using the same criteria — so they degrade gracefully, but
you lose the independent second perspective.

Verify Codex is available:

```bash
codex --version
```

## Installation

```bash
/plugin marketplace add dexloom/sombrax_plugins
/plugin install sombrax-codex@sombrax-plugins
```

## License

Apache-2.0
