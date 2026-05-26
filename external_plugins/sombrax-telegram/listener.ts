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
 *   bun listener.ts            # run the daemon
 *   bun listener.ts --tui      # live dashboard of running sessions
 *                              # (connects to an already-running daemon)
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

import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { randomBytes } from 'crypto'
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync,
  renameSync, chmodSync, unlinkSync, existsSync,
} from 'fs'
import { homedir } from 'os'
import { join, extname } from 'path'
import { createServer, connect, type Socket } from 'net'
import { spawn, spawnSync, type ChildProcess } from 'child_process'

/* ------------------------------------------------------------------ */
/*  State + config                                                     */
/* ------------------------------------------------------------------ */

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')
const SOCKET_PATH = process.env.TELEGRAM_LISTENER_SOCKET ?? join(STATE_DIR, 'listener.sock')
const INBOX_DIR = join(STATE_DIR, 'inbox')
// Topic-name registry: { "<chat_id>": { "<name>": <thread_id> } }. The
// listener owns this file in Phase 4 — clients used to maintain a copy
// next to themselves (server.ts), but topic creation is now listener-
// resolved at register time so name → thread mappings live with the
// process that creates them.
const TOPIC_NAMES_FILE = join(STATE_DIR, 'topic-names.json')

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

/* ------------------------------------------------------------------ */
/*  --tui : live dashboard of running sessions                         */
/* ------------------------------------------------------------------ */
/*  Thin client: connects to an already-running listener over the      */
/*  Unix socket, polls list_sessions every 2s, and exposes a           */
/*  multi-view interactive dashboard. Module execution suspends at the */
/*  top-level await below so the daemon bootstrap never runs here.     */
/*                                                                     */
/*  Views: main (sessions table) · detail (single session + pending    */
/*  permissions) · resume (saved-session picker) · logs (server.log    */
/*  tail) · coverage (topic ownership + recent drops).                 */

interface PendingPerm {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
  ageMs: number
}
interface TuiSession {
  id: string
  sessionId: string | null
  cwd: string | null
  branch: string
  worktree: string
  dirty: boolean
  ahead: number
  behind: number
  hasUpstream: boolean
  topics: string
  chatId: string | null
  uptimeMs: number
  messages: number
  pending: number
  pendingPerms: PendingPerm[]
}
interface TuiStatus {
  daemonStartedAt: number
  daemonUptimeMs: number
  totalInbound: number
  totalDelivered: number
  totalDropped: number
  recentDrops: Array<{ chatId: string; threadId: number | null; ts: number }>
  socketPath: string
  clientsCount: number
}
interface SavedSession { sessionId: string; cwd: string; name: string; pid: string }

if (process.argv.includes('--tui')) {
  await runTuiClient()
  process.exit(0)
}

function fmtUptimeShort(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

/** Truncate keeping the tail (more informative for paths). */
function truncTail(s: string, w: number): string {
  if (w <= 0) return ''
  if (s.length <= w) return s.padEnd(w)
  return ('…' + s.slice(-(w - 1))).padEnd(w)
}
function truncHead(s: string, w: number): string {
  if (w <= 0) return ''
  if (s.length <= w) return s.padEnd(w)
  return (s.slice(0, w - 1) + '…').padEnd(w)
}

/** Compose the branch column with dirty/ahead/behind annotations. */
function fmtBranch(s: TuiSession): string {
  if (!s.branch) return '-'
  let out = s.branch
  if (s.dirty) out += '*'
  if (s.hasUpstream && (s.ahead || s.behind)) {
    const parts: string[] = []
    if (s.ahead) parts.push(`↑${s.ahead}`)
    if (s.behind) parts.push(`↓${s.behind}`)
    out += ' ' + parts.join(' ')
  }
  return out
}

type SortField = 'cwd' | 'branch' | 'uptime' | 'pending' | 'msgs'
type View = 'main' | 'detail' | 'resume' | 'logs' | 'coverage'
type InputMode =
  | null
  | { kind: 'filter'; value: string }
  | { kind: 'confirm'; prompt: string; onYes: () => void }
  | { kind: 'launchChat'; chatId: string; topics: string; cwd: string; value: string }
  | { kind: 'launchTopic'; chatId: string; topics: string; cwd: string; value: string }
  | { kind: 'launchCwd';   chatId: string; topics: string; cwd: string; value: string }
  | { kind: 'resumeTopic'; sessionId: string; chatId: string; cwd: string; value: string }
  | { kind: 'resumeChat';  sessionId: string; chatId: string; cwd: string; value: string }

function sortSessions(list: TuiSession[], field: SortField, dir: 'asc' | 'desc'): TuiSession[] {
  const cmp = (a: TuiSession, b: TuiSession): number => {
    switch (field) {
      case 'cwd':     return (a.cwd ?? '').localeCompare(b.cwd ?? '')
      case 'branch':  return (a.branch ?? '').localeCompare(b.branch ?? '')
      case 'uptime':  return a.uptimeMs - b.uptimeMs
      case 'pending': return a.pending - b.pending
      case 'msgs':    return a.messages - b.messages
    }
  }
  const sorted = [...list].sort(cmp)
  return dir === 'desc' ? sorted.reverse() : sorted
}

function filterSessions(list: TuiSession[], q: string): TuiSession[] {
  if (!q) return list
  const needle = q.toLowerCase()
  return list.filter(s =>
    (s.cwd ?? '').toLowerCase().includes(needle) ||
    (s.branch ?? '').toLowerCase().includes(needle) ||
    (s.chatId ?? '').includes(needle) ||
    s.topics.toLowerCase().includes(needle) ||
    s.id.includes(needle) ||
    (s.sessionId ?? '').toLowerCase().includes(needle),
  )
}

function runTuiClient(): Promise<void> {
  return new Promise(resolve => {
    // --- State -----------------------------------------------------
    let connected = false
    let sessions: TuiSession[] = []
    let status: TuiStatus | null = null
    let savedSessions: SavedSession[] = []
    let logs: string[] = []
    let view: View = 'main'
    let selIdx = 0
    let permIdx = 0
    let savedIdx = 0
    let sortField: SortField = 'uptime'
    let sortDir: 'asc' | 'desc' = 'desc'
    let filter = ''
    let inputMode: InputMode = null
    let flash: { text: string; until: number } | null = null
    let lastVisible: TuiSession[] = []  // visible after sort+filter; used by actions

    let buffer = ''
    let sock: Socket | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let done = false

    // --- Helpers ---------------------------------------------------
    const send = (m: Record<string, unknown>) => { try { sock?.write(JSON.stringify(m) + '\n') } catch {} }
    const flashOk = (t: string) => { flash = { text: t, until: Date.now() + 2500 }; draw() }
    const flashErr = (t: string) => { flash = { text: '✗ ' + t, until: Date.now() + 3500 }; draw() }

    const selected = (): TuiSession | null => {
      if (!lastVisible.length) return null
      if (selIdx < 0) selIdx = 0
      if (selIdx >= lastVisible.length) selIdx = lastVisible.length - 1
      return lastVisible[selIdx]
    }

    const draw = () => { if (!done) process.stdout.write('\x1b[2J\x1b[H' + render() + '\n') }

    // --- Render ----------------------------------------------------
    const render = (): string => {
      const cols = process.stdout.columns || 120
      const rows = process.stdout.rows || 30
      const out: string[] = []
      const now = Date.now()
      const flashTxt = flash && flash.until > now ? flash.text : ''

      // Header (always shown)
      const ts = new Date().toLocaleTimeString()
      if (status) {
        out.push(
          `\x1b[1mSombraX Telegram\x1b[0m · ` +
          `up ${fmtUptimeShort(status.daemonUptimeMs)} · ` +
          `sessions ${status.clientsCount} · ` +
          `in ${status.totalInbound} / del ${status.totalDelivered} / drop ${status.totalDropped} · ${ts}`,
        )
      } else {
        out.push(`\x1b[1mSombraX Telegram\x1b[0m · ${ts}`)
      }

      if (!connected) {
        out.push('')
        out.push('\x1b[31mListener not running.\x1b[0m  Start it with /sombrax_telegram_channel start')
        out.push('')
        out.push('\x1b[2mpress q or Ctrl-C to quit · auto-reconnecting…\x1b[0m')
        return out.join('\n')
      }

      // View-specific body
      if (view === 'main') out.push(...renderMain(cols))
      else if (view === 'detail') out.push(...renderDetail(cols, rows))
      else if (view === 'resume') out.push(...renderResume(cols, rows))
      else if (view === 'logs') out.push(...renderLogs(cols, rows))
      else if (view === 'coverage') out.push(...renderCoverage(cols, rows))

      // Footer: input prompt or help
      out.push('')
      if (inputMode) out.push(renderInput())
      else out.push('\x1b[2m' + helpForView() + '\x1b[0m')
      if (flashTxt) out.push('\x1b[33m' + flashTxt + '\x1b[0m')

      return out.join('\n')
    }

    const helpForView = (): string => {
      switch (view) {
        case 'main':
          return '↑↓ select · Enter/d detail · k kill · r restart · l launch · R resume · L logs · c coverage · / filter · s sort · S dir · q quit'
        case 'detail':
          return 'Esc/d back · ↑↓ select perm · a approve · D deny · k kill · r restart · q quit'
        case 'resume':
          return '↑↓ select · Enter resume · Esc back · q quit'
        case 'logs':
          return 'Esc/L back · q quit'
        case 'coverage':
          return 'Esc/c back · q quit'
      }
    }

    const renderInput = (): string => {
      if (!inputMode) return ''
      switch (inputMode.kind) {
        case 'filter':       return `\x1b[36mfilter:\x1b[0m ${inputMode.value}_   \x1b[2m(Enter=apply Esc=cancel)\x1b[0m`
        case 'confirm':      return `\x1b[33m${inputMode.prompt}\x1b[0m  \x1b[2m(y/N)\x1b[0m`
        case 'launchChat':   return `\x1b[36mlaunch chat_id:\x1b[0m ${inputMode.value}_   \x1b[2m(Enter=next Esc=cancel)\x1b[0m`
        case 'launchTopic':  return `\x1b[36mlaunch topic:\x1b[0m ${inputMode.value}_   \x1b[2m(default 'all', Enter=next Esc=cancel)\x1b[0m`
        case 'launchCwd':    return `\x1b[36mlaunch cwd:\x1b[0m ${inputMode.value}_   \x1b[2m(Enter=launch Esc=cancel)\x1b[0m`
        case 'resumeChat':   return `\x1b[36mresume chat_id:\x1b[0m ${inputMode.value}_   \x1b[2m(Enter=next Esc=cancel)\x1b[0m`
        case 'resumeTopic':  return `\x1b[36mresume topic:\x1b[0m ${inputMode.value}_   \x1b[2m(default 'all', Enter=resume Esc=cancel)\x1b[0m`
      }
    }

    const renderMain = (cols: number): string[] => {
      const out: string[] = []
      out.push(
        `\x1b[2mfilter:\x1b[0m "${filter}" · ` +
        `\x1b[2msort:\x1b[0m ${sortField} ${sortDir === 'desc' ? '↓' : '↑'}`,
      )
      out.push('')

      const visible = filterSessions(sortSessions(sessions, sortField, sortDir), filter)
      lastVisible = visible
      if (visible.length === 0) {
        out.push('\x1b[2m' + (sessions.length ? 'No sessions match filter.' : 'No sessions connected.') + '\x1b[0m')
        return out
      }
      if (selIdx >= visible.length) selIdx = visible.length - 1
      if (selIdx < 0) selIdx = 0

      const wSel = 2, wSess = 12, wBranch = 22, wMsg = 5, wPend = 5, wUp = 7
      const fixed = wSel + wSess + wBranch + wMsg + wPend + wUp + 5
      const rest = Math.max(40, cols - fixed)
      const wFolder = Math.ceil(rest * 0.55)
      const wTree = rest - wFolder
      const hdr =
        '  '.padEnd(wSel) +
        'FOLDER'.padEnd(wFolder) + ' ' +
        'SESSION'.padEnd(wSess) + ' ' +
        'BRANCH'.padEnd(wBranch) + ' ' +
        'WORKTREE'.padEnd(wTree) + ' ' +
        'MSG'.padStart(wMsg) + ' ' +
        'PEND'.padStart(wPend) + ' ' +
        'UP'.padEnd(wUp)
      out.push('\x1b[1m' + hdr + '\x1b[0m')
      out.push('\x1b[2m' + '─'.repeat(Math.min(cols, hdr.length)) + '\x1b[0m')

      visible.forEach((s, i) => {
        const sess = s.sessionId ? s.sessionId.slice(0, wSess) : s.id
        const arrow = i === selIdx ? '▶ ' : '  '
        const line =
          arrow +
          truncTail(s.cwd ?? '(unknown)', wFolder) + ' ' +
          truncHead(sess, wSess) + ' ' +
          truncHead(fmtBranch(s), wBranch) + ' ' +
          truncTail(s.worktree || '-', wTree) + ' ' +
          String(s.messages).padStart(wMsg) + ' ' +
          (s.pending ? `\x1b[33m${String(s.pending).padStart(wPend)}\x1b[0m` : String(s.pending).padStart(wPend)) + ' ' +
          fmtUptimeShort(s.uptimeMs).padEnd(wUp)
        out.push(i === selIdx ? '\x1b[7m' + line + '\x1b[0m' : line)
      })
      return out
    }

    const renderDetail = (cols: number, rows: number): string[] => {
      const out: string[] = []
      const s = selected()
      if (!s) { out.push('\x1b[2mNo session selected.\x1b[0m'); return out }
      out.push('')
      out.push(`\x1b[1mSession\x1b[0m ${s.id}` + (s.sessionId ? `   \x1b[2m(claude ${s.sessionId})\x1b[0m` : ''))
      out.push('')
      out.push(`  cwd:      ${s.cwd ?? '(unknown)'}`)
      out.push(`  chat:     ${s.chatId ?? '(unknown)'}`)
      out.push(`  topics:   ${s.topics}`)
      out.push(`  branch:   ${fmtBranch(s) || '-'}`)
      out.push(`  worktree: ${s.worktree || '-'}`)
      out.push(`  uptime:   ${fmtUptimeShort(s.uptimeMs)}`)
      out.push(`  messages: ${s.messages}`)
      out.push(`  pending:  ${s.pending}`)
      out.push('')
      out.push('\x1b[1mPending permissions\x1b[0m')
      if (!s.pendingPerms.length) {
        out.push('  \x1b[2m(none)\x1b[0m')
      } else {
        if (permIdx >= s.pendingPerms.length) permIdx = s.pendingPerms.length - 1
        if (permIdx < 0) permIdx = 0
        s.pendingPerms.forEach((p, i) => {
          const arrow = i === permIdx ? '▶ ' : '  '
          const head = `${arrow}[${i + 1}] ${p.tool_name.padEnd(10)}  ${fmtUptimeShort(p.ageMs).padStart(5)}  ${truncHead(p.description, Math.max(20, cols - 30))}`
          out.push(i === permIdx ? '\x1b[7m' + head + '\x1b[0m' : head)
          if (i === permIdx && p.input_preview) {
            const preview = p.input_preview.split('\n').slice(0, Math.min(8, rows - out.length - 6))
            for (const ln of preview) out.push('     \x1b[2m' + truncHead(ln, cols - 6) + '\x1b[0m')
          }
        })
      }
      return out
    }

    const renderResume = (cols: number, rows: number): string[] => {
      const out: string[] = []
      out.push('')
      out.push('\x1b[1mSaved Claude sessions\x1b[0m  ' + (savedSessions.length ? `(${savedSessions.length})` : ''))
      out.push('')
      if (!savedSessions.length) {
        out.push('  \x1b[2m(no saved sessions found in ~/.claude/sessions)\x1b[0m')
        return out
      }
      if (savedIdx >= savedSessions.length) savedIdx = savedSessions.length - 1
      if (savedIdx < 0) savedIdx = 0
      const wId = 12, wPid = 8
      const wCwd = Math.max(30, cols - wId - wPid - 8)
      const hdr = '  ' + 'SESSION'.padEnd(wId) + ' ' + 'PID'.padEnd(wPid) + ' ' + 'CWD'.padEnd(wCwd)
      out.push('\x1b[1m' + hdr + '\x1b[0m')
      out.push('\x1b[2m' + '─'.repeat(Math.min(cols, hdr.length)) + '\x1b[0m')
      const limit = Math.max(5, rows - out.length - 4)
      savedSessions.slice(0, limit).forEach((s, i) => {
        const arrow = i === savedIdx ? '▶ ' : '  '
        const line = arrow + truncHead(s.sessionId, wId) + ' ' + truncHead(s.pid, wPid) + ' ' + truncTail(s.cwd, wCwd)
        out.push(i === savedIdx ? '\x1b[7m' + line + '\x1b[0m' : line)
      })
      return out
    }

    const renderLogs = (cols: number, rows: number): string[] => {
      const out: string[] = []
      out.push('\x1b[1mserver.log\x1b[0m  \x1b[2m(last ' + logs.length + ' lines)\x1b[0m')
      out.push('')
      const limit = Math.max(5, rows - 6)
      const slice = logs.slice(-limit)
      if (!slice.length) out.push('  \x1b[2m(no log lines)\x1b[0m')
      for (const ln of slice) out.push(truncHead(ln, cols))
      return out
    }

    const renderCoverage = (cols: number, rows: number): string[] => {
      const out: string[] = []
      out.push('\x1b[1mTopic coverage\x1b[0m')
      out.push('')
      // Group sessions by chat
      const byChat = new Map<string, TuiSession[]>()
      for (const s of sessions) {
        const k = s.chatId ?? '(unknown)'
        if (!byChat.has(k)) byChat.set(k, [])
        byChat.get(k)!.push(s)
      }
      if (!byChat.size) out.push('  \x1b[2m(no sessions)\x1b[0m')
      for (const [chatId, list] of byChat) {
        out.push(`  \x1b[1m${chatId}\x1b[0m`)
        // collect topic -> session ids
        const topicMap = new Map<string, string[]>()
        for (const s of list) {
          const key = s.topics
          if (!topicMap.has(key)) topicMap.set(key, [])
          topicMap.get(key)!.push(s.id + (s.branch ? ` \x1b[2m(${s.branch})\x1b[0m` : ''))
        }
        for (const [topics, ids] of topicMap) {
          const marker = ids.length > 1 ? '\x1b[31m⚠ overlap\x1b[0m ' : ''
          out.push(`    ${topics.padEnd(14)}  ${marker}${ids.join(', ')}`)
        }
      }
      out.push('')
      out.push('\x1b[1mRecent drops\x1b[0m')
      const drops = status?.recentDrops ?? []
      if (!drops.length) out.push('  \x1b[2m(none)\x1b[0m')
      const limit = Math.max(3, rows - out.length - 5)
      for (const d of drops.slice(-limit).reverse()) {
        const t = new Date(d.ts).toLocaleTimeString()
        out.push(`  ${t}  ${d.chatId}  topic=${d.threadId ?? '∅'}`)
      }
      return out
    }

    // --- Key handling ----------------------------------------------
    const onKey = (raw: string) => {
      // Quit shortcuts work in any mode/view (except eating chars inside text input)
      if (!inputMode && (raw === 'q' || raw === '\x03')) return quit()
      if (raw === '\x03') return quit()  // Ctrl-C always

      if (inputMode) return onKeyInput(raw)

      // View-specific
      if (view === 'main') return onKeyMain(raw)
      if (view === 'detail') return onKeyDetail(raw)
      if (view === 'resume') return onKeyResume(raw)
      if (view === 'logs' || view === 'coverage') {
        if (raw === '\x1b' || raw === 'L' || raw === 'c') { view = 'main'; draw() }
        return
      }
    }

    const onKeyInput = (raw: string) => {
      if (!inputMode) return
      const k = inputMode.kind

      // Confirm prompts use y/n
      if (k === 'confirm') {
        if (raw === 'y' || raw === 'Y' || raw === '\r' || raw === '\n') {
          const fn = inputMode.onYes; inputMode = null; fn(); draw()
        } else if (raw === 'n' || raw === 'N' || raw === '\x1b') {
          inputMode = null; draw()
        }
        return
      }

      // Text-input prompts
      if (raw === '\x1b') { inputMode = null; draw(); return }
      if (raw === '\r' || raw === '\n') return submitInput()
      if (raw === '\x7f' || raw === '\b') {
        inputMode = { ...inputMode, value: inputMode.value.slice(0, -1) } as InputMode
        draw(); return
      }
      // Append printable characters (ignore other control bytes)
      if (raw.length === 1 && raw >= ' ' && raw !== '\x7f') {
        inputMode = { ...inputMode, value: inputMode.value + raw } as InputMode
        draw()
      } else if (raw.length > 1 && raw.charCodeAt(0) >= 0x20) {
        // Paste / multi-byte text input
        inputMode = { ...inputMode, value: inputMode.value + raw.replace(/[\r\n]/g, '') } as InputMode
        draw()
      }
    }

    const submitInput = () => {
      if (!inputMode) return
      const m = inputMode
      if (m.kind === 'filter') {
        filter = m.value
        inputMode = null
        selIdx = 0
        draw()
        return
      }
      if (m.kind === 'launchChat') {
        const next = m.value || m.chatId
        inputMode = { kind: 'launchTopic', chatId: next, topics: m.topics, cwd: m.cwd, value: m.topics }
        draw(); return
      }
      if (m.kind === 'launchTopic') {
        const next = m.value || m.topics || 'all'
        inputMode = { kind: 'launchCwd', chatId: m.chatId, topics: next, cwd: m.cwd, value: m.cwd }
        draw(); return
      }
      if (m.kind === 'launchCwd') {
        const cwd = m.value || m.cwd
        if (!m.chatId || !cwd) { flashErr('launch needs chat_id and cwd'); inputMode = null; draw(); return }
        send({ type: 'launch_session', chatId: m.chatId, topics: m.topics, cwd })
        flashOk(`launched chat=${m.chatId} topic=${m.topics}`)
        inputMode = null; draw(); return
      }
      if (m.kind === 'resumeChat') {
        const next = m.value || m.chatId
        if (!next) { flashErr('resume needs chat_id'); return }
        inputMode = { kind: 'resumeTopic', sessionId: m.sessionId, chatId: next, cwd: m.cwd, value: 'all' }
        draw(); return
      }
      if (m.kind === 'resumeTopic') {
        const topic = m.value || 'all'
        send({ type: 'resume_session', sessionId: m.sessionId, chatId: m.chatId, topic, cwd: m.cwd })
        flashOk(`resumed ${m.sessionId.slice(0, 8)} chat=${m.chatId} topic=${topic}`)
        inputMode = null
        view = 'main'
        draw(); return
      }
    }

    const onKeyMain = (raw: string) => {
      if (raw === '\x1b[A') { selIdx = Math.max(0, selIdx - 1); draw(); return }      // ↑
      if (raw === '\x1b[B') { selIdx = selIdx + 1; draw(); return }                    // ↓
      if (raw === '\r' || raw === '\n' || raw === 'd') { view = 'detail'; permIdx = 0; draw(); return }
      if (raw === '/') { inputMode = { kind: 'filter', value: filter }; draw(); return }
      if (raw === '\x1b') { filter = ''; draw(); return }
      if (raw === 's') {
        const order: SortField[] = ['cwd', 'branch', 'uptime', 'pending', 'msgs']
        sortField = order[(order.indexOf(sortField) + 1) % order.length]
        draw(); return
      }
      if (raw === 'S') { sortDir = sortDir === 'asc' ? 'desc' : 'asc'; draw(); return }
      if (raw === 'k') {
        const s = selected(); if (!s) return
        inputMode = { kind: 'confirm', prompt: `Kill session ${s.id}?`, onYes: () => {
          send({ type: 'kill_session', id: s.id }); flashOk(`kill sent for ${s.id}`)
        }}; draw(); return
      }
      if (raw === 'r') {
        const s = selected(); if (!s) return
        inputMode = { kind: 'confirm', prompt: `Restart session ${s.id}?`, onYes: () => {
          send({ type: 'restart_session', id: s.id }); flashOk(`restart sent for ${s.id}`)
        }}; draw(); return
      }
      if (raw === 'l') {
        const s = selected()
        const chatDefault = s?.chatId ?? sessions.find(x => x.chatId)?.chatId ?? ''
        const cwdDefault = s?.cwd ?? sessions.find(x => x.cwd)?.cwd ?? process.cwd()
        const topicDefault = s ? s.topics.replace(/[\[\]"]/g, '') : 'all'
        inputMode = { kind: 'launchChat', chatId: chatDefault, topics: topicDefault, cwd: cwdDefault, value: chatDefault }
        draw(); return
      }
      if (raw === 'R') {
        send({ type: 'list_saved_sessions' })
        view = 'resume'; savedIdx = 0
        draw(); return
      }
      if (raw === 'L') {
        send({ type: 'tail_logs', lines: 100 })
        view = 'logs'
        draw(); return
      }
      if (raw === 'c') { view = 'coverage'; draw(); return }
    }

    const onKeyDetail = (raw: string) => {
      if (raw === '\x1b' || raw === 'd') { view = 'main'; draw(); return }
      const s = selected()
      if (!s) return
      if (raw === '\x1b[A') { permIdx = Math.max(0, permIdx - 1); draw(); return }
      if (raw === '\x1b[B') { permIdx = permIdx + 1; draw(); return }
      if (raw === 'a' || raw === 'D') {
        const p = s.pendingPerms[permIdx]
        if (!p) { flashErr('no pending permission selected'); return }
        const behavior = raw === 'a' ? 'allow' : 'deny'
        send({ type: 'permission_respond', request_id: p.request_id, behavior })
        flashOk(`${behavior} sent for ${p.tool_name}`)
        return
      }
      if (raw === 'k') {
        inputMode = { kind: 'confirm', prompt: `Kill session ${s.id}?`, onYes: () => {
          send({ type: 'kill_session', id: s.id }); flashOk(`kill sent for ${s.id}`); view = 'main'
        }}; draw(); return
      }
      if (raw === 'r') {
        inputMode = { kind: 'confirm', prompt: `Restart session ${s.id}?`, onYes: () => {
          send({ type: 'restart_session', id: s.id }); flashOk(`restart sent for ${s.id}`)
        }}; draw(); return
      }
    }

    const onKeyResume = (raw: string) => {
      if (raw === '\x1b') { view = 'main'; draw(); return }
      if (raw === '\x1b[A') { savedIdx = Math.max(0, savedIdx - 1); draw(); return }
      if (raw === '\x1b[B') { savedIdx = savedIdx + 1; draw(); return }
      if (raw === '\r' || raw === '\n') {
        const saved = savedSessions[savedIdx]
        if (!saved) { flashErr('no saved session selected'); return }
        const cur = selected()
        const chatDefault = cur?.chatId ?? sessions.find(s => s.chatId)?.chatId ?? ''
        inputMode = { kind: 'resumeChat', sessionId: saved.sessionId, chatId: chatDefault, cwd: saved.cwd, value: chatDefault }
        draw(); return
      }
    }

    // --- Lifecycle -------------------------------------------------
    const quit = () => {
      if (done) return
      done = true
      if (pollTimer) clearInterval(pollTimer)
      try { sock?.destroy() } catch {}
      try { if (process.stdin.isTTY) process.stdin.setRawMode(false) } catch {}
      process.stdin.pause()
      process.stdout.write('\x1b[2J\x1b[H')
      resolve()
    }

    // Raw mode lets us read keypresses (arrows, single chars) without
    // requiring Enter; skip when stdin isn't a TTY (piped input still
    // works for scripted testing, just one keystroke per chunk).
    try { if (process.stdin.isTTY) process.stdin.setRawMode(true) } catch {}
    process.stdin.resume()
    process.stdin.on('data', (d: any) => onKey(d.toString()))
    process.on('SIGINT', quit)
    process.on('SIGTERM', quit)

    // Periodic redraw so flash messages clear and uptime updates between
    // server polls.
    setInterval(() => { if (!done) draw() }, 1000).unref()

    const connectOnce = () => {
      if (done) return
      buffer = ''
      const s = connect(SOCKET_PATH)
      sock = s

      s.on('connect', () => {
        connected = true
        const ask = () => send({ type: 'list_sessions' })
        ask()
        if (pollTimer) clearInterval(pollTimer)
        pollTimer = setInterval(ask, 2000)
        draw()
      })

      s.on('data', chunk => {
        buffer += chunk.toString()
        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (!line) continue
          try {
            const m = JSON.parse(line)
            if (m.type === 'sessions') {
              sessions = m.sessions as TuiSession[]
              status = m.status as TuiStatus
              draw()
            } else if (m.type === 'saved_sessions') {
              savedSessions = m.sessions as SavedSession[]
              draw()
            } else if (m.type === 'logs') {
              logs = m.lines as string[]
              draw()
            } else if (m.type === 'action_ok') {
              // optimistic flash already shown; nothing to do
            } else if (m.type === 'action_err') {
              flashErr(`${m.action}: ${m.error}`)
            }
          } catch {}
        }
      })

      s.on('error', () => {})
      s.on('close', () => {
        if (done) return
        connected = false
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        draw()
        setTimeout(connectOnce, 2000)
      })
    }

    connectOnce()
  })
}

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

/**
 * Resolve the default chat_id for a registering client that doesn't carry one.
 * Order of precedence:
 *   1. `TELEGRAM_CHAT_ID` env (listener-level override; useful in tests).
 *   2. The sole key of access.groups when there is exactly one. (The common
 *      case — one supergroup configured for this bot.)
 *   3. null, with a warning. The client may still publish if it explicitly
 *      provides chat_id at publish time, but auto-mirror won't work.
 */
function resolveDefaultChat(): string | null {
  const envChat = process.env.TELEGRAM_CHAT_ID
  if (envChat) return envChat
  const groups = Object.keys(loadAccess().groups ?? {})
  if (groups.length === 1) return groups[0]
  if (groups.length > 1) {
    process.stderr.write(`telegram listener: resolveDefaultChat: ambiguous (${groups.length} groups in access.json); set TELEGRAM_CHAT_ID to disambiguate\n`)
  }
  return null
}

/**
 * Topic-name registry (chat_id → name → thread_id). Persisted to
 * TOPIC_NAMES_FILE. Read on demand and rewritten atomically when
 * creating a new topic. Mirrors what server.ts used to do, with the
 * listener now as the single source of truth.
 */
type TopicNameMap = Record<string, Record<string, number>>

function loadTopicNames(): TopicNameMap {
  try {
    const raw = readFileSync(TOPIC_NAMES_FILE, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') return parsed as TopicNameMap
  } catch {}
  return {}
}

function saveTopicNames(map: TopicNameMap): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    const tmp = TOPIC_NAMES_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, TOPIC_NAMES_FILE)
  } catch (err) {
    process.stderr.write(`telegram listener: saveTopicNames failed: ${err}\n`)
  }
}

/**
 * Resolve one topic spec (either a numeric thread id as a string, or a
 * symbolic name) to a numeric thread id under the given chat. Creates
 * the forum topic via Bot API on cache miss and persists the mapping.
 * Returns null if creation fails (caller logs).
 */
async function resolveTopicForChat(chatId: string, spec: string): Promise<number | null> {
  if (/^\d+$/.test(spec)) return Number(spec)
  const map = loadTopicNames()
  const chatMap = map[chatId] ?? {}
  if (chatMap[spec] != null) return chatMap[spec]
  // Cache miss — create the topic.
  try {
    const result = await bot.api.createForumTopic(Number(chatId), spec)
    const id = result.message_thread_id
    if (!map[chatId]) map[chatId] = {}
    map[chatId][spec] = id
    saveTopicNames(map)
    process.stderr.write(`telegram listener: created forum topic "${spec}" → ${id} in chat ${chatId}\n`)
    return id
  } catch (err) {
    process.stderr.write(`telegram listener: createForumTopic("${spec}", chat=${chatId}) failed: ${err}\n`)
    return null
  }
}

/**
 * Split a text into Telegram-safe chunks (4096 char hard cap). Listener
 * uses this for the bus-side mirror when a publish frame arrives without
 * pre-chunked text. Mirrors server.ts:chunk(); kept inline so the listener
 * is self-contained.
 */
function chunkText(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
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

type ClientRole = 'owner' | 'observer'
type ClientKind = 'dev' | 'project_manager' | 'product_manager' | 'unknown'

interface ClientConn {
  socket: Socket
  id: string
  chatId: string | null
  topics: number[] | 'all'
  /**
   * 'owner' is the exclusive consumer of its topic — the dev agent — and
   * is subject to the 60s cooldown / replacement-on-overlap eviction.
   * 'observer' is a non-exclusive subscriber — the supervisor — that
   * coexists with owners and is never evicted (and never evicts).
   */
  role: ClientRole
  /**
   * Diagnostic label announced by the client at register time. Doesn't
   * affect routing or eviction (role does), but lets the TUI / coverage
   * view show what each session is for.
   */
  kind: ClientKind
  /**
   * Whether this client wants messages from the supergroup's General
   * topic (those arrive with no message_thread_id). Set when 'general'
   * appears in the register payload's topic list. Independent of the
   * numeric topics array.
   */
  monitorGeneral: boolean
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

interface DropRecord { chatId: string; threadId: number | null; ts: number }
const RECENT_DROPS_CAP = 100

const stats = {
  startedAt: Date.now(),
  totalInbound: 0,
  totalDelivered: 0,
  totalDropped: 0,
  byChat: new Map<string, { inbound: number; delivered: number }>(),
  recentDrops: [] as DropRecord[],
}

function recordDrop(chatId: string | undefined, threadId: number | null): void {
  stats.recentDrops.push({ chatId: chatId ?? '', threadId, ts: Date.now() })
  if (stats.recentDrops.length > RECENT_DROPS_CAP) {
    stats.recentDrops.splice(0, stats.recentDrops.length - RECENT_DROPS_CAP)
  }
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

/**
 * Route an inbound message to matching clients. Returns true if at least
 * one client received it.
 *
 * `excludeClientId` is used by the `publish` relay so an agent's own send
 * doesn't echo back to itself — a peer on the same topic (rare, but
 * possible if eviction is mid-flight) still receives it.
 */
function dispatchToClients(msg: Record<string, string | undefined>, excludeClientId?: string): boolean {
  const chatId = msg.chat_id
  const threadId = msg.message_thread_id ? Number(msg.message_thread_id) : null

  stats.totalInbound++
  const chatStats = stats.byChat.get(chatId ?? '') ?? { inbound: 0, delivered: 0 }
  chatStats.inbound++
  stats.byChat.set(chatId ?? '', chatStats)

  let delivered = false
  for (const client of clients) {
    if (excludeClientId && client.id === excludeClientId) continue
    if (client.chatId !== chatId) continue
    if (client.topics !== 'all') {
      if (threadId == null) {
        // General-topic message: only deliver to clients that asked
        // for it explicitly (Product Manager pattern). Numeric-topic
        // subscribers don't see general traffic.
        if (!client.monitorGeneral) continue
      } else if (!client.topics.includes(threadId)) {
        continue
      }
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
    recordDrop(chatId, threadId)
  }
  return delivered
}

/* ------------------------------------------------------------------ */
/*  Permission relay                                                   */
/* ------------------------------------------------------------------ */

// Stores permission details for "See more" expansion, plus which client owns it.
// createdAt lets the TUI surface request age.
const permissionDetails = new Map<string, {
  tool_name: string
  description: string
  input_preview: string
  clientId: string
  createdAt: number
}>()

function handlePermissionRequest(client: ClientConn, msg: {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}): void {
  const { request_id, tool_name, description, input_preview } = msg
  client.pendingPermissions.add(request_id)
  permissionDetails.set(request_id, { tool_name, description, input_preview, clientId: client.id, createdAt: Date.now() })

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

/**
 * Async portion of the register handler. Owns topic-name resolution
 * (Phase 4 step 1) — non-numeric topic specs are looked up in the
 * registry or created via bot.api.createForumTopic. The synchronous
 * eviction logic runs only after numeric thread ids are known.
 */
async function applyRegister(client: ClientConn, msg: Record<string, unknown>): Promise<void> {
  // chat_id is optional — listener owns the channel→chat mapping.
  const providedChat = msg.chat_id as string | undefined
  client.chatId = providedChat && providedChat.length > 0
    ? providedChat
    : resolveDefaultChat()
  client.role = (msg.role as string) === 'observer' ? 'observer' : 'owner'
  client.kind = (() => {
    const k = msg.kind as string | undefined
    if (k === 'dev' || k === 'project_manager' || k === 'product_manager') return k
    return 'unknown'
  })()
  client.cwd = (msg.cwd as string) ?? null

  // Parse raw topic specs into an array of strings (names or numerics)
  // or 'all'. Accept legacy shapes ('all', number[], comma-string) plus
  // the new 'channel'/'topics' field that may now contain names. The
  // literal 'general' is a sentinel for the supergroup's General forum
  // topic (messages with no message_thread_id) — never a forum topic
  // to create.
  const rawTopics = msg.topics ?? msg.channel
  let topicSpecs: string[] | 'all'
  // 'all' (legacy) and '*' (wildcard, PM convention) both mean "every channel".
  if (rawTopics === 'all' || rawTopics === '*' || rawTopics == null) {
    topicSpecs = 'all'
  } else if (Array.isArray(rawTopics)) {
    topicSpecs = rawTopics.map(String)
  } else {
    topicSpecs = String(rawTopics).split(',').map(s => s.trim()).filter(Boolean)
  }

  // Resolve names → numeric thread ids. Requires a chat to create new
  // topics in; if no chat resolves and any non-numeric/non-'general'
  // spec is present, fail the registration with a clear error.
  client.monitorGeneral = false
  if (topicSpecs === 'all') {
    client.topics = 'all'
    // 'all' implicitly covers the General topic too.
    client.monitorGeneral = true
  } else {
    const numeric: number[] = []
    const needsResolution = topicSpecs.filter(s => s !== 'general' && !/^\d+$/.test(s))
    if (needsResolution.length && !client.chatId) {
      process.stderr.write(`telegram listener: client ${client.id} register failed — topic name resolution needs a chat (none resolved)\n`)
      sendToClient(client, { type: 'shutdown', reason: 'topic name resolution requires a chat' })
      setTimeout(() => removeClient(client), 1000)
      return
    }
    for (const spec of topicSpecs) {
      if (spec === 'general') { client.monitorGeneral = true; continue }
      const id = /^\d+$/.test(spec)
        ? Number(spec)
        : await resolveTopicForChat(client.chatId!, spec)
      if (id == null) {
        sendToClient(client, { type: 'shutdown', reason: `failed to create or resolve topic "${spec}"` })
        setTimeout(() => removeClient(client), 1000)
        return
      }
      numeric.push(id)
    }
    client.topics = numeric
  }

  if (client.cwd && client.chatId) {
    lastKnownCwd.set(client.chatId, client.cwd)
  }

  // Exclusive topic locking applies only between *owners*.
  // - Observer ↔ owner: coexist (supervisor watches an owner's topic).
  // - Observer ↔ observer: coexist (multiple watchers fine).
  // - Owner ↔ owner: cooldown-protected eviction as before.
  // dispatchToClients already delivers to every matching client, so
  // both an owner and an observer on the same topic each get inbound.
  const EVICT_COOLDOWN_MS = 60_000
  if (client.role === 'owner') {
    for (const other of [...clients]) {
      if (other === client) continue
      if (other.role !== 'owner') continue  // observers don't conflict
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
        const age = Date.now() - other.connectedAt
        if (age < EVICT_COOLDOWN_MS) {
          process.stderr.write(`telegram listener: rejecting client ${client.id} — client ${other.id} is ${Math.round(age / 1000)}s old (cooldown ${EVICT_COOLDOWN_MS / 1000}s)\n`)
          sendToClient(client, { type: 'shutdown', reason: 'topic already served by a recent session' })
          setTimeout(() => removeClient(client), 1000)
          return
        }
        process.stderr.write(`telegram listener: client ${other.id} evicted — topic conflict with ${client.id}\n`)
        sendToClient(other, { type: 'shutdown', reason: 'replaced by new session' })
        setTimeout(() => removeClient(other), 1000)
      }
    }
  }

  if (!clients.includes(client)) clients.push(client)
  process.stderr.write(
    `telegram listener: client ${client.id} registered — ` +
    `chat=${client.chatId} topics=${JSON.stringify(client.topics)}` +
    `${client.monitorGeneral && client.topics !== 'all' ? '+general' : ''} ` +
    `role=${client.role} kind=${client.kind} (${clients.length} total)\n`,
  )
  // Echo back the resolved chat AND resolved numeric topics so the
  // client can adopt them as effectiveChatId / effectiveTopics without
  // having been told either by env.
  sendToClient(client, {
    type: 'registered',
    id: client.id,
    chat_id: client.chatId,
    topics: client.topics,
    role: client.role,
    kind: client.kind,
    monitor_general: client.monitorGeneral,
  })
}

// Photo extensions that go via sendPhoto (inline preview); the rest go
// via sendDocument. Mirrors server.ts:PHOTO_EXTS.
const TG_PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

/**
 * RPC dispatcher for `tg_request`. Each op is a Telegram-side operation
 * whose result the client needs synchronously (a new message_id, a
 * downloaded file path, …). Mirrors the bot.api.* calls that used to
 * live in server.ts so the agent process can stay tokenless.
 *
 * Returns once a tg_response has been sent. Errors thrown here are
 * caught by the case-arm and translated into ok:false responses.
 */
async function handleTgRequest(
  client: ClientConn,
  reqId: string,
  op: string,
  args: Record<string, unknown>,
): Promise<void> {
  const chatId = (args.chat_id as string | undefined) || client.chatId || ''
  const reply = (payload: Record<string, unknown>) => {
    sendToClient(client, { type: 'tg_response', req_id: reqId, ...payload })
  }
  if (!chatId) return reply({ ok: false, error: 'no chat_id resolved for client' })

  switch (op) {
    case 'send_file': {
      const files = (args.files as string[] | undefined) ?? []
      if (!files.length) return reply({ ok: false, error: 'no files' })
      const messageThreadId = args.message_thread_id != null ? Number(args.message_thread_id) : undefined
      const replyTo = args.reply_to != null ? Number(args.reply_to) : undefined
      const access = loadAccess()
      const replyMode = access.replyToMode ?? 'first'
      const messageIds: number[] = []
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        const ext = extname(f).toLowerCase()
        const input = new InputFile(f)
        const opts: Record<string, unknown> = {
          ...(messageThreadId != null ? { message_thread_id: messageThreadId } : {}),
          ...(replyTo != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
            ? { reply_parameters: { message_id: replyTo } }
            : {}),
        }
        const sent = TG_PHOTO_EXTS.has(ext)
          ? await bot.api.sendPhoto(chatId, input, opts)
          : await bot.api.sendDocument(chatId, input, opts)
        messageIds.push(sent.message_id)
      }
      return reply({ ok: true, result: { message_ids: messageIds } })
    }
    case 'react': {
      const messageId = Number(args.message_id)
      const emoji = String(args.emoji ?? '')
      if (!messageId || !emoji) return reply({ ok: false, error: 'message_id and emoji required' })
      await bot.api.setMessageReaction(chatId, messageId, [
        { type: 'emoji', emoji } as ReactionTypeEmoji,
      ])
      return reply({ ok: true })
    }
    case 'edit': {
      const messageId = Number(args.message_id)
      const text = String(args.text ?? '')
      if (!messageId || !text) return reply({ ok: false, error: 'message_id and text required' })
      const format = (args.format as string | undefined) ?? 'text'
      const parseMode = format === 'markdownv2' ? 'MarkdownV2' as const : undefined
      const edited = await bot.api.editMessageText(chatId, messageId, text, {
        ...(parseMode ? { parse_mode: parseMode } : {}),
      })
      // Telegram returns `true | Message`; pull the id when present.
      const editedId = typeof edited === 'object' && edited != null && 'message_id' in edited
        ? (edited as { message_id: number }).message_id
        : messageId
      return reply({ ok: true, result: { message_id: editedId } })
    }
    case 'download': {
      const fileId = String(args.file_id ?? '')
      if (!fileId) return reply({ ok: false, error: 'file_id required' })
      const file = await bot.api.getFile(fileId)
      if (!file.file_path) return reply({ ok: false, error: 'no file_path from Telegram' })
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      if (!res.ok) return reply({ ok: false, error: `download failed: ${res.status} ${res.statusText}` })
      const buf = new Uint8Array(await res.arrayBuffer())
      const ext = file.file_path.includes('.') ? file.file_path.split('.').pop() : 'bin'
      mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })
      const path = join(INBOX_DIR, `${Date.now()}-${file.file_unique_id}.${ext}`)
      writeFileSync(path, buf)
      return reply({ ok: true, result: { path } })
    }
    default:
      return reply({ ok: false, error: `unknown op: ${op}` })
  }
}

function handleClientMessage(client: ClientConn, msg: Record<string, unknown>): void {
  switch (msg.type) {
    case 'register': {
      // Async — name resolution may create topics via Bot API. We never
      // await from the sync caller; errors land in stderr / a shutdown
      // frame to the client.
      void applyRegister(client, msg).catch(err => {
        process.stderr.write(`telegram listener: applyRegister error: ${err}\n`)
        try { sendToClient(client, { type: 'shutdown', reason: 'register failed' }) } catch {}
      })
      break
    }
    case 'publish': {
      // Channel-bus relay. The listener is now the *sole* sender to
      // Telegram for client-mode agents — it both (a) mirrors text to the
      // Telegram topic so humans see it once, and (b) fans the inbound
      // out to any peer registered for the target topic so a sibling
      // agent (or supervisor observer) sees a normal `inbound`
      // notification, exactly as if a human had typed it.
      //
      // The sender's own client is excluded from fan-out by client.id, and
      // Telegram never echoes the bot's own messages via getUpdates, so
      // both sides receive exactly one copy.
      //
      // Gated to registered clients (chatId !== null); the TUI/admin
      // socket gets action_err if it tries to publish.
      if (client.chatId === null) {
        sendToClient(client, { type: 'action_err', action: 'publish', error: 'not registered' })
        break
      }
      const text = String(msg.text ?? '')
      if (!text) break

      // Resolve target. `to` is the channel-centric alias for
      // message_thread_id; either keeps backwards compat.
      const chatIdP = (msg.chat_id as string) || client.chatId
      const rawThread = msg.message_thread_id ?? msg.to
      let threadIdP: string | undefined
      if (rawThread != null) {
        threadIdP = String(rawThread)
      } else if (client.topics !== 'all' && client.topics.length === 1) {
        // No explicit target — default to the client's own single channel.
        threadIdP = String(client.topics[0])
      }

      const replyTo = msg.reply_to != null ? Number(msg.reply_to) : undefined
      const parseMode = (msg.parse_mode as string | undefined) === 'MarkdownV2' ? 'MarkdownV2' as const : undefined

      // --- (a) Telegram mirror (listener-owned Bot API send). Best-effort:
      //     chunk per access settings and fire-and-forget. We don't await
      //     because fan-out shouldn't be gated by Telegram round-trip latency.
      if (chatIdP) {
        const access = loadAccess()
        const limit = Math.max(1, Math.min(access.textChunkLimit ?? 4096, 4096))
        const mode = access.chunkMode ?? 'length'
        const replyMode = access.replyToMode ?? 'first'
        const chunks = chunkText(text, limit, mode)
        ;(async () => {
          for (let i = 0; i < chunks.length; i++) {
            const shouldReplyTo = replyTo != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
            try {
              await bot.api.sendMessage(chatIdP, chunks[i], {
                ...(threadIdP != null ? { message_thread_id: Number(threadIdP) } : {}),
                ...(shouldReplyTo ? { reply_parameters: { message_id: replyTo! } } : {}),
                ...(parseMode ? { parse_mode: parseMode } : {}),
              })
            } catch (err) {
              process.stderr.write(`telegram listener: publish mirror failed for client ${client.id} (chunk ${i + 1}/${chunks.length}): ${err}\n`)
              break  // stop on first failure; peer fan-out below still happens
            }
          }
        })()
      }

      // --- (b) Peer fan-out to other registered clients on this channel.
      //     Sender is excluded by client.id so no self-echo.
      const payload: Record<string, string | undefined> = {
        chat_id: chatIdP,
        message_thread_id: threadIdP,
        text,
        user: (msg.from as string) ?? client.id,
        user_id: '',
        ts: String(Date.now()),
      }
      dispatchToClients(payload, client.id)
      break
    }
    case 'tg_request': {
      // RPC: the client asks the listener to perform a Telegram-side
      // operation that needs a reply (op = send_file | react | edit |
      // download). The listener owns the bot token; the agent process
      // remains tokenless. Gated to registered clients.
      if (client.chatId === null) {
        sendToClient(client, { type: 'tg_response', req_id: msg.req_id, ok: false, error: 'not registered' })
        break
      }
      const reqId = String(msg.req_id ?? '')
      const op = String(msg.op ?? '')
      const rawArgs = msg.args
      const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>
      if (!reqId) {
        sendToClient(client, { type: 'tg_response', req_id: '', ok: false, error: 'missing req_id' })
        break
      }
      void handleTgRequest(client, reqId, op, args).catch(err => {
        const error = err instanceof Error ? err.message : String(err)
        sendToClient(client, { type: 'tg_response', req_id: reqId, ok: false, error })
      })
      break
    }
    case 'list_sessions': {
      // Used by the --tui dashboard. The requester is just a socket
      // connection (it never sends `register`), so it is not in clients[].
      const claude = listClaudeSessions()
      const now = Date.now()
      const payload = clients.map(c => {
        const g = gitInfoFor(c.cwd)
        // Best-effort match of a Claude sessionId by working directory.
        const match = c.cwd ? claude.find(s => s.cwd === c.cwd) : undefined
        // Resolve pending-permission details for the inline approval view.
        const pendingPerms: Array<{
          request_id: string; tool_name: string; description: string; input_preview: string; ageMs: number
        }> = []
        for (const rid of c.pendingPermissions) {
          const d = permissionDetails.get(rid)
          if (d) pendingPerms.push({
            request_id: rid,
            tool_name: d.tool_name,
            description: d.description,
            input_preview: d.input_preview,
            ageMs: now - d.createdAt,
          })
        }
        return {
          id: c.id,
          sessionId: match?.sessionId ?? null,
          cwd: c.cwd,
          branch: g.branch,
          worktree: g.worktree,
          dirty: g.dirty,
          ahead: g.ahead,
          behind: g.behind,
          hasUpstream: g.hasUpstream,
          topics: JSON.stringify(c.topics),
          chatId: c.chatId,
          uptimeMs: now - c.connectedAt,
          messages: c.messagesDelivered,
          pending: c.pendingPermissions.size,
          pendingPerms,
        }
      })
      const status = {
        daemonStartedAt: stats.startedAt,
        daemonUptimeMs: now - stats.startedAt,
        totalInbound: stats.totalInbound,
        totalDelivered: stats.totalDelivered,
        totalDropped: stats.totalDropped,
        recentDrops: stats.recentDrops.slice(-25),
        socketPath: SOCKET_PATH,
        clientsCount: clients.length,
      }
      sendToClient(client, { type: 'sessions', sessions: payload, status })
      break
    }
    case 'kill_session': {
      if (client.chatId !== null) break  // only admin (non-registered) sockets
      const id = String(msg.id ?? '')
      const target = clients.find(c => c.id === id)
      if (!target) { sendToClient(client, { type: 'action_err', action: 'kill', id, error: 'not found' }); break }
      killSession(target, 'killed via TUI')
      sendToClient(client, { type: 'action_ok', action: 'kill', id })
      break
    }
    case 'restart_session': {
      if (client.chatId !== null) break
      const id = String(msg.id ?? '')
      const target = clients.find(c => c.id === id)
      if (!target) { sendToClient(client, { type: 'action_err', action: 'restart', id, error: 'not found' }); break }
      const chatIdR = target.chatId
      const cwdR = target.cwd ?? (chatIdR ? lastKnownCwd.get(chatIdR) ?? '' : '')
      const topicsR = target.topics === 'all' ? 'all' : (target.topics as number[]).join(',')
      if (!chatIdR || !cwdR) {
        sendToClient(client, { type: 'action_err', action: 'restart', id, error: 'missing chat/cwd' })
        break
      }
      killSession(target, 'restarted via TUI')
      setTimeout(() => spawnClaudeSession(chatIdR, topicsR, cwdR), 500)
      sendToClient(client, { type: 'action_ok', action: 'restart', id })
      break
    }
    case 'launch_session': {
      if (client.chatId !== null) break
      const chatIdL = String(msg.chatId ?? '')
      const topicsL = String(msg.topics ?? 'all')
      const cwdL = String(msg.cwd ?? '')
      if (!chatIdL || !cwdL) {
        sendToClient(client, { type: 'action_err', action: 'launch', error: 'missing chatId/cwd' })
        break
      }
      spawnClaudeSession(chatIdL, topicsL, cwdL)
      sendToClient(client, { type: 'action_ok', action: 'launch' })
      break
    }
    case 'list_saved_sessions': {
      if (client.chatId !== null) break
      sendToClient(client, { type: 'saved_sessions', sessions: listClaudeSessions() })
      break
    }
    case 'resume_session': {
      if (client.chatId !== null) break
      const sid = String(msg.sessionId ?? '')
      const chatIdR2 = String(msg.chatId ?? '')
      const topicR = String(msg.topic ?? 'all')
      const cwdR2 = String(msg.cwd ?? '')
      if (!sid || !chatIdR2 || !cwdR2) {
        sendToClient(client, { type: 'action_err', action: 'resume', error: 'missing sessionId/chatId/cwd' })
        break
      }
      // Kick any existing session serving this chat+topic first.
      for (const c of [...clients]) {
        if (c.chatId !== chatIdR2) continue
        const overlap = c.topics === 'all' || topicR === 'all'
          || (c.topics as number[]).includes(Number(topicR))
        if (overlap) killSession(c, 'replaced by resumed session')
      }
      setTimeout(() => spawnClaudeSession(chatIdR2, topicR, cwdR2, sid), 500)
      sendToClient(client, { type: 'action_ok', action: 'resume' })
      break
    }
    case 'permission_respond': {
      if (client.chatId !== null) break
      const rid = String(msg.request_id ?? '')
      const behavior = String(msg.behavior ?? '')
      if (!rid || !behavior) {
        sendToClient(client, { type: 'action_err', action: 'permission_respond', error: 'missing request_id/behavior' })
        break
      }
      routePermissionResponse(rid, behavior)
      sendToClient(client, { type: 'action_ok', action: 'permission_respond' })
      break
    }
    case 'tail_logs': {
      if (client.chatId !== null) break
      const n = Math.max(1, Math.min(500, Number(msg.lines) || 30))
      const logFile = join(homedir(), '.claude', 'channels', 'telegram', 'server.log')
      let logLines: string[] = []
      try {
        const content = readFileSync(logFile, 'utf8')
        logLines = content.split('\n').filter(Boolean).slice(-n)
      } catch {}
      sendToClient(client, { type: 'logs', lines: logLines })
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
  const channelPrompt = `You are connected to a Telegram channel. chat_id=${chatId} message_thread_id=${topics}. When replying to Telegram messages, always pass chat_id="${chatId}" and message_thread_id="${topics}" to the reply tool. You do not need to ask for these values — they are fixed for this session.`
  const claudeArgs = [
    '--dangerously-load-development-channels', 'server:sombrax-telegram',
    '--dangerously-skip-permissions',
    '--permission-mode', 'bypassPermissions',
    '--append-system-prompt', JSON.stringify(channelPrompt),
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

interface GitInfo {
  branch: string
  worktree: string
  dirty: boolean
  ahead: number
  behind: number
  hasUpstream: boolean
}

/**
 * Resolve the git branch, (linked) worktree path, working-tree dirtiness,
 * and upstream ahead/behind counts for a directory. `worktree` is the
 * worktree root only when `cwd` lives inside a linked git worktree (its
 * git dir is under .git/worktrees/...); for a normal clone it is '' so
 * the dashboard shows '-'. All fields fail soft when `cwd` is not a repo.
 */
function gitInfoFor(cwd: string | null): GitInfo {
  const empty: GitInfo = { branch: '', worktree: '', dirty: false, ahead: 0, behind: 0, hasUpstream: false }
  if (!cwd) return empty
  const git = (...args: string[]): string => {
    try {
      const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 2000 })
      if (r.status !== 0) return ''
      return (r.stdout ?? '').trim()
    } catch { return '' }
  }
  let branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (!branch) return empty  // not a git repo
  if (branch === 'HEAD') {
    const sha = git('rev-parse', '--short', 'HEAD')
    branch = sha ? `(detached ${sha})` : '(detached)'
  }
  const gitDir = git('rev-parse', '--absolute-git-dir')
  const worktree = gitDir.includes('/worktrees/')
    ? git('rev-parse', '--show-toplevel')
    : ''
  const dirty = git('status', '--porcelain').length > 0
  // ahead/behind: `git rev-list --left-right --count @{upstream}...HEAD`
  // emits "<behind>\t<ahead>". Fails (empty) if there is no upstream.
  const ab = git('rev-list', '--left-right', '--count', '@{upstream}...HEAD')
  let ahead = 0, behind = 0, hasUpstream = false
  if (ab) {
    const parts = ab.split(/\s+/)
    if (parts.length === 2) {
      behind = Number(parts[0]) || 0
      ahead = Number(parts[1]) || 0
      hasUpstream = true
    }
  }
  return { branch, worktree, dirty, ahead, behind, hasUpstream }
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
    `/logs [n] — last n lines of server.log (default 30)\n` +
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

  // Filter sessions: if a client is connected for this chat, only show sessions
  // from the same CWD. If no client is connected, show all sessions.
  const activeClients = clients.filter(c => c.chatId === chatId)
  const activeCwd = activeClients.length > 0 && activeClients[0].cwd ? activeClients[0].cwd : null
  const filtered = activeCwd
    ? sessions.filter(s => s.cwd === activeCwd)
    : sessions

  if (filtered.length === 0) {
    const hint = activeCwd ? ` for ${activeCwd}` : ''
    await bot.api.sendMessage(chatId, `No saved sessions found${hint}.`, opts)
    return
  }

  // No args — list available sessions with inline buttons
  const shown = filtered.slice(-10) // last 10
  let text = activeCwd
    ? `Sessions in ${activeCwd} (${shown.length}/${filtered.length}):\n\n`
    : `All sessions (${shown.length}/${filtered.length}):\n\n`
  const buttons: { text: string; data: string }[][] = []
  for (const s of shown) {
    const label = s.name || s.cwd.split('/').pop() || s.sessionId.slice(0, 8)
    text += `${s.sessionId.slice(0, 8)} — ${s.cwd}${s.name ? ` (${s.name})` : ''}\n`
    buttons.push([{ text: `Resume ${label}`, data: `resume:${s.sessionId}` }])
  }

  const keyboard = { inline_keyboard: buttons.map(row => row.map(b => ({ text: b.text, callback_data: b.data }))) }
  await bot.api.sendMessage(chatId, text, { ...opts, reply_markup: keyboard })
})

bot.command('logs', async ctx => {
  if (!isAuthorized(ctx)) return

  const chatId = String(ctx.chat!.id)
  const threadId = ctx.message?.message_thread_id ?? null
  const opts = threadId != null ? { message_thread_id: threadId } : {}
  const args = (ctx.message?.text ?? '').replace(/^\/logs\s*/, '').trim()
  const lines = Number(args) || 30

  const logFile = join(homedir(), '.claude', 'channels', 'telegram', 'server.log')
  try {
    const content = readFileSync(logFile, 'utf8')
    const allLines = content.split('\n').filter(Boolean)
    const tail = allLines.slice(-lines).join('\n')
    if (!tail) {
      await bot.api.sendMessage(chatId, 'Server log is empty.', opts)
    } else {
      // Telegram message limit is 4096 chars
      const truncated = tail.length > 4000 ? '...' + tail.slice(-4000) : tail
      await bot.api.sendMessage(chatId, `\`\`\`\n${truncated}\n\`\`\``, { ...opts, parse_mode: 'MarkdownV2' }).catch(async () => {
        // Fallback without markdown if escaping fails
        await bot.api.sendMessage(chatId, truncated, opts)
      })
    }
  } catch {
    await bot.api.sendMessage(chatId, 'No server log found.', opts)
  }
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
    role: 'owner',   // overwritten on register; default is the exclusive dev-agent case
    kind: 'unknown', // overwritten on register
    monitorGeneral: false,
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
              { command: 'logs', description: 'View server.log (last 30 lines)' },
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
