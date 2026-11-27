#!/usr/bin/env node
/**
 * answer-card · Zed 原生 Agent 回合监听器。
 *
 * Zed 原生 Agent 不暴露 hook / 事件回调，但每一步消息都会把会话写入
 * `~/Library/Application Support/Zed/threads/threads.db`（zstd 压缩的 JSON）。
 * 本进程以只读方式轮询该库：检测到某会话新增消息、最后一条 Agent 消息以文本收尾、
 * 没有待回填的工具调用，并且在静默期内不再变化时，判定该回合完成并弹出完成卡。
 * 全程由代码驱动，Agent 无需调用任何工具，也不感知卡片存在。
 *
 * 用法：
 *   node adapters/zed/native-watch.mjs             # 常驻监听
 *   node adapters/zed/native-watch.mjs --once      # 只跑一轮（排障）
 *   node adapters/zed/native-watch.mjs --dry-run   # 只输出判定结果，不弹卡
 *
 * @module answer-card/adapters/zed/native-watch
 */

import { DatabaseSync } from 'node:sqlite'
import { zstdDecompressSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  activateHost,
  createCardQueue,
  createTracer,
  ensureHelper,
  isMainModule,
  probeHostWindow,
  showCard,
  withCardLock,
} from '../../core/helper.mjs'
import { baseName, buildCompletePayload } from '../../core/protocol.mjs'
import {
  HOST_PROFILES,
  defaultSettingsPath,
  defaultStateDir,
  isCoolingDown,
  muteReasonOf,
  resolveSettings,
} from '../../core/settings.mjs'

const HOST = 'zed'
const PROFILE = HOST_PROFILES.zed
const DEFAULT_INTERVAL_MS = 1500
const DEFAULT_QUIET_MS = 2000
const MAX_CARD_MESSAGE_CHARS = 800

/**
 * Zed 原生 Agent 的会话库路径。
 * @returns {string}
 */
export function threadsDbPath() {
  return join(homedir(), 'Library', 'Application Support', 'Zed', 'threads', 'threads.db')
}

/**
 * 解压并解析一条会话载荷；格式不认识时返回 null。
 * @param {Uint8Array | Buffer} data
 * @returns {Record<string, any> | null}
 */
export function decodeThread(data) {
  try {
    return JSON.parse(zstdDecompressSync(Buffer.from(data)).toString('utf8'))
  } catch {
    return null
  }
}

/**
 * 判定会话是否刚结束一个回合：最后一条消息必须是 Agent，最后一项内容是文本，
 * 且所有 ToolUse 都已回填结果（否则说明工具还在跑）。
 * @param {Record<string, any> | null} thread
 * @returns {{ messageCount: number, text: string } | null}
 */
export function pickTurnCompletion(thread) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : []
  if (messages.length === 0) return null
  const last = messages[messages.length - 1]
  const agent = last && typeof last === 'object' ? last.Agent : undefined
  if (!agent || typeof agent !== 'object') return null
  const content = Array.isArray(agent.content) ? agent.content : []
  if (content.length === 0) return null
  const results = agent.tool_results && typeof agent.tool_results === 'object' ? agent.tool_results : {}
  const texts = []
  let trailingText = false
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    if (item.ToolUse && typeof item.ToolUse.id === 'string') {
      if (results[item.ToolUse.id] === undefined) return null
      trailingText = false
      continue
    }
    const text = typeof item.Text === 'string'
      ? item.Text
      : (item.Text && typeof item.Text.text === 'string' ? item.Text.text : null)
    if (text !== null) {
      texts.push(text)
      trailingText = true
    }
  }
  if (!trailingText) return null
  const text = texts.join('\n').trim()
  if (text.length === 0) return null
  return { messageCount: messages.length, text }
}

/**
 * 从会话数据里提取 agent 标识（provider/model），用于在卡片上区分原生 Agent 与外部 ACP Agent。
 * @param {Record<string, any> | null} thread
 * @returns {string}
 */
export function describeAgent(thread) {
  const model = thread?.model
  const provider = typeof model?.provider === 'string' ? model.provider.trim() : ''
  const name = typeof model?.model === 'string' ? model.model.trim() : ''
  if (provider && name) return `${provider}/${name}`
  return provider || name || ''
}

/**
 * 取会话最后一条消息的类型：`user` / `agent` / 空串。
 * @param {Record<string, any> | null} thread
 * @returns {'user' | 'agent' | ''}
 */
export function lastMessageKind(thread) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : []
  const last = messages[messages.length - 1]
  if (!last || typeof last !== 'object') return ''
  if (last.User) return 'user'
  if (last.Agent) return 'agent'
  return ''
}

/**
 * 只读取 Zed 会话库；数据库不存在时返回空数组。
 * @param {string} dbPath
 * @returns {Array<{ id: string, parentId: string, summary: string, updatedAt: string, folderPath: string, data: Uint8Array }>}
 */
export function readThreadRows(dbPath) {
  if (!existsSync(dbPath)) return []
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare('select id, parent_id, summary, updated_at, folder_paths, data from threads').all()
    return rows.map((row) => ({
      id: String(row.id),
      parentId: row.parent_id ? String(row.parent_id) : '',
      summary: String(row.summary ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      folderPath: String(row.folder_paths ?? ''),
      data: row.data,
    }))
  } finally {
    db.close()
  }
}

/**
 * 截断用于卡片的正文，避免完成卡被超长回复撑爆。
 * @param {string} text
 * @returns {string}
 */
function cardMessage(text) {
  const clean = text.trim()
  return clean.length > MAX_CARD_MESSAGE_CHARS ? `${clean.slice(0, MAX_CARD_MESSAGE_CHARS - 1).trimEnd()}…` : clean
}

/**
 * 输出运行期诊断信息；`--verbose` 时记录每次判定细节。
 * @param {{ verbose?: boolean }} ctx
 * @param {string} msg
 */
function note(ctx, msg) {
  if (!ctx.verbose) return
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`)
}

/**
 * 监听器状态文件路径。
 * @param {string} stateDir
 * @returns {string}
 */
export function watchStatePath(stateDir = defaultStateDir()) {
  return join(stateDir, 'zed-native-watch.json')
}

function readState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return {
      threads: parsed?.threads && typeof parsed.threads === 'object' ? parsed.threads : {},
      pending: parsed?.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
    }
  } catch {
    return { threads: {}, pending: {} }
  }
}

function writeState(file, state) {
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(temp, file)
  } catch {
    // 状态写入失败不影响监听本身。
  }
}

/**
 * 结合"App 是否前台"和"前台窗口是否就是该会话的窗口"判断是否跳过弹卡。
 * 多窗口场景下，同一个 App 的另一个窗口在前台时不应视为聚焦（卡片照常弹）。
 * @param {{ probe?: { hostFrontmost?: boolean, matched?: boolean }, skipWhenHostFocused?: boolean }} input
 * @returns {boolean}
 */
export function shouldSkipForFocus(input) {
  if (input.skipWhenHostFocused === false) return false
  const probe = input.probe
  // 探测失败时按"未聚焦"处理（失败开放：宁可多弹一次，也不要静默丢掉）。
  if (!probe || typeof probe.hostFrontmost !== 'boolean') return false
  if (!probe.hostFrontmost) return false
  // App 在前台：只有前台窗口确实是该会话窗口才跳过；被别的窗口盖住则照常弹卡。
  return probe.matched !== false
}

/**
 * 弹出完成卡；所有开关（总开关 / 静音 / 冷却 / 宿主前台）沿用共享设置。
 * @param {{ settingsFile: string, stateDir: string, trace: (msg: string) => void, queue: ReturnType<typeof createCardQueue> }} ctx
 * @param {string} threadId
 * @param {{ text: string, title: string, cwd: string, agent?: string }} pending
 * @returns {Promise<'disabled' | 'muted' | 'unavailable' | 'focused' | 'cooldown' | 'shown'>}
 */
async function fireCard(ctx, threadId, pending) {
  const settings = resolveSettings({}, ctx.settingsFile, HOST)
  if (settings.notifyOnComplete === false) return 'disabled'
  if (muteReasonOf({ sessionId: threadId, cwd: pending.cwd }, settings) !== null) return 'muted'
  const ensured = ensureHelper({ trace: ctx.trace })
  if (!ensured.ok) return 'unavailable'
  // 窗口标题形如 `RimOrbit — robot_io.py`，用项目目录名匹配最可靠。
  const hints = [baseName(pending.cwd), pending.title].filter(Boolean)
  // 前台判定放在冷却之前：被跳过时不算"已消费"。
  const probe = settings.skipWhenHostFocused === false
    ? undefined
    : await probeHostWindow({ helperPath: ensured.helperPath, bundleIds: PROFILE.bundleIds, hints })
  if (shouldSkipForFocus({ probe, skipWhenHostFocused: settings.skipWhenHostFocused })) return 'focused'
  if (isCoolingDown(`${HOST}:${threadId}`, Number(settings.completeCooldownMs ?? 10000), ctx.stateDir)) return 'cooldown'
  const payload = buildCompletePayload({
    host: HOST,
    hostLabel: PROFILE.shortName,
    title: pending.title || PROFILE.displayName,
    subtitle: pending.agent || undefined,
    message: cardMessage(pending.text),
    settings,
  })
  const outcome = await ctx.queue.enqueue(() => withCardLock(() => showCard(ensured.helperPath, payload, { trace: ctx.trace })))
  ctx.trace(`native-watch: card outcome=${String(outcome?.result)}`)
  if (outcome?.result !== 'choose') return 'shown'
  activateHost({
    helperPath: ensured.helperPath,
    bundleIds: PROFILE.bundleIds,
    processNames: PROFILE.processNames,
    windowHints: hints,
    returnCommand: settings.returnCommand,
    warpPointer: settings.warpPointer,
    context: { host: HOST, sessionId: threadId, cwd: pending.cwd, title: pending.title },
    trace: ctx.trace,
  })
  return 'shown'
}

/**
 * 跑一轮检测：更新基线、标记候选、并在静默期结束后弹卡。
 * @param {{
 *   dbPath: string,
 *   settingsFile: string,
 *   stateDir: string,
 *   intervalMs: number,
 *   quietMs: number,
 *   dryRun: boolean,
 *   trace: (msg: string) => void,
 *   queue: ReturnType<typeof createCardQueue>,
 * }} ctx
 * @returns {Promise<void>}
 */
export async function watchTick(ctx) {
  const state = readState(watchStatePath(ctx.stateDir))
  const rows = readThreadRows(ctx.dbPath)
  const now = Date.now()
  const nextThreads = {}
  let changed = false

  for (const row of rows) {
    const prev = state.threads[row.id]
    if (prev && prev.updatedAt === row.updatedAt) {
      nextThreads[row.id] = prev
      continue
    }
    const thread = decodeThread(row.data)
    const done = pickTurnCompletion(thread)
    const count = Array.isArray(thread?.messages) ? thread.messages.length : Number(prev?.count ?? 0)
    nextThreads[row.id] = { count, updatedAt: row.updatedAt }
    changed = true
    if (!prev) {
      // 首次见到该会话（冷启动或新建）：只记基线，不回放历史回合。
      delete state.pending[row.id]
      continue
    }
    if (row.parentId) {
      // 子 agent 会话（parent_id 非空）属于父回合内部的步骤，不单独弹卡。
      delete state.pending[row.id]
      note(ctx, `skip thread=${row.id} reason=subagent`)
      continue
    }
    const kind = lastMessageKind(thread)
    const grew = count > Number(prev.count ?? 0)
    if (kind === 'user') {
      // 用户发了新消息，上一轮的候选作废。
      delete state.pending[row.id]
      continue
    }
    if (done && grew) {
      state.pending[row.id] = {
        text: done.text,
        title: row.summary,
        cwd: row.folderPath,
        agent: describeAgent(thread),
        seenAt: now,
      }
      note(ctx, `complete thread=${row.id} title=${JSON.stringify(row.summary)} chars=${done.text.length}`)
      continue
    }
    if (done) continue
    // 还有工具调用在跑：说明回合仍在推进。
    if (grew) delete state.pending[row.id]
  }

  if (Object.keys(nextThreads).length !== Object.keys(state.threads).length) changed = true
  state.threads = nextThreads

  const fire = ctx.fire || fireCard
  for (const [threadId, pending] of Object.entries(state.pending)) {
    if (now - Number(pending.seenAt ?? 0) < ctx.quietMs) continue
    if (ctx.dryRun) {
      process.stdout.write(`[dry-run] complete thread=${threadId} title=${JSON.stringify(pending.title)} chars=${pending.text.length}\n`)
      delete state.pending[threadId]
      changed = true
      continue
    }
    const status = await fire(ctx, threadId, pending)
    if (status === 'focused') {
      // 宿主在前台：用户此刻就在看对话，不再延迟补发，直接丢弃避免过期卡片。
      process.stdout.write(`${new Date().toISOString()} [skip] thread=${threadId} reason=host_focused title=${JSON.stringify(pending.title)}\n`)
      delete state.pending[threadId]
      changed = true
      continue
    }
    process.stdout.write(`${new Date().toISOString()} [card] thread=${threadId} status=${status} title=${JSON.stringify(pending.title)}\n`)
    delete state.pending[threadId]
    changed = true
  }

  if (changed) writeState(watchStatePath(ctx.stateDir), state)
}

function argValue(argv, name) {
  const hit = argv.find((item) => item.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

export async function runWatch(argv = process.argv.slice(2)) {
  const settings = resolveSettings({}, defaultSettingsPath(), HOST)
  const ctx = {
    dbPath: argValue(argv, 'db') || threadsDbPath(),
    settingsFile: defaultSettingsPath(),
    stateDir: defaultStateDir(),
    intervalMs: Number(argValue(argv, 'interval') ?? DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
    quietMs: Number(argValue(argv, 'quiet') ?? DEFAULT_QUIET_MS) || DEFAULT_QUIET_MS,
    dryRun: argv.includes('--dry-run'),
    verbose: argv.includes('--verbose'),
    trace: createTracer(settings.traceFile),
    queue: createCardQueue(),
  }
  if (!existsSync(ctx.dbPath)) {
    process.stderr.write(`native-watch: 未找到 Zed 会话库 ${ctx.dbPath}\n`)
    return 1
  }
  if (argv.includes('--once')) {
    await watchTick(ctx)
    return 0
  }
  process.stdout.write(`native-watch: watching ${ctx.dbPath} (interval=${ctx.intervalMs}ms quiet=${ctx.quietMs}ms verbose=${ctx.verbose ? 'on' : 'off'})\n`)
  let running = true
  const stop = () => { running = false }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  while (running) {
    try {
      await watchTick(ctx)
    } catch (error) {
      ctx.trace(`native-watch: tick failed: ${String(error)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, ctx.intervalMs))
  }
  return 0
}

if (isMainModule(import.meta.url)) {
  runWatch().then((code) => process.exit(code ?? 0))
}
