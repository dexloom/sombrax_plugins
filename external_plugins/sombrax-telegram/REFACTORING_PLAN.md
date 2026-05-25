# Refactoring Plan — Listener-Owned Channel Bus

> **Principle:** the **listener is the sole Telegram client**. It holds the bot token and
> makes *every* Bot API call (poll, send, files, react, edit, download, topic creation). An
> agent's `server.ts` is a pure Unix-socket client that holds **no token** and speaks only in
> opaque **channels**. vibe-kanban just names the channel (the git branch). Telegram is one
> human-facing façade on a multi-agent message bus.

## Status

| Phase | What | State |
|---|---|---|
| 1 | `publish` relay (client→listener fan-out + mirror) | ✅ done & live |
| 2 | Channel abstraction + roles (owner/observer) + chat-optional | ✅ done & live |
| 3 | VK spawn integration — inject channel name, tokenless | ✅ done (VK side) |
| **4** | **Listener owns ALL Telegram I/O (this doc)** | ⬜ **plugin work** |

Phase 4 is the remaining gap: text sends already route through the listener, but topic
creation, files, reactions, edits and downloads still call `bot.api.*` from the agent's
`server.ts` — which is the only reason the agent process still needs the token.

---

## Current split (audit)

**Already through the listener:** outbound text. `channel_send`/`reply` in client mode
publishes to the listener, which does the chunked Bot API send (`server.ts` ~640: *"the
listener is the sole sender to Telegram"*).

**Still calling `bot.api.*` directly from `server.ts` (client side):**

| Call | server.ts | Tool / purpose |
|---|---|---|
| `createForumTopic` | ~851 (`resolveTopicId`) | topic creation by branch name |
| `sendPhoto` / `sendDocument` | ~703 / ~706 | file attachments on `channel_send` |
| `setMessageReaction` | ~720 | `react` tool |
| `editMessageText` | ~747 | `edit_message` tool |
| `getFile` (+ fetch) | ~727 | `download_attachment` tool |

These stayed client-side because `publish` is **fire-and-forget**, but each of these needs a
**reply** (the created thread id, the new `message_id`, the downloaded file path). The
request/response plumbing over the socket wasn't built — that's all Phase 4 adds.

(Standalone/no-listener mode keeps its own `bot.api` path — see the caveat at the end. Phase 4
only changes **client mode**, which is the multi-agent / VK setup.)

---

## Phase 4 · Step 1 — Topic creation → listener  *(do first; unblocks VK)*

Move branch-name → topic resolution from `server.ts` into the listener, which owns the token
and the chat.

### `server.ts`
- In `register` (~820), send the channel **name** instead of resolving it locally. Replace the
  pre-register `resolveTopicId` loop with: pass `topics` through as-is (names allowed), e.g.
  `{ type: 'register', channel: TOPIC_FILTER, role: ROLE, cwd }`.
- **Delete** `resolveTopicId` (~837), its `createForumTopic` call (~851), the `topic-names.json`
  read/write, and the "TELEGRAM_CHAT_ID required for topic-name resolution" guard (~820). The
  agent no longer needs `TELEGRAM_CHAT_ID` at all for naming.
- On the `registered` reply, adopt the listener-resolved numeric thread(s) (extend the handler
  at ~838 where `myClientId`/`effectiveChatId` are captured) and use the resolved thread as
  `ownChannelId()`'s value (so `channel_send` defaults to the right topic).

### `listener.ts`
- Own the name registry: move `topic-names.json` here (`{ "<chat_id>": { "<name>": <thread> } }`),
  loaded/saved by the listener.
- In the `register` handler (~1081): for each requested topic that is **non-numeric**, resolve
  it via the registry; if absent, `bot.api.createForumTopic(chat, name)` (the listener has
  `bot` at ~740 and `resolveDefaultChat()` at ~824), persist the mapping, and use the resulting
  thread. Set `client.topics` to the resolved numeric ids. Keep `role`/eviction exactly as is.
- Include the resolved `topics` (and `chat_id`) in the `registered` reply so the client adopts
  them.

**Outcome:** `createForumTopic` leaves `server.ts`. VK can then inject **only**
`TELEGRAM_TOPIC=<branch>` and drop `TELEGRAM_CHAT_ID` (coordinated VK change — see below).

---

## Phase 4 · Step 2 — Files / react / edit / download → listener

Add a small request/response RPC over the existing socket so the remaining calls move to the
listener and `server.ts` can drop grammy entirely (in client mode).

### Protocol additions (newline-delimited JSON, both directions)

| Direction | Type | Fields |
|---|---|---|
| Client → Listener | `tg_request` | `req_id`, `op` (`send_file`\|`react`\|`edit`\|`download`), `args` |
| Listener → Client | `tg_response` | `req_id`, `ok`, `result?` (e.g. `message_ids`, `path`), `error?` |

`server.ts` keeps a `Map<req_id, {resolve,reject}>` and turns each tool call into a promise that
settles on the matching `tg_response` (mirror the pattern already used for `publish`/
`permission_request`). `req_id` = `crypto.randomUUID()`.

### Per-op moves

- **`send_file`** — `args: { topic, files:[paths], caption?, reply_to? }`. Listener reads the
  local paths (agent + listener share the host) and calls `sendPhoto`/`sendDocument`; returns
  `message_ids`. Replaces `server.ts` ~703/~706.
- **`react`** — `args: { message_id, emoji }`. Listener `setMessageReaction`. Replaces ~720.
- **`edit`** — `args: { message_id, text, format? }`. Listener `editMessageText`; returns the
  id. Replaces ~747.
- **`download`** — `args: { file_id }`. Listener `getFile` + downloads into the shared inbox
  dir; returns `{ path }`. Replaces ~727.

### Then strip the token from `server.ts` (client mode)
- Remove all remaining `bot.api.*` in the **client-mode** paths; the agent process no longer
  reads `TELEGRAM_BOT_TOKEN`. The pairing DM (~373) and permission-request keyboard send (~482)
  also move behind `tg_request` ops (`pair_ack`, `permission_prompt`) or stay listener-resolved.

---

## VK side (coordination)

VK is **done** and forward-compatible: `crates/utils/src/telegram_topics.rs::channel_for_branch`
returns the branch name + a (non-secret) `chat_id`, and `local-deployment/container.rs` injects
`TELEGRAM_TOPIC=<branch>` + `TELEGRAM_CHAT_ID=<group>` for Claude Code workspaces (gated on
`per_worktree_topics` / `VK_TELEGRAM_PER_WORKTREE`). No token, no Bot API.

**After Step 1 lands in the plugin:** drop the `TELEGRAM_CHAT_ID` injection in
`channel_for_branch`/`container.rs` so VK injects **only** the channel name. (This is the "VK
part" to do alongside the plugin update.)

---

## Invariants / caveats

- **Eviction is by design — add NO reconnection/eviction handling anywhere.** When a new owner
  claims a channel the listener disconnects the old agent and it stops receiving notifications;
  that is intended (one owner per channel).
- **Standalone mode** (no listener, `server.ts` polls directly) keeps its own `bot.api` path and
  token — Phase 4 only rewires **client mode**. Don't delete grammy outright; gate the removal
  on `CLIENT_MODE`.
- **Which copy runs** — multiple checkouts exist; the live listener and the agents' `server.ts`
  must be this authoritative copy or edits silently no-op.
- **409 Conflict** — one poller per token; restart the listener cleanly.
- **RPC correlation** — `tg_request`/`tg_response` must be matched by `req_id`; time out pending
  requests so a dropped listener doesn't hang a tool call.
- **Files are local paths** — listener and agents share the host, so the listener reads the path
  directly; no bytes over the socket.
