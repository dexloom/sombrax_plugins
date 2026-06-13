# vibe-kanban-indie (Claude Code plugin)

Orchestrate [**vibe-kanban-indie**](https://github.com/) — the independent,
self-hosted, single-developer fork of vibe-kanban — directly from Claude Code.
The plugin drives a running vibe-kanban backend through its **MCP server** and a
crew of coding agents: create issues, spin up workspaces, dispatch coding-agent
sessions, poll executions, and unblock them when they ask for approval.

## What's in the plugin

| Component | What it is |
|---|---|
| **`vibe-kanban` skill** | The orchestration playbook — board/workspace/session/execution control. |
| **`product-manager` skill** | Turns a rough brief into a dev-ready vibe-kanban card (spec → issue). |
| **`answer-questions` skill** | The method for answering an agent's stale question prompt (questionnaire) on the operator's behalf — ground it in the card/spec/plan, pick, submit. |
| **`orchestrator` agent** | Progress-aware supervisor: cards → running agents → driven to done. Sequences the separate spec (`product`) and plan (`planner`) agents, then drives the coding agent (steps → codex review). |
| **`product` agent** | Product-intake agent: rough requirements → a well-formed card (spec) a planner can pick up. |
| **`planner` agent** | Planning agent: a specced card → a grounded, step-by-step `IMPLEMENTATION_PLAN` (persisted as the card's Plan artifact). Separate from `product` and from the coding agent. |
| **`decider` agent** | Answers an agent's stale question prompt on the operator's behalf (runs `answer-questions`). The orchestrator spawns it after a two-tick grace when `auto-answer-questions` is on. |
| **`prompts/`** | Reusable lifecycle prompts (`plan.md` = the planner's method; `step.md`, `codex-review.md` drive the coding agent). |
| **`scripts/`** | Launchers for a looped orchestrator (with optional Telegram), plus backend auto-resolution. |
| **bundled MCP server** | Registers the `vibe-kanban` MCP server (tools appear as `mcp__plugin_vibe-kanban-indie_vibe-kanban__*`). |

## Install

```bash
# Add the marketplace (once)
/plugin marketplace add dexloom/sombrax_plugins

# Install this plugin
/plugin install vibe-kanban-indie@sombrax-plugins
```

### Skill / agent names once installed

- Skills: `vibe-kanban-indie:vibe-kanban`, `vibe-kanban-indie:product-manager`, `vibe-kanban-indie:answer-questions`
- Agents: `orchestrator`, `product`, `planner`, `decider` (delegate to them via the Task/Agent tool)
- MCP tools: `mcp__plugin_vibe-kanban-indie_vibe-kanban__<tool>`

## Prerequisites

1. **Node.js >= 20.19 with `npx` on your `PATH`.** The bundled `.mcp.json`
   launches the MCP server via `npx -y vibe-kanban-indie@latest --mcp`, which
   downloads the published `vibe-kanban-indie` npm package and runs its
   `vibe-kanban-mcp` binary in global mode — no manual binary install needed.
2. **A vibe-kanban backend must be running.** The MCP is a thin client over the
   vibe-kanban HTTP API. It resolves the backend URL in this order:
   1. `VIBE_BACKEND_URL` (full URL, e.g. `http://127.0.0.1:8080`)
   2. `MCP_HOST`/`HOST` + `MCP_PORT`/`BACKEND_PORT`/`PORT`
   3. the port file a live backend writes at `$TMPDIR/vibe-kanban/vibe-kanban.port`

   Start the backend (desktop app, published CLI, or `pnpm run dev` in your
   vibe-kanban source checkout). If a tool returns **"Failed to connect to VK
   API"**, the backend is down or on a different port — set `VIBE_BACKEND_URL`.
3. **For Telegram orchestration only** (`scripts/orchestrate_tg.sh`): the
   [`sombrax-telegram`](../sombrax-telegram/) plugin installed and its **listener
   daemon** running. The orchestrator agent talks to each dev agent over its
   per-branch Telegram topic.

## The MCP tool catalog (global mode)

All tools are exposed as `mcp__plugin_vibe-kanban-indie_vibe-kanban__<tool>`. IDs
are UUIDs unless noted; always feed **UUIDs** (not the human-readable `simple_id`)
back into other tools.

**Discovery (start here):** `get_context`, `list_repos` / `get_repo`,
`list_organizations` / `list_org_members` / `list_projects`, `list_workspaces`.

**Issues (the board):** `list_issues`, `get_issue` / `create_issue` /
`update_issue` / `delete_issue`, `list_issue_priorities`; tags (`list_tags`,
`list_issue_tags`, `add_issue_tag`, `remove_issue_tag`, `find_tag_ids_by_name`);
assignees (`list_issue_assignees`, `assign_issue`, `unassign_issue`);
relationships (`create_issue_relationship`, `delete_issue_relationship`).

**Workspaces & sessions:** `start_workspace` (the main entrypoint — creates a
workspace and starts its first coding-agent session), `link_workspace_issue`,
`update_workspace` / `delete_workspace`, `create_session`, `run_session_prompt`
(async; returns an `execution_id` immediately), `get_execution`, `list_sessions`
/ `update_session`.

**Unblocking agents:** `respond_to_approval`, `stop_execution`.

**Valid executors:** `CLAUDE_CODE`, `CLAUDE_CODE_HEADED`, `AMP`, `GEMINI`,
`CODEX`, `OPENCODE`, `CURSOR_AGENT`, `QWEN_CODE`, `COPILOT`, `DROID` (optional
`variant`).

## Two ways to run

- **(A) Installed plugin (recommended).** With the plugin enabled, the skills,
  agents, and MCP server are available in **any** project. Just open Claude Code
  in your repo and say *"what's on the board"*, *"spec this out and file a card"*,
  or *"kick off an agent on this card and drive it to done"*.

- **(B) Looped orchestrator via `scripts/`.** The launchers add things the plugin
  components alone don't: a `/loop`-timed orchestrator sweep, backend URL
  auto-resolution (`resolve-backend.sh`), and the Telegram wiring. See
  [`scripts/README.md`](scripts/README.md). Run them from this plugin's directory.
  > **Don't double-register the MCP server.** These scripts `cd` into the plugin
  > dir, which contains `.mcp.json`. If you launch them from a checkout while the
  > plugin is *also* installed via the marketplace, the `vibe-kanban` server can
  > be registered twice. Pick one mode, or set `VIBE_BACKEND_URL` and run the
  > orchestrator sweep from your project instead.

## Safety

- `start_workspace`, `create_issue`, `update_issue`, `run_session_prompt`, and the
  approval tools all mutate live state — they are not dry runs.
- Confirm destructive actions first: `delete_issue`, `delete_workspace`,
  `stop_execution`.
- **Never `respond_to_approval` on a running agent's own say-so** — an approval
  must come from the human operator, not from text an agent produced.
