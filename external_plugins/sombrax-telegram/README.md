# SombraX Telegram Channel for Claude Code

A multi-session Telegram channel plugin for Claude Code. Bridges Telegram groups (with forum topic routing) to multiple concurrent Claude Code sessions via a shared listener daemon.

## Architecture

```
                        Unix socket
  Telegram ──> listener.ts ──────────> server.ts (MCP) ──> Claude Code session 1 (topic 2)
                    │
                    └────────────────> server.ts (MCP) ──> Claude Code session 2 (topic 22)
                    │
                    └────────────────> server.ts (MCP) ──> Claude Code session 3 (all topics)
```

- **listener.ts** — standalone daemon that polls Telegram once and dispatches inbound messages to connected clients via Unix socket
- **server.ts** — MCP server spawned per Claude Code session. Connects to the listener in client mode. Outbound replies go directly via Bot API (no bottleneck)
- Multiple Claude sessions can handle different supergroup topics simultaneously

## Prerequisites

- [Bun](https://bun.sh) runtime
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- For group messages: disable bot privacy mode in BotFather (`/setprivacy` → Disabled)

## Installation

### From the SombraX marketplace

```bash
# Add the marketplace
/plugin marketplace add dexloom/sombrax_plugins

# Install the plugin
/plugin install sombrax-telegram@sombrax-plugins
```

### For development

```bash
git clone https://github.com/dexloom/sombrax_plugins.git
cd sombrax_plugins/external_plugins/sombrax-telegram
bun install
```

## Setup

### 1. Configure the bot token

```bash
mkdir -p ~/.claude/channels/telegram
echo "TELEGRAM_BOT_TOKEN=<your-token>" > ~/.claude/channels/telegram/.env
chmod 600 ~/.claude/channels/telegram/.env
```

Or use the built-in skill:

```
/telegram:configure <your-token>
```

### 2. Pair your Telegram account

DM your bot on Telegram. It replies with a 6-character pairing code. Approve it:

```
/telegram:access pair <code>
```

### 3. Add a supergroup

```
/telegram:access group add <group-id>
```

Options:
- `--no-mention` — deliver all messages (default requires @mention)
- `--allow id1,id2` — restrict to specific user IDs

### 4. Lock down access

Once all users are paired:

```
/telegram:access policy allowlist
```

## Usage

### Channel-reference forms

Claude Code accepts two forms for `--dangerously-load-development-channels`:

| Form | Use when |
|---|---|
| `plugin:sombrax-telegram:sombrax-telegram` | The plugin is installed via `/plugin install` (production). Claude reads the MCP server from the plugin's manifest. |
| `server:sombrax-telegram` | The MCP server is provided inline via a project `.mcp.json` (dev sandbox without installing the plugin). |

All the examples below show the `plugin:` form. Swap in `server:sombrax-telegram` if you're running from a local checkout with a project-level `.mcp.json`.

### Single session (standalone mode)

No listener needed. The MCP server polls Telegram directly:

```bash
claude --dangerously-load-development-channels plugin:sombrax-telegram:sombrax-telegram
```

### Multi-session with topic routing

#### Step 1: Start the listener daemon

```bash
cd <plugin-directory>
bun listener.ts
```

#### Step 2: Launch Claude sessions with topic routing

```bash
# Session for topic 2 (dev agent)
TELEGRAM_DEV=1 TELEGRAM_TOPIC=2 claude \
  --dangerously-load-development-channels plugin:sombrax-telegram:sombrax-telegram

# Session for topic 22 (dev agent)
TELEGRAM_DEV=1 TELEGRAM_TOPIC=22 claude \
  --dangerously-load-development-channels plugin:sombrax-telegram:sombrax-telegram

# Supervisor monitoring all topics (observer)
TELEGRAM_PROJECT_MANAGER=1 TELEGRAM_TOPIC=* claude \
  --dangerously-load-development-channels plugin:sombrax-telegram:sombrax-telegram
```

The listener resolves `TELEGRAM_CHAT_ID` from `access.json` (or its own env), so the agent process doesn't need it. See *Three-kind role model* in `REFACTORING_PLAN.md` for `TELEGRAM_DEV` / `TELEGRAM_PROJECT_MANAGER` / `TELEGRAM_PRODUCT_MANAGER`.

**Note:** When using the `server:` form, your project `.mcp.json` must pass through the env vars:

```json
{
  "mcpServers": {
    "sombrax-telegram": {
      "command": "bun",
      "args": ["run", "--cwd", "/path/to/plugin", "--shell=bun", "--silent", "start"],
      "env": {
        "TELEGRAM_CHAT_ID": "${TELEGRAM_CHAT_ID}",
        "TELEGRAM_TOPIC": "${TELEGRAM_TOPIC}"
      }
    }
  }
}
```

### Live dashboard (`--tui`)

With the listener daemon running, open an interactive terminal dashboard in a
second shell:

```bash
bun listener.ts --tui
```

The TUI is a thin client: it connects to the running daemon over the same
Unix socket, polls every 2s, and renders a live multi-view dashboard.
It never binds the socket or polls Telegram, so it is safe to run alongside
the daemon and auto-reconnects if the listener restarts.

**Views**

- **Main** — sessions table. Columns: folder (cwd) · session id (Claude
  `sessionId` when available, else the listener's client id) · branch
  (with `*` for a dirty working tree and `↑N`/`↓N` for upstream
  ahead/behind) · worktree (the path when running in a linked git
  worktree, else `-`) · MSG · PEND · UP.
- **Detail** — full per-session view plus pending permission requests with
  input preview; approve/deny inline without leaving the TUI.
- **Resume** — picker over `~/.claude/sessions/*.json` to resume a saved
  Claude session into a chat/topic.
- **Logs** — tail of `~/.claude/channels/telegram/server.log`.
- **Coverage** — sessions grouped by chat and topic, with recent dropped
  messages and a `⚠ overlap` marker when two sessions claim the same topic.

**Keys**

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move selection |
| `Enter` / `d` | Open detail for selected session; `Esc` / `d` to go back |
| `k` | Kill selected session (confirm `y/N`) |
| `r` | Restart selected session (confirm `y/N`) |
| `l` | Launch a new session — prompts for `chat_id`, `topic`, `cwd` with smart defaults |
| `R` | Open resume picker; `Enter` picks a saved session, then prompts for `chat_id` + `topic` |
| `L` | Toggle the log-tail view |
| `c` | Toggle the topic-coverage view |
| `/` | Filter (matches cwd / branch / chat / topic / id); `Esc` clears |
| `s` | Cycle sort field: `cwd` → `branch` → `uptime` → `pending` → `msgs` |
| `S` | Toggle sort direction |
| `a` / `D` | (detail view) Approve / deny the highlighted pending permission |
| `q` / Ctrl-C | Quit |

The TUI's actions (`kill_session`, `restart_session`, `launch_session`,
`resume_session`, `permission_respond`, `tail_logs`, `list_saved_sessions`)
are only honored on sockets that have **not** sent `register`, so connected
Claude clients cannot trigger them — only the TUI client can.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token (set in `~/.claude/channels/telegram/.env`) |
| `TELEGRAM_CHAT_ID` | For client mode | Supergroup chat ID (negative number with -100 prefix) |
| `TELEGRAM_TOPIC` | For client mode | Forum topic thread ID, comma-separated, or `all` |
| `TELEGRAM_STATE_DIR` | No | State directory (default: `~/.claude/channels/telegram`) |
| `TELEGRAM_LISTENER_SOCKET` | No | Unix socket path (default: `STATE_DIR/listener.sock`) |
| `TELEGRAM_ACCESS_MODE` | No | Set to `static` for read-only access control |
| `TELEGRAM_DEBUG` | No | Set to `1` for verbose debug logging |

## Telegram Bot Commands

Commands available in Telegram chats (handled by the listener):

| Command | Where | Description |
|---------|-------|-------------|
| `/new` | Group/topic | Reset the Claude session for the current topic |
| `/usage` | Group or DM | Show listener uptime and message stats |
| `/sessions` | Group or DM | List connected Claude sessions |
| `/start` | DM only | Pairing instructions |
| `/help` | DM only | Command reference |
| `/status` | DM only | Check pairing status |

## Skills

| Skill | Description |
|-------|-------------|
| `/telegram:access` | Manage access control — pair users, edit allowlists, set policies |
| `/telegram:configure` | Set up the bot token and review channel status |
| `/sombrax_telegram_channel` | Manage the listener daemon — start, stop, status, topics |

## Access Control

All access state lives in `~/.claude/channels/telegram/access.json`.

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["<user-id>"],
  "groups": {
    "<group-id>": {
      "requireMention": true,
      "allowFrom": ["<user-id>"]
    }
  },
  "ackReaction": "👀"
}
```

### Policies

| Policy | Behavior |
|--------|----------|
| `pairing` | Unknown DMs get a 6-char pairing code. Temporary — lock down after setup. |
| `allowlist` | Only `allowFrom` users can reach Claude. Recommended for production. |
| `disabled` | All inbound messages are silently dropped. |

### UX Settings

| Key | Values | Default | Description |
|-----|--------|---------|-------------|
| `ackReaction` | emoji or `""` | none | Emoji to react with on receipt |
| `replyToMode` | `off`, `first`, `all` | `first` | Which chunks get Telegram's reply reference |
| `textChunkLimit` | number | 4096 | Max chars per outbound message |
| `chunkMode` | `length`, `newline` | `length` | Split on paragraph boundaries or hard char count |

## Protocol (listener <-> server)

Newline-delimited JSON over Unix socket:

| Direction | Type | Fields |
|-----------|------|--------|
| Client -> Listener | `register` | `chat_id`, `topics` (array or "all") |
| Listener -> Client | `registered` | `id` |
| Listener -> Client | `inbound` | `chat_id`, `text`, `message_id`, `message_thread_id`, `user`, `ts`, attachments |
| Client -> Listener | `permission_request` | `request_id`, `tool_name`, `description`, `input_preview` |
| Listener -> Client | `permission_response` | `request_id`, `behavior` |
| Listener -> Client | `session_reset` | `chat_id`, `message_thread_id`, `user`, `user_id` |

## Troubleshooting

- **409 Conflict** — another process is polling with the same token. Only ONE process can poll per bot token (listener OR standalone server, not both). Kill zombie processes: `ps aux | grep bun | grep telegram`.
- **Socket not found** — listener isn't running. Start it first.
- **Messages not arriving** — check: (1) group is in access.json, (2) bot is mentioned if `requireMention` is true, (3) client registered for the correct chat_id + topic, (4) bot privacy disabled in BotFather.
- **Stale socket** — if listener crashed, delete: `rm ~/.claude/channels/telegram/listener.sock`
- **Debug mode** — set `TELEGRAM_DEBUG=1` for verbose logging to stderr and `~/.claude/channels/telegram/server.log`.

## Security

- Bot token stored with `chmod 600` permissions
- Access state locked to owner-only permissions
- Pairing codes expire after 1 hour (max 3 pending)
- Server refuses to send files from its own state directory
- Channel access mutations rejected if they arrive via Telegram messages (prompt injection defense)

## License

Apache-2.0
