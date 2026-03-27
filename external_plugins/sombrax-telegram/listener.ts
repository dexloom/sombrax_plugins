#!/usr/bin/env bun
/**
 * Telegram listener daemon for multi-session Claude Code.
 *
 * Polls Telegram once and dispatches inbound messages to connected Claude Code
 * MCP servers via Unix socket. Each MCP server registers for specific
 * supergroup topics, so multiple Claude sessions can handle different topics
 * in the same group simultaneously.
 *
 * Usage:
 *   bun listener.ts
 *
 * Then start Claude Code sessions with topic routing:
 *   TELEGRAM_CHAT_ID="-1001234567890" TELEGRAM_TOPIC=123 claude
 *   TELEGRAM_CHAT_ID="-1001234567890" TELEGRAM_TOPIC=456 claude
 *   TELEGRAM_CHAT_ID="-1001234567890" TELEGRAM_TOPIC=all claude
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN     — required (reads from ~/.claude/channels/telegram/.env)
 *   TELEGRAM_LISTENER_SOCKET — Unix socket path (default: STATE_DIR/listener.sock)
 *   TELEGRAM_STATE_DIR     — state directory (default: ~/.claude/channels/telegram)
 *   TELEGRAM_ACCESS_MODE   — set to "static" for read-only access control
 */

import { Bot, GrammyError, InlineKeyboard, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { randomBytes } from 'crypto'
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync,
  renameSync, chmodSync, unlinkSync, existsSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createServer, type Socket } from 'net'
import { spawn, type ChildProcess } from 'child_process'

/* ------------------------------------------------------------------ */
/*  State + config                                                     */
/* ------------------------------------------------------------------ */

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')
const SOCKET_PATH = process.env.TELEGRAM_LISTENER_SOCKET ?? join(STATE_DIR, 'listener.sock')
const INBOX_DIR = join(STATE_DIR, 'inbox')

// Load .env — same logic as server.ts
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'
const DEBUG = !!process.env.TELEGRAM_DEBUG

if (!TOKEN) {
  process.stderr.write(
    `telegram listener: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
  )
  process.exit(1)
}

process.on('unhandledRejection', err => {
  process.stderr.write(`telegram listener: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`telegram listener: uncaught exception: ${err}\n`)
})

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

const bot = new Bot(TOKEN)
let botUsername = ''

/* ------------------------------------------------------------------ */
/*  Access control (same as server.ts — duplicated for self-containment) */
/* ------------------------------------------------------------------ */

type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write(`telegram listener: access.json corrupt, moved aside.\n`)
    return defaultAccess()
  }
}

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write('telegram listener: static mode — dmPolicy "pairing" downgraded to "allowlist"\n')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) { delete a.pending[code]; changed = true }
  }
  return changed
}

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

function gate(ctx: Context): GateResult {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: String(ctx.chat!.id),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return { action: 'drop' }
    if (requireMention && !isMentioned(ctx, access.mentionPatterns)) return { action: 'drop' }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

function isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) return true
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true
  for (const pat of extraPatterns ?? []) {
    try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
  }
  return false
}

// Approval polling
function checkApprovals(): void {
  let files: string[]
  try { files = readdirSync(APPROVED_DIR) } catch { return }
  if (files.length === 0) return
  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    void bot.api.sendMessage(senderId, "Paired! Say hi to Claude.").then(
      () => rmSync(file, { force: true }),
      err => {
        process.stderr.write(`telegram listener: approval confirm failed: ${err}\n`)
        rmSync(file, { force: true })
      },
    )
  }
}
if (!STATIC) setInterval(checkApprovals, 5000).unref()

/* ------------------------------------------------------------------ */
/*  Client connection management                                       */
/* ------------------------------------------------------------------ */

interface ClientConn {
  socket: Socket
  id: string
  chatId: string | null
  topics: number[] | 'all'
  buffer: string
  pendingPermissions: Set<string>
  connectedAt: number
  messagesDelivered: number
  cwd: string | null
  spawnedProcess: any | null
}

const clients: ClientConn[] = []

const lastKnownCwd = new Map<string, string>()  // chatId -> cwd

/* ------------------------------------------------------------------ */
/*  Stats tracking                                                     */
/* ------------------------------------------------------------------ */

const stats = {
  startedAt: Date.now(),
  totalInbound: 0,
  totalDelivered: 0,
  totalDropped: 0,
  byChat: new Map<string, { inbound: number; delivered: number }>(),
}

function removeClient(client: ClientConn): void {
  const idx = clients.indexOf(client)
  if (idx >= 0) clients.splice(idx, 1)
  client.socket.destroy()
  process.stderr.write(`telegram listener: client ${client.id} disconnected (${clients.length} remaining)\n`)
}

function sendToClient(client: ClientConn, data: Record<string, unknown>): void {
  try {
    client.socket.write(JSON.stringify(data) + '\n')
  } catch {
    removeClient(client)
  }
}

/** Route an inbound message to matching clients. Returns true if at least one client received it. */
function dispatchToClients(msg: Record<string, string | undefined>): boolean {
  const chatId = msg.chat_id
  const threadId = msg.message_thread_id ? Number(msg.message_thread_id) : null

  stats.totalInbound++
  const chatStats = stats.byChat.get(chatId ?? '') ?? { inbound: 0, delivered: 0 }
  chatStats.inbound++
  stats.byChat.set(chatId ?? '', chatStats)

  let delivered = false
  for (const client of clients) {
    if (client.chatId !== chatId) continue
    if (client.topics !== 'all') {
      if (threadId != null && !client.topics.includes(threadId)) continue
      if (threadId == null) continue
    }
    if (DEBUG) process.stderr.write(`telegram listener: DISPATCHING to client ${client.id} (chat=${chatId} topic=${threadId})\n`)
    sendToClient(client, { type: 'inbound', ...msg })
    client.messagesDelivered++
    delivered = true
  }

  if (delivered) {
    stats.totalDelivered++
    chatStats.delivered++
  } else {
    stats.totalDropped++
  }
  return delivered
}

/* ------------------------------------------------------------------ */
/*  Permission relay                                                   */
/* ------------------------------------------------------------------ */

// Stores permission details for "See more" expansion, plus which client owns it.
const permissionDetails = new Map<string, {
  tool_name: string
  description: string
  input_preview: string
  clientId: string
}>()

function handlePermissionRequest(client: ClientConn, msg: {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}): void {
  const { request_id, tool_name, description, input_preview } = msg
  client.pendingPermissions.add(request_id)
  permissionDetails.set(request_id, { tool_name, description, input_preview, clientId: client.id })

  const access = loadAccess()
  const text = `🔐 Permission: ${tool_name}`
  const keyboard = new InlineKeyboard()
    .text('See more', `perm:more:${request_id}`)
    .text('✅ Allow', `perm:allow:${request_id}`)
    .text('❌ Deny', `perm:deny:${request_id}`)
  for (const chat_id of access.allowFrom) {
    void bot.api.sendMessage(chat_id, text, { reply_markup: keyboard }).catch(e => {
      process.stderr.write(`telegram listener: permission send to ${chat_id} failed: ${e}\n`)
    })
  }
}

/** Route a permission response to the client that owns the request_id. */
function routePermissionResponse(request_id: string, behavior: string): void {
  for (const client of clients) {
    if (client.pendingPermissions.has(request_id)) {
      sendToClient(client, { type: 'permission_response', request_id, behavior })
      client.pendingPermissions.delete(request_id)
      permissionDetails.delete(request_id)
      return
    }
  }
  // No client found — maybe it disconnected. Drop silently.
}

/* ------------------------------------------------------------------ */
/*  Client protocol handler                                            */
/* ------------------------------------------------------------------ */

function handleClientMessage(client: ClientConn, msg: Record<string, unknown>): void {
  switch (msg.type) {
    case 'register': {
      client.chatId = msg.chat_id as string
      const rawTopics = msg.topics
      if (rawTopics === 'all') {
        client.topics = 'all'
      } else if (Array.isArray(rawTopics)) {
        client.topics = rawTopics.map(Number)
      } else if (typeof rawTopics === 'string') {
        client.topics = rawTopics.split(',').map(s => Number(s.trim()))
      } else {
        client.topics = 'all'
      }
      client.cwd = (msg.cwd as string) ?? null
      if (client.cwd && client.chatId) {
        lastKnownCwd.set(client.chatId, client.cwd)
      }

      // Exclusive topic locking: evict older clients with overlapping topics
      for (const other of [...clients]) {
        if (other === client) continue
        if (other.chatId !== client.chatId) continue
        // Check topic overlap
        let overlaps = false
        if (client.topics === 'all' || other.topics === 'all') {
          overlaps = true
        } else {
          for (const t of client.topics) {
            if (other.topics.includes(t)) { overlaps = true; break }
          }
        }
        if (overlaps) {
          process.stderr.write(`telegram listener: client ${other.id} evicted — topic conflict with ${client.id}\n`)
          sendToClient(other, { type: 'shutdown', reason: 'replaced by new session' })
          setTimeout(() => removeClient(other), 1000)
        }
      }

      if (!clients.includes(client)) clients.push(client)
      process.stderr.write(
        `telegram listener: client ${client.id} registered — ` +
        `chat=${client.chatId} topics=${JSON.stringify(client.topics)} ` +
        `(${clients.length} total)\n`,
      )
      sendToClient(client, { type: 'registered', id: client.id })
      break
    }
    case 'permission_request': {
      handlePermissionRequest(client, msg as {
        request_id: string
        tool_name: string
        description: string
        input_preview: string
      })
      break
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Inbound message handling                                           */
/* ------------------------------------------------------------------ */

type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  const chatType = ctx.chat?.type ?? 'unknown'
  const chatId = String(ctx.chat?.id ?? '?')
  const senderId = String(ctx.from?.id ?? '?')
  const threadId0 = ctx.message?.message_thread_id
  if (DEBUG) process.stderr.write(`telegram listener: INBOUND [${chatType}] chat=${chatId} sender=${senderId} topic=${threadId0 ?? 'none'} text="${text.slice(0, 80)}"\n`)

  const result = gate(ctx)
  if (result.action === 'drop') {
    if (DEBUG) process.stderr.write(`telegram listener: DROPPED by gate (chat=${chatId} sender=${senderId})\n`)
    return
  }

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
    return
  }

  const access = result.access
  const from = ctx.from!
  const chat_id = String(ctx.chat!.id)
  const msgId = ctx.message?.message_id
  const threadId = ctx.message?.message_thread_id

  // Permission-reply intercept — route to owning client
  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (permMatch) {
    const request_id = permMatch[2]!.toLowerCase()
    const behavior = permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
    routePermissionResponse(request_id, behavior)
    if (msgId != null) {
      const emoji = behavior === 'allow' ? '✅' : '❌'
      void bot.api.setMessageReaction(chat_id, msgId, [
        { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
      ]).catch(() => {})
    }
    return
  }

  // Typing indicator
  void bot.api.sendChatAction(chat_id, 'typing', {
    ...(threadId != null ? { message_thread_id: threadId } : {}),
  }).catch(() => {})

  // Ack reaction
  if (access.ackReaction && msgId != null) {
    void bot.api.setMessageReaction(chat_id, msgId, [
      { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
    ]).catch(() => {})
  }

  const imagePath = downloadImage ? await downloadImage() : undefined

  // Build payload and dispatch to matching clients
  const payload: Record<string, string | undefined> = {
    chat_id,
    text,
    ...(msgId != null ? { message_id: String(msgId) } : {}),
    ...(threadId != null ? { message_thread_id: String(threadId) } : {}),
    user: from.username ?? String(from.id),
    user_id: String(from.id),
    ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
    ...(imagePath ? { image_path: imagePath } : {}),
    ...(attachment ? {
      attachment_kind: attachment.kind,
      attachment_file_id: attachment.file_id,
      ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
      ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
      ...(attachment.name ? { attachment_name: attachment.name } : {}),
    } : {}),
  }

  const delivered = dispatchToClients(payload)
  if (!delivered) {
    process.stderr.write(
      `telegram listener: no client for chat=${chat_id} topic=${threadId ?? 'none'} — message dropped\n`,
    )
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60) % 60
  const h = Math.floor(s / 3600) % 24
  const d = Math.floor(s / 86400)
  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  if (parts.length === 0) parts.push(`${s}s`)
  return parts.join(' ')
}

/** Find clients registered for a given chat + topic. */
function findClients(chatId: string, threadId: number | null): ClientConn[] {
  return clients.filter(c => {
    if (c.chatId !== chatId) return false
    if (c.topics === 'all') return true
    if (threadId != null) return c.topics.includes(threadId)
    return false
  })
}

/** Check if sender is in the allowFrom list (authorized). */
function isAuthorized(ctx: Context): boolean {
  const from = ctx.from
  if (!from) return false
  const access = loadAccess()
  return access.allowFrom.includes(String(from.id))
}

/* ------------------------------------------------------------------ */
/*  Session spawn / kill                                               */
/* ------------------------------------------------------------------ */

function spawnClaudeSession(chatId: string, topics: string, cwd: string, resumeId?: string): ChildProcess {
  // Open a new Terminal.app window with Claude Code.
  // Uses expect to auto-accept the development channel confirmation prompt,
  // then hands control back to the user via interact.
  const claudeArgs = [
    '--dangerously-load-development-channels', 'server:sombrax-telegram',
    '--dangerously-skip-permissions',
    '--permission-mode', 'bypassPermissions',
    ...(resumeId ? ['--resume', resumeId] : []),
  ].join(' ')
  const expectScript = `set timeout 30; spawn env TELEGRAM_CHAT_ID=${chatId} TELEGRAM_TOPIC=${topics} TELEGRAM_DEBUG=${process.env.TELEGRAM_DEBUG ?? ''} claude ${claudeArgs}; expect "development" { send "\\r" }; interact`
  const termCmd = `cd ${JSON.stringify(cwd)} && expect -c ${JSON.stringify(expectScript)}`
  const script = `tell application "Terminal" to do script ${JSON.stringify(termCmd)}`
  const proc = spawn('osascript', ['-e', script], {
    stdio: 'ignore',
    detached: true,
  })
  proc.unref()
  process.stderr.write(`telegram listener: opening Terminal window — chat=${chatId} topics=${topics} cwd=${cwd}${resumeId ? ` resume=${resumeId}` : ''}\n`)
  return proc
}

type SessionInfo = { sessionId: string; cwd: string; name: string; pid: string }

function listClaudeSessions(): SessionInfo[] {
  const sessDir = join(homedir(), '.claude', 'sessions')
  const sessions: SessionInfo[] = []
  try {
    for (const file of readdirSync(sessDir)) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = readFileSync(join(sessDir, file), 'utf8')
        const d = JSON.parse(raw)
        if (d.sessionId) {
          sessions.push({
            sessionId: d.sessionId,
            cwd: d.cwd ?? '?',
            name: d.name ?? '',
            pid: file.replace('.json', ''),
          })
        }
      } catch {}
    }
  } catch {}
  return sessions
}

function killSession(client: ClientConn, reason: string): void {
  sendToClient(client, { type: 'shutdown', reason })
  if (client.spawnedProcess) {
    try { client.spawnedProcess.kill('SIGTERM') } catch {}
  }
  // Give the client time to shut down gracefully
  setTimeout(() => removeClient(client), 2000)
}

/* ------------------------------------------------------------------ */
/*  Bot commands — DM-only                                             */
/* ------------------------------------------------------------------ */

bot.command('start', async ctx => {
  if (ctx.chat?.type !== 'private') return
  const access = loadAccess()
  if (access.dmPolicy === 'disabled') {
    await ctx.reply(`This bot isn't accepting new connections.`)
    return
  }
  await ctx.reply(
    `This bot bridges Telegram to Claude Code sessions.\n\n` +
    `To pair:\n` +
    `1. DM me anything — you'll get a 6-char code\n` +
    `2. In Claude Code: /telegram:access pair <code>\n\n` +
    `After that, DMs here reach the paired session.`,
  )
})

bot.command('help', async ctx => {
  if (ctx.chat?.type !== 'private') return
  await ctx.reply(
    `Messages you send here route to paired Claude Code sessions. ` +
    `Text and photos are forwarded; replies and reactions come back.\n\n` +
    `DM commands:\n` +
    `/start — pairing instructions\n` +
    `/status — check your pairing state\n` +
    `/usage — listener stats and uptime\n` +
    `/sessions — connected Claude sessions\n\n` +
    `Group/topic commands:\n` +
    `/new — restart the Claude session for this topic\n` +
    `/restart — restart the Claude session for this topic\n` +
    `/kill — stop Claude session for this topic\n` +
    `/launch <topic> [cwd] — launch new Claude session\n` +
    `/resume [session-id] — resume a saved Claude session\n` +
    `/usage — stats for this chat\n` +
    `/sessions — sessions for this chat`,
  )
})

bot.command('status', async ctx => {
  if (ctx.chat?.type !== 'private') return
  const from = ctx.from
  if (!from) return
  const senderId = String(from.id)
  const access = loadAccess()

  if (access.allowFrom.includes(senderId)) {
    const name = from.username ? `@${from.username}` : senderId
    const topicSummary = clients
      .map(c => `  chat=${c.chatId} topics=${JSON.stringify(c.topics)}`)
      .join('\n')
    await ctx.reply(
      `Paired as ${name}.\n` +
      `Connected sessions: ${clients.length}\n` +
      (topicSummary ? topicSummary : '  (none)'),
    )
    return
  }

  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      await ctx.reply(`Pending pairing — run in Claude Code:\n\n/telegram:access pair ${code}`)
      return
    }
  }

  await ctx.reply(`Not paired. Send me a message to get a pairing code.`)
})

/* ------------------------------------------------------------------ */
/*  Bot commands — work in groups AND DMs                              */
/* ------------------------------------------------------------------ */

bot.command('new', async ctx => {
  // /new restarts the Claude session for the current topic.
  // Works in groups (restarts the session for that topic) and DMs.
  if (!isAuthorized(ctx)) return

  const chatId = String(ctx.chat!.id)
  const threadId = ctx.message?.message_thread_id ?? null
  const matching = findClients(chatId, threadId)

  if (matching.length === 0) {
    const fallbackCwd = lastKnownCwd.get(chatId)
    if (!fallbackCwd) {
      const opts = threadId != null ? { message_thread_id: threadId } : {}
      await bot.api.sendMessage(chatId, 'No session to restart (no known CWD).', opts)
      return
    }
    // No client but we have a CWD — spawn fresh
    const topicStr = threadId != null ? String(threadId) : 'all'
    const proc = spawnClaudeSession(chatId, topicStr, fallbackCwd)
    const opts = threadId != null ? { message_thread_id: threadId } : {}
    await bot.api.sendMessage(chatId, `Spawning new Claude session (pid=${proc.pid}) in ${fallbackCwd}`, opts)
    return
  }

  for (const client of matching) {
    const savedCwd = client.cwd ?? lastKnownCwd.get(chatId)
    const savedTopics = client.topics === 'all' ? 'all' : client.topics.join(',')
    killSession(client, 'restarted via /new')
    if (savedCwd) {
      setTimeout(() => {
        const proc = spawnClaudeSession(chatId, savedTopics, savedCwd)
        process.stderr.write(`telegram listener: respawned session pid=${proc.pid} after /new\n`)
      }, 3000)
    }
  }

  const opts = threadId != null ? { message_thread_id: threadId } : {}
  await bot.api.sendMessage(
    chatId,
    `Restarting ${matching.length} session(s). New Claude session will start shortly.`,
    opts,
  )
})

bot.command('restart', async ctx => {
  // /restart is an alias for /new — restarts the Claude session for the current topic.
  if (!isAuthorized(ctx)) return

  const chatId = String(ctx.chat!.id)
  const threadId = ctx.message?.message_thread_id ?? null
  const matching = findClients(chatId, threadId)

  if (matching.length === 0) {
    const fallbackCwd = lastKnownCwd.get(chatId)
    if (!fallbackCwd) {
      const opts = threadId != null ? { message_thread_id: threadId } : {}
      await bot.api.sendMessage(chatId, 'No session to restart (no known CWD).', opts)
      return
    }
    const topicStr = threadId != null ? String(threadId) : 'all'
    const proc = spawnClaudeSession(chatId, topicStr, fallbackCwd)
    const opts = threadId != null ? { message_thread_id: threadId } : {}
    await bot.api.sendMessage(chatId, `Spawning new Claude session (pid=${proc.pid}) in ${fallbackCwd}`, opts)
    return
  }

  for (const client of matching) {
    const savedCwd = client.cwd ?? lastKnownCwd.get(chatId)
    const savedTopics = client.topics === 'all' ? 'all' : client.topics.join(',')
    killSession(client, 'restarted via /restart')
    if (savedCwd) {
      setTimeout(() => {
        const proc = spawnClaudeSession(chatId, savedTopics, savedCwd)
        process.stderr.write(`telegram listener: respawned session pid=${proc.pid} after /restart\n`)
      }, 3000)
    }
  }

  const opts = threadId != null ? { message_thread_id: threadId } : {}
  await bot.api.sendMessage(
    chatId,
    `Restarting ${matching.length} session(s). New Claude session will start shortly.`,
    opts,
  )
})

bot.command('kill', async ctx => {
  // /kill [topic] — stop the Claude session for this topic without restarting
  if (!isAuthorized(ctx)) return

  const chatId = String(ctx.chat!.id)
  const threadId = ctx.message?.message_thread_id ?? null
  const matching = findClients(chatId, threadId)

  if (matching.length === 0) {
    const opts = threadId != null ? { message_thread_id: threadId } : {}
    await bot.api.sendMessage(chatId, 'No Claude session connected for this topic.', opts)
    return
  }

  for (const client of matching) {
    killSession(client, 'killed via /kill')
  }

  const opts = threadId != null ? { message_thread_id: threadId } : {}
  await bot.api.sendMessage(
    chatId,
    `Killed ${matching.length} session(s). Use /launch to start a new one.`,
    opts,
  )
})

bot.command('launch', async ctx => {
  // /launch <topic> [cwd] — launch a new Claude session for a topic
  if (!isAuthorized(ctx)) return

  const chatId = String(ctx.chat!.id)
  const threadId = ctx.message?.message_thread_id ?? null
  const rawArgs = (ctx.message?.text ?? '').replace(/^\/launch(@\w+)?\s*/, '').trim()
  const parts = rawArgs.split(/\s+/)
  const topicArg = parts[0] || null
  const cwdArg = parts.slice(1).join(' ') || null

  const topicStr = topicArg ?? (threadId != null ? String(threadId) : null)
  if (!topicStr) {
    const opts = threadId != null ? { message_thread_id: threadId } : {}
    await bot.api.sendMessage(chatId, 'Usage: /launch <topic> [cwd]\nProvide a topic ID or use in a topic thread.', opts)
    return
  }

  const cwd = cwdArg ?? lastKnownCwd.get(chatId)
  if (!cwd) {
    const opts = threadId != null ? { message_thread_id: threadId } : {}
    await bot.api.sendMessage(chatId, 'No CWD provided and no previous session CWD known. Usage: /launch <topic> <cwd>', opts)
    return
  }

  // Check if topic is already taken
  const topicNum = Number(topicStr)
  const existing = clients.filter(c => {
    if (c.chatId !== chatId) return false
    if (c.topics === 'all') return true
    if (!isNaN(topicNum) && c.topics.includes(topicNum)) return true
    return false
  })
  if (existing.length > 0) {
    const opts = threadId != null ? { message_thread_id: threadId } : {}
    await bot.api.sendMessage(chatId, `Topic ${topicStr} is already served by session ${existing[0].id}. Use /restart to replace it.`, opts)
    return
  }

  const proc = spawnClaudeSession(chatId, topicStr, cwd)
  const opts = threadId != null ? { message_thread_id: threadId } : {}
  await bot.api.sendMessage(chatId, `Launched new Claude session (pid=${proc.pid}) for topic ${topicStr} in ${cwd}`, opts)
})

bot.command('resume', async ctx => {
  if (!isAuthorized(ctx)) return

  const chatId = String(ctx.chat!.id)
  const threadId = ctx.message?.message_thread_id ?? null
  const opts = threadId != null ? { message_thread_id: threadId } : {}
  const args = (ctx.message?.text ?? '').replace(/^\/resume\s*/, '').trim()

  const sessions = listClaudeSessions()
  if (sessions.length === 0) {
    await bot.api.sendMessage(chatId, 'No saved sessions found.', opts)
    return
  }

  // If a session ID (or prefix) is provided, resume it directly
  if (args) {
    const match = sessions.find(s => s.sessionId === args || s.sessionId.startsWith(args) || s.pid === args)
    if (!match) {
      await bot.api.sendMessage(chatId, `No session matching "${args}". Use /resume to list.`, opts)
      return
    }

    const topic = threadId != null ? String(threadId) : 'all'

    // Check for existing client on this topic
    const existing = findClients(chatId, threadId)
    for (const old of existing) {
      killSession(old, 'replaced by resumed session')
    }

    spawnClaudeSession(chatId, topic, match.cwd, match.sessionId)
    await bot.api.sendMessage(chatId, `Resuming session ${match.sessionId.slice(0, 8)}... in ${match.cwd}`, opts)
    return
  }

  // No args — list available sessions with inline buttons
  let text = `Sessions (${sessions.length}):\n\n`
  const buttons: { text: string; data: string }[][] = []
  for (const s of sessions.slice(-10)) { // last 10
    const label = s.name || s.cwd.split('/').pop() || s.sessionId.slice(0, 8)
    text += `${s.sessionId.slice(0, 8)} — ${s.cwd}${s.name ? ` (${s.name})` : ''}\n`
    buttons.push([{ text: `Resume ${label}`, data: `resume:${s.sessionId}` }])
  }

  const keyboard = { inline_keyboard: buttons.map(row => row.map(b => ({ text: b.text, callback_data: b.data }))) }
  await bot.api.sendMessage(chatId, text, { ...opts, reply_markup: keyboard })
})

bot.command('usage', async ctx => {
  if (!isAuthorized(ctx)) return

  const chatId = String(ctx.chat!.id)
  const threadId = ctx.message?.message_thread_id ?? null
  const uptime = formatUptime(Date.now() - stats.startedAt)

  let text = `Listener uptime: ${uptime}\n`
  text += `Connected sessions: ${clients.length}\n\n`
  text += `Messages:\n`
  text += `  Total inbound: ${stats.totalInbound}\n`
  text += `  Delivered: ${stats.totalDelivered}\n`
  text += `  Dropped (no client): ${stats.totalDropped}\n`

  // Show per-chat breakdown if in a group
  const chatType = ctx.chat?.type
  if (chatType === 'group' || chatType === 'supergroup') {
    const chatStats = stats.byChat.get(chatId)
    if (chatStats) {
      text += `\nThis chat:\n`
      text += `  Inbound: ${chatStats.inbound}\n`
      text += `  Delivered: ${chatStats.delivered}\n`
    }
    const matching = findClients(chatId, threadId)
    if (matching.length > 0) {
      text += `\nSessions for this chat:\n`
      for (const c of matching) {
        const age = formatUptime(Date.now() - c.connectedAt)
        text += `  ${c.id}: topics=${JSON.stringify(c.topics)}, msgs=${c.messagesDelivered}, up=${age}\n`
      }
    }
  } else {
    // DM — show all chats
    if (stats.byChat.size > 0) {
      text += `\nPer-chat:\n`
      for (const [cid, cs] of stats.byChat) {
        text += `  ${cid}: in=${cs.inbound} del=${cs.delivered}\n`
      }
    }
  }

  const opts = threadId != null ? { message_thread_id: threadId } : {}
  await bot.api.sendMessage(chatId, text, opts)
})

bot.command('sessions', async ctx => {
  if (!isAuthorized(ctx)) return

  const chatId = String(ctx.chat!.id)
  const threadId = ctx.message?.message_thread_id ?? null

  if (clients.length === 0) {
    const opts = threadId != null ? { message_thread_id: threadId } : {}
    await bot.api.sendMessage(chatId, 'No sessions connected.', opts)
    return
  }

  let text = `Connected sessions: ${clients.length}\n\n`
  for (const c of clients) {
    const age = formatUptime(Date.now() - c.connectedAt)
    text += `${c.id}:\n`
    text += `  chat: ${c.chatId}\n`
    text += `  topics: ${JSON.stringify(c.topics)}\n`
    text += `  messages: ${c.messagesDelivered}\n`
    text += `  uptime: ${age}\n`
    text += `  cwd: ${c.cwd ?? '(unknown)'}\n`
    text += `  permissions pending: ${c.pendingPermissions.size}\n\n`
  }

  const opts = threadId != null ? { message_thread_id: threadId } : {}
  await bot.api.sendMessage(chatId, text, opts)
})

/* ------------------------------------------------------------------ */
/*  Permission callback handler                                        */
/* ------------------------------------------------------------------ */

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data

  // Handle resume button clicks
  const resumeMatch = /^resume:(.+)$/.exec(data)
  if (resumeMatch) {
    const access = loadAccess()
    const senderId = String(ctx.from.id)
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const sessionId = resumeMatch[1]
    const sessions = listClaudeSessions()
    const session = sessions.find(s => s.sessionId === sessionId)
    if (!session) {
      await ctx.answerCallbackQuery({ text: 'Session not found.' }).catch(() => {})
      return
    }
    const chatId = String(ctx.callbackQuery.message?.chat.id ?? '')
    const threadId = ctx.callbackQuery.message?.message_thread_id ?? null
    const topic = threadId != null ? String(threadId) : 'all'

    // Kill existing sessions on this topic
    const existing = findClients(chatId, threadId)
    for (const old of existing) {
      killSession(old, 'replaced by resumed session')
    }

    spawnClaudeSession(chatId, topic, session.cwd, session.sessionId)
    await ctx.answerCallbackQuery({ text: 'Resuming...' }).catch(() => {})
    await ctx.editMessageText(`Resuming session ${session.sessionId.slice(0, 8)}... in ${session.cwd}`).catch(() => {})
    return
  }

  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
  if (!m) {
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  const access = loadAccess()
  const senderId = String(ctx.from.id)
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const [, behavior, request_id] = m

  if (behavior === 'more') {
    const details = permissionDetails.get(request_id)
    if (!details) {
      await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
      return
    }
    const { tool_name, description, input_preview } = details
    let prettyInput: string
    try { prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2) } catch { prettyInput = input_preview }
    const expanded =
      `🔐 Permission: ${tool_name}\n\n` +
      `tool_name: ${tool_name}\n` +
      `description: ${description}\n` +
      `input_preview:\n${prettyInput}`
    const keyboard = new InlineKeyboard()
      .text('✅ Allow', `perm:allow:${request_id}`)
      .text('❌ Deny', `perm:deny:${request_id}`)
    await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {})
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }

  routePermissionResponse(request_id, behavior)
  const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const msg = ctx.callbackQuery.message
  if (msg && 'text' in msg && msg.text) {
    await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
  }
})

/* ------------------------------------------------------------------ */
/*  Bot message handlers                                               */
/* ------------------------------------------------------------------ */

bot.on('message:text', async ctx => {
  await handleInbound(ctx, ctx.message.text, undefined)
})

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  await handleInbound(ctx, caption, async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await ctx.api.getFile(best.file_id)
      if (!file.file_path) return undefined
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.split('.').pop() ?? 'jpg'
      const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return path
    } catch (err) {
      process.stderr.write(`telegram listener: photo download failed: ${err}\n`)
      return undefined
    }
  })
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`
  await handleInbound(ctx, text, undefined, {
    kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name,
  })
})

bot.on('message:voice', async ctx => {
  const voice = ctx.message.voice
  await handleInbound(ctx, ctx.message.caption ?? '(voice message)', undefined, {
    kind: 'voice', file_id: voice.file_id, size: voice.file_size, mime: voice.mime_type,
  })
})

bot.on('message:audio', async ctx => {
  const audio = ctx.message.audio
  const name = safeName(audio.file_name)
  await handleInbound(ctx, ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`, undefined, {
    kind: 'audio', file_id: audio.file_id, size: audio.file_size, mime: audio.mime_type, name,
  })
})

bot.on('message:video', async ctx => {
  const video = ctx.message.video
  await handleInbound(ctx, ctx.message.caption ?? '(video)', undefined, {
    kind: 'video', file_id: video.file_id, size: video.file_size, mime: video.mime_type, name: safeName(video.file_name),
  })
})

bot.on('message:video_note', async ctx => {
  const vn = ctx.message.video_note
  await handleInbound(ctx, '(video note)', undefined, {
    kind: 'video_note', file_id: vn.file_id, size: vn.file_size,
  })
})

bot.on('message:sticker', async ctx => {
  const sticker = ctx.message.sticker
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
  await handleInbound(ctx, `(sticker${emoji})`, undefined, {
    kind: 'sticker', file_id: sticker.file_id, size: sticker.file_size,
  })
})

bot.catch(err => {
  process.stderr.write(`telegram listener: handler error (polling continues): ${err.error}\n`)
})

/* ------------------------------------------------------------------ */
/*  Unix socket server                                                 */
/* ------------------------------------------------------------------ */

if (existsSync(SOCKET_PATH)) {
  try { unlinkSync(SOCKET_PATH) } catch {}
}

const socketServer = createServer(socket => {
  const client: ClientConn = {
    socket,
    id: randomBytes(4).toString('hex'),
    chatId: null,
    topics: 'all',
    buffer: '',
    pendingPermissions: new Set(),
    connectedAt: Date.now(),
    messagesDelivered: 0,
    cwd: null,
    spawnedProcess: null,
  }
  process.stderr.write(`telegram listener: client ${client.id} connected\n`)

  socket.on('data', chunk => {
    client.buffer += chunk.toString()
    let nl: number
    while ((nl = client.buffer.indexOf('\n')) !== -1) {
      const line = client.buffer.slice(0, nl)
      client.buffer = client.buffer.slice(nl + 1)
      if (!line) continue
      try {
        handleClientMessage(client, JSON.parse(line))
      } catch (e) {
        process.stderr.write(`telegram listener: bad message from ${client.id}: ${e}\n`)
      }
    }
  })

  socket.on('close', () => removeClient(client))
  socket.on('error', () => removeClient(client))
})

socketServer.listen(SOCKET_PATH, () => {
  process.stderr.write(`telegram listener: socket at ${SOCKET_PATH}\n`)
  // Make socket accessible to same user only
  try { chmodSync(SOCKET_PATH, 0o600) } catch {}
})

/* ------------------------------------------------------------------ */
/*  Bot polling (409 retry logic)                                      */
/* ------------------------------------------------------------------ */

void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          botUsername = info.username
          process.stderr.write(`telegram listener: polling as @${info.username}\n`)
          // DM-specific commands
          void bot.api.setMyCommands(
            [
              { command: 'start', description: 'Welcome and setup guide' },
              { command: 'help', description: 'What this bot can do' },
              { command: 'status', description: 'Check your pairing status' },
              { command: 'usage', description: 'Listener stats and uptime' },
              { command: 'sessions', description: 'Connected Claude sessions' },
            ],
            { scope: { type: 'all_private_chats' } },
          ).catch(() => {})
          // Group commands (include new/restart/kill/launch/usage/sessions)
          void bot.api.setMyCommands(
            [
              { command: 'new', description: 'Restart Claude session for this topic' },
              { command: 'restart', description: 'Restart Claude session for this topic' },
              { command: 'kill', description: 'Stop Claude session for this topic' },
              { command: 'launch', description: 'Launch new Claude session for a topic' },
              { command: 'resume', description: 'Resume a saved Claude session' },
              { command: 'usage', description: 'Stats and uptime' },
              { command: 'sessions', description: 'Connected Claude sessions' },
            ],
            { scope: { type: 'all_group_chats' } },
          ).catch(() => {})
        },
      })
      return
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 409) {
        const delay = Math.min(1000 * attempt, 15000)
        const detail = attempt === 1
          ? ' — another instance is polling (zombie session?)'
          : ''
        process.stderr.write(`telegram listener: 409 Conflict${detail}, retrying in ${delay / 1000}s\n`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      if (err instanceof Error && err.message === 'Aborted delay') return
      process.stderr.write(`telegram listener: polling failed: ${err}\n`)
      return
    }
  }
})()

/* ------------------------------------------------------------------ */
/*  Shutdown                                                           */
/* ------------------------------------------------------------------ */

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('telegram listener: shutting down\n')
  socketServer.close()
  try { unlinkSync(SOCKET_PATH) } catch {}
  // Notify all connected clients
  for (const client of clients) {
    try { client.socket.end() } catch {}
  }
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
