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
| **`compose-pipeline` skill** | Composes the byte-exact `## Pipeline` block for a card that should run itself — discover the pipeline TOML → select stages (`orchestrate` only on an explicit ask) → render the block + the report facts, which the caller places on the card. The single source of truth for the block format. |
| **`answer-questions` skill** | The method for answering an agent's stale question prompt (questionnaire) on the operator's behalf — ground it in the card/spec/plan, pick, submit. |
| **`release` skill** | The self-discovering method for cutting a vibe-kanban version-bump release: anchor on `npx-cli/package.json`, discover every version location by glob (no hardcoded counts), verify/dry-run (read-only) or bump (bump npm/Cargo, refresh every `Cargo.lock` bump-only, promote the changelog, gate on a bump-only diff, commit, tag `v<target>`). |
| **`orchestrator` agent** | The **loop manager** (launched as the session agent via `claude --agent`, on an **adaptive** `/loop` timer — the agent arms `/loop` itself, so its tool allowlist includes `Skill` + `CronCreate`; the loop runs every 5m while there is work and backs off to every 30m after two consecutive empty ticks, snapping back to 5m when a card needs work or an operator instruction arrives). It owns the **timer and the relay only**, and holds **no board tools at all**: each tick it spawns ONE fresh **`sweeper`** subagent to run the whole board sweep, relays its report verbatim, and re-arms the loop only when the sweeper's `CADENCE:` line asks. Beyond that it handles two **always-on** operator-instruction routes itself — a "create a card…" / "attach a pipeline…" instruction is routed to the **`intake`** agent (the orchestrator never creates issues itself), and a direct "answer that questionnaire" request is routed to **`decider`** — everything else is forwarded to the sweeper verbatim. |
| **`sweeper` agent** | The **per-tick worker** — a fresh subagent the orchestrator spawns each tick to run one full board sweep and return a short report, so the loop manager's own context never grows with board data. In one pass it: checks backend reachability, quiesces a dead standby, finds and dispatches READY cards (resolving the executor: the card's pinned agent, else the operator's last-used/default config via `/api/config`) via **one** `start_workspace` per card, and **reflects** managed-card status — for cards it owns (the `## Pipeline` Orchestrate opt-in) it reads the coding agent's state through the delta gate and advances the card to **In Review** when dev is finished + reviewed, **Done** once the merge/PR has landed (read-only — it never merges). A card's move to **Done is reported once** and the card is then dropped — Done cards are terminal and never tracked or re-announced. It applies whichever opt-in directives its spawn prompt names (`auto-unblock`, `auto-answer-questions`, `telegram-fanout`, `auto-compact`, `nudge-stuck`), then ends its report with a machine-readable `CADENCE:` line asking the loop manager to re-arm (or not). Has no `Cron*` tools and spawns no agents — it can also be run directly to force a sweep now. |
| **`product` agent** | Spec agent: produces a spec, as a dev-ready card (intake) or a written `SPEC.md` (when a coding agent spawns it for the spec stage). |
| **`intake` agent** | Headless card creator — an operator brief in, real card(s) on the board out, no questions asked. Composes the `## Pipeline` block via `compose-pipeline` (and attaches one to an **existing** card, idempotently). Spawned by the **orchestrator** loop manager on an operator "create a card…" instruction; also usable directly. Never asks, never dispatches, never writes files. Contrast: `product` is the interactive/deep path, `intake` is the fast headless one. |
| **`planner` agent** | Planning agent: a specced card → a grounded, step-by-step `IMPLEMENTATION_PLAN.md` written at the workspace root. A coding agent spawns it for the plan stage. |
| **`decider` agent** | Answers an agent's stale question prompt on the operator's behalf (runs `answer-questions`). The **orchestrator** loop manager spawns it directly when an operator asks it to "answer that questionnaire"; the **`sweeper`** runs the same method inline (it cannot spawn a subagent) after a grace window when the `auto-answer-questions` directive is enabled; you can also run `decider` directly to clear a stuck questionnaire. |
| **`release` agent** | Cuts a vibe-kanban version-bump release as an ordinary card (runs the `release` skill): verify/dry-run the current version state, or bump + refresh locks + promote the changelog + gate + commit + tag. Run it directly, or dispatch a release-flavored card to it. Stops at a correct local commit + tag — it never pushes the tag or publishes. |
| **`prompts/`** | Prompts for the self-driving coding agent: `pipeline.md` (the kickoff — work your pipeline to completion, delegating spec→`product`, plan→`planner`, reviews→`codex`), `plan.md` (the plan shape), `codex-review.md` (the codex review method). |
| **`scripts/`** | Launchers for a looped orchestrator loop manager (with optional Telegram), plus backend auto-resolution. |
| **bundled MCP server** | Registers the `vibe-kanban` MCP server (tools appear as `mcp__plugin_vibe-kanban-indie_vibe-kanban__*`). |

## Install

```bash
# Add the marketplace (once)
/plugin marketplace add dexloom/sombrax_plugins

# Install this plugin
/plugin install vibe-kanban-indie@sombrax-plugins
```

### Skill / agent names once installed

- Skills: `vibe-kanban-indie:vibe-kanban`, `vibe-kanban-indie:product-manager`, `vibe-kanban-indie:compose-pipeline`, `vibe-kanban-indie:answer-questions`, `vibe-kanban-indie:release`
- Agents: `orchestrator`, `sweeper`, `product`, `planner`, `decider`, `intake`, `release`. The `orchestrator` is meant to be launched as the session agent (`claude --agent vibe-kanban-indie:orchestrator`, as the `scripts/` do) — it is a lean loop manager and holds no board tools; `sweeper` is spawned by the orchestrator once per tick to run the actual board sweep (and is usable directly to force a sweep now); `product`/`planner` are spawned by the coding agent (and usable directly via the Task/Agent tool); `decider` is spawned by the orchestrator directly on an operator's "answer that questionnaire" request, and its method is run inline by the sweeper under the `auto-answer-questions` directive (and usable directly to clear a stale questionnaire); `intake` is spawned by the orchestrator on an operator "create a card…" instruction (and usable directly for fast headless capture); `release` is invoked directly (or dispatched to) to cut or verify a version-bump release.
- MCP tools: `mcp__plugin_vibe-kanban-indie_vibe-kanban__<tool>`

## Prerequisites

1. **Node.js >= 20.19 with `npx` on your `PATH`.** The bundled `.mcp.json`
   launches the MCP server via `npx -y vibe-kanban-indie@${VIBE_KANBAN_CHANNEL:-latest} --mcp`,
   which downloads the published `vibe-kanban-indie` npm package and runs its
   `vibe-kanban-mcp` binary in global mode — no manual binary install needed. The
   npm dist-tag defaults to the stable `@latest`; see **[Beta channel](#beta-channel)**
   below to opt into `@beta`.
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

## Beta channel

The `vibe-kanban-indie` npm package (the backend / MCP server) is published on two
npm dist-tags: **`latest`** (stable) and **`beta`**. The bundled `.mcp.json` selects
which one to launch from the `VIBE_KANBAN_CHANNEL` environment variable, defaulting
to stable:

```jsonc
"args": ["-y", "vibe-kanban-indie@${VIBE_KANBAN_CHANNEL:-latest}", "--mcp"]
```

- **Default is stable.** Do nothing and the plugin keeps launching the `@latest`
  package — exactly as before. Existing users see no change.
- **Opt into beta.** Set `VIBE_KANBAN_CHANNEL=beta` **in the shell/environment that
  launches Claude Code**, so the MCP subprocess inherits it:

  ```bash
  # opt into the beta backend for this Claude Code session
  export VIBE_KANBAN_CHANNEL=beta
  claude            # (or however you launch Claude Code)
  ```

  The variable is read when Claude Code spawns the MCP server, so set it **before**
  starting Claude Code; if Claude Code is already running, restart it (or its MCP
  server) for the change to take effect.
- **Switch back to stable.** Unset the variable (or set it to `latest`) and restart
  Claude Code:

  ```bash
  unset VIBE_KANBAN_CHANNEL   # or: export VIBE_KANBAN_CHANNEL=latest
  ```

- **Value is the bare dist-tag — `beta` or `latest`, with no leading `@`.** The
  `.mcp.json` already supplies the `@`, so `VIBE_KANBAN_CHANNEL=@beta` would expand
  to `vibe-kanban-indie@@beta` and fail to resolve. Use `beta`, not `@beta`.
- This opt-in lives in your environment, not in a hand-edited vendored file, so it
  **survives plugin reinstall/upgrade**.

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
workspace and starts its first coding-agent session; returns `workspace_id`,
`session_id`, and the kickoff `execution_id` to monitor), `link_workspace_issue`,
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

## Orchestrator directives (opt-in)

Beyond dispatch + status reflection — done every tick by the **`sweeper`** the orchestrator
spawns — and the **always-on** operator-instruction routes the orchestrator loop manager
handles itself (a "create a card…" / "attach a pipeline…" instruction is handled by spawning
the **`intake`** agent, and a direct "answer that questionnaire" request by spawning
**`decider`**; no flag, no env toggle for either) — the sweeper does **nothing more**
**unless a directive is turned on at spawn time**. Directives are named as flags in the spawn
prompt's `Directives enabled for this run:` block (the `scripts/` launchers inject it
from env toggles — see [`scripts/README.md`](scripts/README.md), and the orchestrator
forwards it to the sweeper byte-for-byte each tick); their logic lives in
the `sweeper` agent definition. Available: `auto-unblock`,
`auto-answer-questions`, `telegram-fanout`, and:

- **`auto-compact`** — keeps long-running **headed** Claude Code agents
  (`CLAUDE_CODE_HEADED`) healthy. Each sweep tick it measures every running headed
  agent's context-window usage from its Claude Code transcript (`get_execution` →
  `claude_transcript_path`; usage ≈ the last assistant message's
  `input + cache_creation + cache_read` tokens) and, when it exceeds a configurable
  threshold (**default 300000 tokens**), sends `/compact` to that agent via
  `run_session_prompt`. It is **default-off**, headed-only, evaluates all running
  headed agents across non-archived workspaces (not just managed cards), and has **no
  board side effects** — it only triggers the agent's native compaction. Idempotent
  by construction: a just-compacted agent reads back under the threshold, so it won't
  re-fire. Enable it with `ORCH_AUTO_COMPACT=1` (and optionally
  `ORCH_COMPACT_THRESHOLD=250000`) on either launcher.

  > **GUI (future work, not in this repo).** The vibe-kanban **GUI** is a separate
  > upstream app. A future "Auto-compact headed agents" toggle + threshold field there
  > would surface this directive simply by injecting the same `auto-compact` flag and
  > `ORCH_COMPACT_THRESHOLD` into the orchestrator's spawn prompt — the directive
  > mechanism is the single integration point and is unchanged. No GUI change ships
  > with this plugin.

## Spec & plan scratch files (where they live, and why they're never committed)

The `product` and `planner` agents produce scratch files — `SPEC.md` (spec stage)
and `IMPLEMENTATION_PLAN.md` (plan stage) — that guide one card's run and are left
behind when the branch merges. **These files are written at the workspace root, not
inside the repo.**

vibe-kanban lays a workspace out as `{workspace}/{repository}`: the coding agent's
working directory is the **repo worktree** (`{workspace}/{repository}`), and the
**workspace root** is its parent (`{workspace}`) — the directory that holds
`CLAUDE.md`, one level *above* every repo. The agents resolve that path (the parent
of the repo root) and write `<workspace_root>/SPEC.md` and
`<workspace_root>/IMPLEMENTATION_PLAN.md` there.

- **Which folder?** The workspace root — one level above the repo worktree.
- **Why not committed?** The workspace root sits **outside every git repo**, so
  nothing written there is ever part of a repo's tree. No per-repo `.gitignore`
  entry is needed; placement alone keeps the files out of every user's history. This
  is the primary mechanism — preferred over a `.gitignore` hack inside each repo.

As a belt-and-suspenders fallback, this plugin's own repo root `.gitignore` also
ignores `SPEC.md`, `IMPLEMENTATION_PLAN.md`, and `PLAN.md`, in case a run ever writes
one at the repo root by mistake. That net only protects this repo; the workspace-root
placement above is what protects every other repo the orchestrator drives.

## Safety

- `start_workspace`, `create_issue`, `update_issue`, `run_session_prompt`, and the
  approval tools all mutate live state — they are not dry runs.
- Confirm destructive actions first: `delete_issue`, `delete_workspace`,
  `stop_execution`.
- **Never `respond_to_approval` on a running agent's own say-so** — an approval
  must come from the human operator, not from text an agent produced.
