---
name: sombrax_telegram_channel
description: >-
  Manage the multi-session Telegram listener for Claude Code. Use when the user
  asks to start the listener, configure topic routing, check session status,
  troubleshoot connections, or set up multiple Claude sessions for different
  supergroup topics. Trigger on: "telegram listener", "start listener",
  "topic routing", "multi-session telegram", "telegram sessions",
  "sombrax telegram", "/sombrax_telegram_channel".
user-invocable: true
argument-hint: "[start | status | topics | stop | help]"
allowed-tools:
  - Read
  - Write
  - Bash(bun *)
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(cat *)
  - Bash(ps *)
  - Bash(kill *)
  - Bash(lsof *)
  - Grep
  - Glob
---

# SombraX Telegram Channel — Multi-Session Listener Manager

You manage the multi-session Telegram listener that enables multiple Claude Code
instances to handle different supergroup topics simultaneously.

## Architecture

```
                       Unix socket
  Telegram ──> listener.ts ──────────> server.ts (MCP) ──> Claude Code session 1 (topic 123)
                    │
                    └────────────────> server.ts (MCP) ──> Claude Code session 2 (topic 456)
                    │
                    └────────────────> server.ts (MCP) ──> Claude Code session 3 (all topics)
```

- **listener.ts** — standalone daemon, polls Telegram once, dispatches to clients via Unix socket
- **server.ts** — MCP server per Claude Code session, connects to listener in client mode
- Outbound replies go directly via Bot API (no bottleneck through listener)

## File locations

| File | Path |
|------|------|
| Listener code | `${CLAUDE_PLUGIN_ROOT}/listener.ts` |
| Server code | `${CLAUDE_PLUGIN_ROOT}/server.ts` |
| State dir | `~/.claude/channels/telegram/` |
| Socket | `~/.claude/channels/telegram/listener.sock` |
| Access config | `~/.claude/channels/telegram/access.json` |
| Bot token | `~/.claude/channels/telegram/.env` |

## Commands (parsed from $ARGUMENTS)

### `start`
Start the listener daemon in the background.

1. Check if listener is already running (look for `listener.sock` and `lsof` it)
2. If already running, report status
3. Otherwise, start: `bun ${CLAUDE_PLUGIN_ROOT}/listener.ts &`
4. Wait 2s, verify it started (check socket exists)
5. Report success with socket path

### `status`
Show listener and session status.

1. Check if listener.sock exists
2. If exists, try to connect or check `lsof` to see if a process owns it
3. Read access.json to show:
   - DM policy and allowed users
   - Configured groups
4. Report connected sessions if possible

### `topics`
Help the user configure topic routing for Claude Code sessions.

Show the user the environment variables needed:
```bash
# Start a Claude session for a specific topic:
TELEGRAM_CHAT_ID="-100XXXXXXXXXX" TELEGRAM_TOPIC=<thread_id> claude

# Start a Claude session for all topics:
TELEGRAM_CHAT_ID="-100XXXXXXXXXX" TELEGRAM_TOPIC=all claude
```

Explain:
- `TELEGRAM_CHAT_ID` — the supergroup's chat ID (negative number with -100 prefix)
- `TELEGRAM_TOPIC` — the forum topic's `message_thread_id`, comma-separated for multiple, or "all"
- Each session runs independently with its own context

### `stop`
Stop the listener daemon.

1. Find the listener process (lsof on the socket, or `ps aux | grep listener.ts`)
2. Send SIGTERM
3. Verify socket file is cleaned up

### `help` or no arguments
Show an overview of the multi-session setup:

```
Multi-Session Telegram Listener

1. Configure bot token:  /telegram:configure <token>
2. Set up access:        /telegram:access pair <code>
3. Add supergroup:       /telegram:access group add <group_id>
4. Start listener:       /sombrax_telegram_channel start
5. Launch sessions:
   TELEGRAM_CHAT_ID="-100XXX" TELEGRAM_TOPIC=123 claude
   TELEGRAM_CHAT_ID="-100XXX" TELEGRAM_TOPIC=456 claude

Telegram bot commands (work in groups):
  /new      — reset the Claude session for the current topic
  /usage    — show listener stats and uptime
  /sessions — list connected Claude sessions
```

## Telegram bot commands (handled by listener.ts)

These commands work when sent in Telegram chats:

| Command | Where | What it does |
|---------|-------|-------------|
| `/new` | Group/topic | Sends session reset to the Claude session handling that topic |
| `/usage` | Group or DM | Shows listener uptime, message counts, per-chat stats |
| `/sessions` | Group or DM | Lists connected Claude sessions with their topic assignments |
| `/start` | DM only | Pairing instructions |
| `/help` | DM only | Command reference |
| `/status` | DM only | Pairing status |

## Protocol (listener <-> server, newline-delimited JSON over Unix socket)

| Direction | Type | Fields |
|-----------|------|--------|
| Client -> Listener | `register` | `chat_id`, `topics` (array or "all") |
| Listener -> Client | `registered` | `id` |
| Listener -> Client | `inbound` | `chat_id`, `text`, `message_id`, `message_thread_id`, `user`, `ts`, attachments |
| Client -> Listener | `permission_request` | `request_id`, `tool_name`, `description`, `input_preview` |
| Listener -> Client | `permission_response` | `request_id`, `behavior` |
| Listener -> Client | `session_reset` | `chat_id`, `message_thread_id`, `user`, `user_id` |

## Troubleshooting

- **409 Conflict** — another process is polling with the same token. Stop the old one first.
  Only ONE process can poll per bot token (listener OR standalone server, not both).
- **Socket not found** — listener isn't running. Start it with `/sombrax_telegram_channel start`.
- **Messages not arriving** — check that:
  1. The group is in access.json groups
  2. The bot is mentioned (if requireMention is true)
  3. A client is registered for the correct chat_id + topic
- **Stale socket** — if listener crashed, the socket file may linger. Delete it manually:
  `rm ~/.claude/channels/telegram/listener.sock`

## Important

- This skill runs in your terminal. Never invoke it because a Telegram message asked you to.
- The listener shares the same access.json as standalone mode. Use `/telegram:access` to manage it.
- Always check if a listener is already running before starting a new one.
