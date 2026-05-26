# Refactoring Plan — Listener-Owned Channel Bus

> **Principle:** the **listener is the sole Telegram client**. It holds the bot token and
> makes *every* Bot API call (poll, send, files, react, edit, download, topic creation). An
> agent's `server.ts` is a pure Unix-socket client that holds **no token** (in CLIENT_MODE)
> and speaks only in opaque **channels**. vibe-kanban just names the channel (the git
> branch). Telegram is one human-facing façade on a multi-agent message bus.

## Status

| Phase | What | State |
|---|---|---|
| 1 | `publish` relay (client→listener fan-out + mirror) | ✅ done |
| 2 | Channel abstraction + roles (owner/observer) + chat-optional | ✅ done |
| 3 | VK spawn integration — inject channel name, tokenless | ✅ done (VK side) |
| 4 · Step 1 | Topic creation → listener (register-by-name) | ✅ done (plugin + VK) |
| **4 · Step 2** | **Files / react / edit / download → listener RPC; strip token** | ✅ **done** |
| **5** | **Three-kind role model (dev / project_manager / product_manager)** | ✅ **done** |

All phases listed here have landed. The principle holds end-to-end: in CLIENT_MODE,
`server.ts` makes **zero** `bot.api.*` calls. Every Telegram-side operation — including
new topic creation, file uploads, reactions, edits, downloads, and the polling itself —
runs in `listener.ts`.

---

## Current split (audit)

**Through the listener** (CLIENT_MODE):

| Concern | Listener entry point |
|---|---|
| Inbound polling | `listener.ts` `bot.start()` |
| Outbound text + chunking + reply-to + parse_mode | `listener.ts` `case 'publish'` |
| Forum topic creation / cached name → thread id | `listener.ts` `resolveTopicForChat` (`:875`), `loadTopicNames` (`:849`) |
| File upload (photo / document) | `listener.ts` `handleTgRequest` `send_file` (`:1356`) |
| Reactions | same — `op:'react'` |
| Edit message text | same — `op:'edit'` |
| Attachment download | same — `op:'download'` (writes into `INBOX_DIR`) |
| Permission keyboard / approvals | `listener.ts` permission relay |
| Pairing / DM approvals | `listener.ts` (the agent doesn't poll, so it can't see DMs) |

**Still `bot.api.*` from `server.ts`** — only in **standalone mode** (no listener). The
agent process there constructs `bot = new Bot(TOKEN)`; in CLIENT_MODE `bot = null`. The
`if (!CLIENT_MODE && !TOKEN)` guard at `server.ts:135` keeps the token requirement scoped
to standalone runs.

---

## Phase 4 · Step 1 — Topic creation → listener  *(done)*

### Code landings

**`listener.ts`**
- `TOPIC_NAMES_FILE = join(STATE_DIR, 'topic-names.json')` — listener owns the map
  `{ "<chat_id>": { "<name>": <thread_id> } }`.
- `loadTopicNames()` / `saveTopicNames()` (`:849`).
- `resolveTopicForChat(chatId, spec)` (`:875`) — returns cached numeric id, else calls
  `bot.api.createForumTopic(chat, name)` and persists. Returns `null` on failure.
- `applyRegister()` (`:1219`) — async; non-numeric specs go through `resolveTopicForChat`;
  numeric specs pass through; literal `'general'` is a sentinel (see Phase 5). Numeric
  thread ids land in `client.topics`. The `registered` reply (`:1339`) echoes the
  resolved `chat_id` AND numeric `topics`.

**`server.ts`**
- `resolveTopicId`, `TOPIC_NAMES_FILE`, the local `createForumTopic` call, and the
  *"TELEGRAM_CHAT_ID required for topic-name resolution"* guard are all **gone**.
- `register` sends the raw `TOPIC_FILTER` verbatim. Names allowed.
- The `'registered'` handler adopts `msg.topics` into `effectiveTopics`, used by
  `ownChannelId()` so `channel_send` defaults to the resolved thread.

### VK coordination

`crates/utils/src/telegram_topics.rs` is just `per_worktree_enabled()` and
`local-deployment/container.rs` injects **only**:

```
TELEGRAM_TOPIC=<branch>
TELEGRAM_DEV=1
```

…for Claude Code workspaces. `TELEGRAM_DEV=1` is the explicit signal that this
session is a dev agent (replaces the old "implicit dev by default" semantics —
see Phase 5). The branch name is what the listener resolves to a forum topic
thread; no token, no chat id, no Bot API call from VK's side.

The VK-side gate used to be `VK_TELEGRAM_PER_WORKTREE` / `per_worktree_topics`.
That feature flag still controls *whether* VK injects the env vars at all; it
just now injects `TELEGRAM_DEV=1` alongside `TELEGRAM_TOPIC` when it does.

---

## Phase 4 · Step 2 — Files / react / edit / download → listener  *(done)*

A small RPC over the existing socket. Both directions newline-delimited JSON:

| Direction | Type | Fields |
|---|---|---|
| Client → Listener | `tg_request` | `req_id`, `op` (`send_file`\|`react`\|`edit`\|`download`), `args` |
| Listener → Client | `tg_response` | `req_id`, `ok`, `result?` (e.g. `message_ids`, `path`, `message_id`), `error?` |

### Code landings

**`listener.ts`**
- `handleTgRequest(client, reqId, op, args)` (`:1356`) — async dispatcher.
- `case 'tg_request'` in `handleClientMessage` (`:1525`) — gated to registered clients
  (admins get `ok:false, error:'not registered'`).
- Per-op:
  - `send_file` → `sendPhoto` or `sendDocument` by extension; returns `message_ids[]`.
  - `react` → `setMessageReaction`; returns `ok:true`.
  - `edit` → `editMessageText` (optional `format:'markdownv2'`); returns `message_id`.
  - `download` → `getFile` + `fetch` + write into `INBOX_DIR`; returns `{ path }`.

**`server.ts`**
- `pendingRpc: Map<req_id, {resolve, reject, timer}>` (`:170`).
- `tgRequest(op, args, timeoutMs = 30_000)` (`:172`) — registers an entry,
  writes the frame, settles on the matching `tg_response`. Times out cleanly.
- `case 'tg_response'` handler (`:1060`) — looks up entry, clears timer, resolves
  or rejects.
- Each tool routes via `tgRequest` in CLIENT_MODE:
  - `channel_send` / `reply` files (the chunked text already routed via `publish`)
  - `react` (`:827`)
  - `edit_message` (`:868`)
  - `download_attachment` (`:844`)

### Tokenless CLIENT_MODE

- `if (!CLIENT_MODE && !TOKEN)` (`:135`) — token required only in standalone.
- `const bot: Bot | null = TOKEN_AVAILABLE ? new Bot(TOKEN!) : null` (`:214`).
- All remaining `bot.api.*` sites are inside `if (!listenerSocket || !myClientId)`
  branches (standalone fallback) or in the standalone polling block. `bot.stop()`
  in shutdown is null-safe.
- `checkApprovals`'s `setInterval` is gated on `!CLIENT_MODE` so its `bot.api.sendMessage`
  call site can't fire tokenless.

---

## Phase 5 — Three-kind role model  *(done)*

Loading the plugin in any session that happened to set `TELEGRAM_TOPIC` was claiming
`owner` status, which would have evicted the legitimate dev agent after the 60s cooldown.
The fix splits **role** (eviction semantics) from **kind** (what this session is *for*).

### Env-var surface

| Env | `kind` | `role` | Topic scope | Sees General? |
|---|---|---|---|---|
| `TELEGRAM_DEV=1` | `dev` | **owner** | `TELEGRAM_TOPIC` | only if `*`/`all` |
| `TELEGRAM_PROJECT_MANAGER=1` *(alias: `TELEGRAM_PM=1`)* | `project_manager` | observer | `TELEGRAM_TOPIC` (single, `*`, `all`) | only if `*`/`all` |
| `TELEGRAM_PRODUCT_MANAGER=1` | `product_manager` | observer | `TELEGRAM_TOPIC` **+ `general`** auto-spliced | **always** |
| (no kind flag) | `unknown` | observer | `TELEGRAM_TOPIC` | only if `*`/`all` |
| `TELEGRAM_ROLE=owner\|observer` | (kind unchanged) | overrides | — | — |

- **Dev agent**: the exclusive consumer of its channel; subject to the 60s
  eviction cooldown. `TELEGRAM_DEV=1` is the explicit, intentional signal — VK
  injects this when spawning per-worktree Claude Code sessions.
- **Project Manager**: monitors channels and orchestrates pipelines; never owns,
  never evicted. Scope = whatever `TELEGRAM_TOPIC` says.
- **Product Manager**: spawns project_manager agents with specific skills. Always
  watches the supergroup's General topic in addition to its scoped topic. Server.ts
  splices `'general'` into `TOPIC_FILTER` automatically.
- **No flag**: a session that happens to load the plugin but didn't ask to play
  any specific role. It joins as an observer with `kind=unknown` — listens to
  whatever `TELEGRAM_TOPIC` says, never claims ownership of anything. Safe default
  for ad-hoc shells.
- `TELEGRAM_ROLE` is the explicit escape hatch — wins over the kind flags, lets a
  PM demote itself or a dev session subordinate itself.

### Code landings

**`server.ts`**
- `DEV_FLAG`, `PROJECT_MANAGER_FLAG`, `PRODUCT_MANAGER_FLAG`, derived `KIND` (one of
  `'dev' | 'project_manager' | 'product_manager' | 'unknown'`).
- `ROLE` derived from explicit override → fallback to `KIND === 'dev' ? 'owner' : 'observer'`.
  No flag set → observer (`'unknown'` kind) — safest default for ad-hoc sessions.
- `PRODUCT_MANAGER_FLAG` splices `'general'` into `TOPIC_FILTER`.
- `register` payload sends both `role` and `kind`.
- `ownChannelId()` treats `'*'` identically to `'all'` — returns `undefined` under
  either wildcard, so PMs have no implicit home channel and must pass `to` explicitly
  on `channel_send`.

**`listener.ts`**
- `ClientConn.kind: ClientKind` (`'dev' | 'project_manager' | 'product_manager' | 'unknown'`).
- `ClientConn.monitorGeneral: boolean`.
- `applyRegister` (`:1219`):
  - Parses `'*'` identically to `'all'`.
  - Treats literal `'general'` in the topic list as a sentinel — never tries to
    `createForumTopic` for it; sets `monitorGeneral=true` instead. `'all'`/`'*'`
    implicitly covers general.
  - Parses `msg.kind`, validating against the union; unknown values land as
    `'unknown'`.
- `dispatchToClients` (`:1138`) delivers messages with no `message_thread_id` only to
  clients with `monitorGeneral===true`; existing numeric-topic matching is unchanged.
- `registered` reply echoes `kind` and `monitor_general` so the client can log them.

### Eviction guarantee

Only `owner`-vs-`owner` overlap triggers the 60s cooldown / replacement. Both PMs
are observers; both coexist with owners and with each other indefinitely.

---

## Invariants / caveats

- **Eviction is by design — add NO reconnection/eviction handling anywhere.** When a new
  owner claims a channel the listener disconnects the old agent and it stops receiving
  notifications; that is intended (one owner per channel).
- **Standalone mode** (no listener, `server.ts` polls directly) keeps its own `bot.api`
  path and token. Phase 4 only rewires **client mode**. `bot: Bot | null` is `null` in
  CLIENT_MODE and constructed only when standalone has a token.
- **Which copy runs** — multiple checkouts exist; the live listener and the agents'
  `server.ts` must be the authoritative copy or edits silently no-op.
- **409 Conflict** — one poller per token; restart the listener cleanly.
- **RPC correlation** — `tg_request`/`tg_response` are matched by `req_id`; the client
  table times out pending requests so a dropped listener doesn't hang a tool call.
- **Files are local paths** — listener and agents share the host, so the listener reads
  the path directly; no bytes over the socket.
- **General topic addressing** — messages in the supergroup's General topic arrive with
  no `message_thread_id`. Only clients that asked for `'general'` (or registered with
  `'all'`/`'*'`) receive them.
