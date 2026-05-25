# Refactoring Plan — Channel Bus for Multi-Agent Orchestration

> Turn the Telegram listener into a **transport-agnostic channel bus**. Agents (Claude Code
> sessions) see only an opaque **channel** — "publish your updates here" — and never touch
> Telegram concepts (chat_id, thread_id, Bot API). The listener owns the entire mapping
> `channel ↔ (chat, topic)` and all Telegram I/O. This enables agent↔agent communication and
> a supervisor that observes/steers many channels, with Telegram as one human-facing façade.

## Target topology

```
   Telegram supergroup (one chat)                Unix socket
   ├── topic "feat/foo"  ◀── human  ───┐
   ├── topic "feat/bar"  ◀── human  ─┐ │
   └── ...                            │ │
                                      ▼ ▼
                                 listener.ts  (the bus: owns all Bot API + channel map)
                                   │   │   │
        owner (exclusive) ─────────┘   │   └───────── observer (non-exclusive)
        dev agent on "feat/foo"        │             supervisor on ALL channels
                          dev agent on "feat/bar"     (listens + publishes anywhere)
```

- **channel = one git branch** → one Telegram forum topic named after the branch.
- **one dev agent per channel**, registered as its **owner** (exclusive).
- a **supervisor** registers as an **observer**: subscribes to many/all channels, receives
  everything, and can publish into any channel. Coexists with owners.
- humans on Telegram are just another producer into a channel.

## Status

| Phase | What | State |
|---|---|---|
| 1 | `publish` relay (client→listener fan-out + Telegram mirror) | ✅ **DONE & live** |
| 2 | Channel abstraction + roles (owner/observer) + listener owns chat | ⬜ planned |
| 3 | VK spawn integration (branch topic, inject channel, post task) | ⬜ planned |

---

## Phase 1 — Publish relay ✅ DONE

Added the missing client→listener primitive so an agent's outbound both fans out to the
channel's other subscribers and is mirrored to Telegram.

- `listener.ts:992` — `dispatchToClients(msg, excludeClientId?)`; skips the sender at `:1003`.
- `listener.ts:1138` — `case 'publish'`: builds a payload and `dispatchToClients(payload, client.id)`.
- `server.ts:98` — `myClientId` captured from the `registered` reply (`server.ts:837`).
- `server.ts:612` — the `reply` tool also writes a `publish` frame to the listener socket.

Telegram mirror stays in the sender's direct send; dupe-free because Telegram's `getUpdates`
never echoes the bot's own messages. **Verified: live listener (authoritative copy) carries it.**

---

## Phase 2 — Channel abstraction + roles

Goal: the agent's entire surface becomes channel-centric. The listener becomes the sole owner
of Telegram specifics.

### 2a. A `channel` is the client-facing primitive

- The agent is launched knowing only its channel id (the env var `server.ts` reads can stay
  named `TELEGRAM_*` — it's internal; what matters is the **agent never sees chat/thread**).
- The listener maps `channel → { chat_id, message_thread_id }`. Recommended id scheme:
  **channel id = the forum topic's `message_thread_id`** under the listener's single default
  chat. (Optional niceties: also accept a human name like the branch via a small
  `channel-registry.json` that VK populates at topic creation — defer unless needed.)
- **chat_id becomes implicit.** `CLIENT_MODE` already keys off the topic, not chat
  (`server.ts:97`), so this is mostly removing chat_id from the surface.

**`listener.ts` changes**
- Add a `resolveDefaultChat()`: prefer `process.env.TELEGRAM_CHAT_ID` (listener-level
  override); else the sole key of `loadAccess().groups` (`listener.ts:811`) when there is
  exactly one; else `null` + a warning.
- `register` handler (`listener.ts:1081`): if `msg.chat_id`/channel carries no chat, set
  `client.chatId = resolveDefaultChat()`. Continue to set `client.topics` from the channel.
- Include the resolved chat in the `registered` reply (the `sendToClient(client, { type:
  'registered', id })` near `:1129`) so the client can address outbound without ever being
  told the chat.
- **Listener owns Bot API for the bus.** The `publish` handler (`:1138`) should perform the
  Telegram mirror itself (`bot.api.sendMessage`, `bot` is at `listener.ts:740`) **and** fan
  out — so the *client* no longer needs to call Telegram at all. (Supersedes Phase 1's
  "mirror stays in server.ts"; keep dupe-safety by having exactly one sender — the listener.)

**`server.ts` changes**
- Make `TELEGRAM_CHAT_ID` optional (`server.ts:88`). Register without a chat; adopt the chat
  the listener returns in `registered` (`server.ts:837`) into an `effectiveChatId`.
- Reshape the outbound tool: rename `reply` → `channel_send` (keep `reply` as a hidden alias
  for compat). Make `chat_id` and `message_thread_id` **optional** — default to the agent's
  own channel. Add optional `to` (target channel id) for cross-agent / supervisor sends.
  Route through the listener `publish` (not a direct Bot API call) so the listener owns I/O.
  Drop `chat_id` from `required` (`server.ts:504`).
- Rewrite the agent-facing guidance (`server.ts:419`) to be transport-neutral, e.g.:
  *"You have a channel. Messages from it arrive as `notifications/claude/channel`. Publish
  progress and results to your channel with `channel_send`. You don't manage chat ids or
  threads — the channel is your address."* Inbound `<channel>` framing drops
  `source="telegram"` / `chat_id` from what the agent sees (keep the meta internally for the
  listener's mapping). Inbound notification name is already neutral
  (`notifications/claude/channel`) — no change.

### 2b. Roles: owner vs observer  *(decision: "Role on register")*

The supervisor must share a channel with the dev owner without the exclusive-topic eviction
killing either. Introduce a role.

**`listener.ts` changes**
- `ClientConn` (type near `listener.ts:90`): add `role: 'owner' | 'observer'`.
- `register` (`:1081`): `client.role = (msg.role as string) === 'observer' ? 'observer' : 'owner'`
  (default **owner**).
- Eviction block (`listener.ts:1097-1128`): only evict on overlap **when both `client.role`
  and `other.role` are `'owner'`**. Observers never evict and are never evicted. (Keep the
  60s newcomer cooldown for the owner-vs-owner case.)
- `dispatchToClients` already delivers to *every* matching client, so an owner and an observer
  on the same channel both receive inbound with no further change.

**`server.ts` changes**
- Read `role` from env (e.g. `TELEGRAM_ROLE`, default `owner`) and include it in the `register`
  payload (`server.ts:819`). Dev agents omit it (→ owner); the supervisor sets `observer`.

### 2c. Test (Phase 2)

1. Restart the listener from the authoritative copy; confirm a single poller (else `409`).
2. Dev agent A: launch on channel `T_A` as owner (default). Dev agent B: channel `T_B` owner.
3. Supervisor S: launch as `observer` on `all`.
4. Assert: a human message in `T_A` reaches **both** A and S; S can `channel_send to=T_B` and
   B receives it + it appears in Telegram topic `T_B`; launching a second owner on `T_A`
   evicts/----rejects per cooldown, but S is untouched.

---

## Phase 3 — Vibe Kanban spawn integration

Make VK create the branch channel at spawn and hand the dev agent its channel — nothing more.

**Hook point (verified):** `crates/local-deployment/src/container.rs` →
`start_execution_inner` builds a fresh `ExecutionEnv` per spawn at `:1359` and already calls
`env.insert("VK_WORKSPACE_ID", …)` / `VK_WORKSPACE_BRANCH` at `:1366-1367`. `workspace.branch`,
`workspace.name`, `workspace.id` are all in scope. Spawn happens at `:1372`; post-spawn
side-effects fit at `:1389-1396`.

For a Claude-Code workspace, when Telegram is enabled:
1. **Create the branch topic.** Topic **name = `workspace.branch`** (user requirement). Use
   `utils::telegram::Telegram::{new, create_forum_topic}` (`crates/utils/src/telegram.rs:21,39`)
   and `telegram_config::{load, resolve_bot_token}`. (Adjust `topic_name` to use branch, or
   pass `name = None` so it falls back to branch — `crates/utils/src/telegram_config.rs:68`.)
2. **Inject one env var** — the channel (the new topic's `message_thread_id`). Keep using the
   existing `TELEGRAM_TOPIC` env name that `server.ts` reads; **no chat_id, no `--mcp-config`**
   (the sombrax MCP loads as a user-scope plugin — verify a fresh line in
   `~/.claude/channels/telegram/server.log` on first run). Role defaults to **owner**.
3. **Persist** `workspace_id → thread_id` to the **shared** `~/.vibe-kanban/telegram-topics.json`
   so the bridge's `ensure_topic` fast path reuses it (no duplicate topics). The `TopicMap`
   type currently lives privately in `crates/telegram-bridge/src/topics.rs`; lift it into
   `crates/utils` so VK and the bridge share one definition.
4. **Post the task** into the channel and tell the agent to keep it updated — the spawn posts
   the task text to the topic, and VK's initial prompt instructs the agent to `channel_send`
   progress/results as it works.

**Supervisor** is launched separately (not per-workspace) as an `observer` over all channels —
a small VK-level service or a manual launch; out of scope for the per-spawn path.

### Gating & cleanup
- Only wire Claude-Code workspaces (`BaseCodingAgent::ClaudeCode`) and only when telegram
  config resolves an enabled bot token.
- On workspace removal, close the topic + drop the map entry (the bridge already does this in
  `on_workspace_removed`; keep it the single owner of teardown, or move teardown alongside the
  new shared map).

---

## Risks / gotchas

- **Which copy runs.** Multiple checkouts exist (`~/.claude/plugins/cache/.../0.3.1` & `/0.4.0`,
  `~/VibeCoding/sombrax-telegram-plugin`, and this authoritative dir). The live listener **and**
  the agents' `server.ts` must be this edited copy or changes silently no-op. The running
  listener's cwd was confirmed to be this dir.
- **409 Conflict** — exactly one poller per bot token; stop the old listener before restart.
- **Single sender for mirror** — once the listener owns the Telegram send (2a), remove the
  client-side direct send to avoid duplicate messages.
- **Default chat ambiguity** — `resolveDefaultChat()` is only unambiguous with one group in
  `access.json`; otherwise require the `TELEGRAM_CHAT_ID` listener override.
- **Addressing** — cross-agent `to=<channel>` needs the supervisor to know channel ids. Channel
  = thread_id works immediately; a branch-name registry (VK-populated) is the nicer follow-up.
```
