/**
 * answer-card · DeepSeek Harness (DSH) 适配层。
 *
 * 薄桥接层：所有 macOS 悬浮窗渲染、编译缓存、前台探测、应用激活与载荷构造均复用 `../../core/*`。
 * 保留 DSH 全部原功能与接口兼容：
 *   1. `approval/request`（waterfall prepend）
 *   2. `user-questions/request`（waterfall prepend）
 *   3. `agent/status` running→idle 完成提醒 + 跨 workspace 跳会话聚焦输入框
 *   4. `/dsh-answer-card/*` 设置页与自检接口
 *
 * @module answer-card/adapters/dsh
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  activateHost,
  createCardQueue,
  createTracer,
  ensureHelper,
  isHostFocused,
  parseHelperOutput,
  showCard,
  withCardLock,
} from '../../core/helper.mjs'
import {
  baseName,
  buildApprovalPayload,
  buildCompletePayload,
  buildQuestionPayload,
  buildReturnTestPayload,
  buildTestPayload,
  mapQuestionAnswers,
  shorten,
  supportsFollowUp,
} from '../../core/protocol.mjs'
import {
  DEFAULT_SETTINGS,
  HOST_PROFILES,
  POSITIONS,
  defaultSettingsPath,
  migrateLegacyHostSettings,
  muteReasonOf as coreMuteReasonOf,
  readRecent,
  resolveSettings,
  settingsMtime,
  writeRecent,
  writeSettings,
} from '../../core/settings.mjs'
import { handleToolCall } from '../antigravity/mcp-app.mjs'
import { resolveHostTheme, writeHostThemeSnapshot } from '../../core/theme.mjs'

export { parseHelperOutput, shorten }

/**
 * 把卡片里输入的追问交给 DSH agent，开一个新回合；不抢焦点、不切换窗口。
 * @param {{ followup?: (input: { content: Array<{ type: string, text: string }>, source: { kind: string } }) => void } | null} agent
 * @param {string} text
 * @returns {boolean} 是否已成功投递
 */
export function sendFollowUp(agent, text) {
  const content = String(text ?? '').trim()
  if (content.length === 0) return false
  if (typeof agent?.followup !== 'function') return false
  agent.followup({ content: [{ type: 'text', text: content }], source: { kind: 'user' } })
  return true
}

export const name = 'answer-card'
export const inject = []

export const DEFAULT_CONFIG = {
  confirmApprovals: true,
  answerQuestions: true,
  notifyOnComplete: true,
  ignoreSubagents: true,
  skipWhenDSHFocused: true,
  dshBundleIds: [...HOST_PROFILES.dsh.bundleIds],
  dshProcessNames: [...HOST_PROFILES.dsh.processNames],
  autoDismissMs: 0,
  completeCooldownMs: 10000,
  helperPath: '',
  traceFile: '',
  settingsFile: '',
}

function dshSettingsPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-answer-card.json')
}

function dshRecentPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-answer-card-recent.json')
}

export function isSubagent(agent, ignore) {
  if (!ignore) return false
  const header = agent?.session?.header
  if (header?.origin === 'subagent') return true
  return typeof header?.delegationDepth === 'number' && header.delegationDepth > 0
}

export function titleOf(ctx, agent) {
  const session = agent?.session
  try {
    const title = ctx?.get?.('sessionTitle')?.get?.(session)?.title
    if (typeof title === 'string' && title.trim().length > 0) return title.trim()
  } catch {
    // 服务缺席时退回兜底。
  }
  const dir = baseName(session?.header?.cwd)
  if (dir) return dir
  const id = typeof session?.id === 'string' ? session.id : ''
  return id.length >= 8 ? id.slice(0, 8) : HOST_PROFILES.dsh.displayName
}

export function muteReasonOf(agent, settings) {
  return coreMuteReasonOf(
    { sessionId: agent?.session?.id, cwd: agent?.session?.header?.cwd },
    settings,
  )
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  const explicitSettingsFile = typeof config.settingsFile === 'string' && config.settingsFile.length > 0
  const settingsFile = explicitSettingsFile ? config.settingsFile : defaultSettingsPath()
  if (!explicitSettingsFile) migrateLegacyHostSettings('dsh', dshSettingsPath(), settingsFile)
  const recentFile = dshRecentPath()

  let pendingFocus = null
  const FOCUS_TTL_MS = 60_000

  let cachedSettings = resolveSettings(config, settingsFile, 'dsh')
  let cachedMtime = settingsMtime(settingsFile)
  function settings() {
    const mtime = settingsMtime(settingsFile)
    if (mtime !== cachedMtime) {
      cachedMtime = mtime
      cachedSettings = resolveSettings(config, settingsFile, 'dsh')
    }
    return cachedSettings
  }

  let recent = readRecent(recentFile)
  let recentDirty = false
  let recentSavedAt = 0

  function remember(agent) {
    const id = agent?.session?.id
    if (typeof id !== 'string' || id.length === 0) return
    const entry = {
      id,
      title: titleOf(ctx, agent),
      cwd: typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : '',
      lastAt: Date.now(),
    }
    recent = [entry, ...recent.filter((item) => item.id !== id)]
      .slice(0, 60)
      .sort((a, b) => b.lastAt - a.lastAt)
    recentDirty = true
    const now = Date.now()
    if (now - recentSavedAt > 2000) {
      recentSavedAt = now
      recentDirty = false
      writeRecent(recent, recentFile)
    }
  }

  ctx.effect(() => () => {
    if (recentDirty) writeRecent(recent, recentFile)
  })

  const trace = createTracer(config.traceFile)
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`${name}: ${message}`)
    } catch {
      // 日志服务缺席时静默。
    }
    trace(`warn: ${message}`)
  }

  let compileFailed = false
  let resolvedHelper = ''
  function ensure() {
    if (compileFailed) return false
    const res = ensureHelper({ helperPath: config.helperPath, trace, warn })
    if (!res.ok) {
      compileFailed = true
      return false
    }
    resolvedHelper = res.helperPath
    return true
  }

  const queue = createCardQueue()
  const runCard = (payload, options = {}) =>
    queue.enqueue(() =>
      withCardLock(() => showCard(resolvedHelper, payload, { ...options, autoDismissMs: settings().autoDismissMs, trace })))

  async function dshFocused() {
    return isHostFocused({
      helperPath: resolvedHelper,
      bundleIds: config.dshBundleIds,
      processNames: config.dshProcessNames,
      skipWhenHostFocused: settings().skipWhenDSHFocused !== false,
    })
  }

  function activateDSH(meta = {}) {
    const hints = [meta.title, baseName(meta.cwd), meta.cwd].filter(Boolean)
    activateHost({
      helperPath: resolvedHelper,
      bundleIds: config.dshBundleIds,
      processNames: config.dshProcessNames,
      windowHints: hints,
      returnCommand: settings().returnCommand,
      warpPointer: settings().warpPointer !== false,
      context: { host: 'dsh', sessionId: meta.sessionId, cwd: meta.cwd, title: meta.title },
      trace,
    })
  }

  if (!ensure()) trace('helper unavailable at apply time; will retry on first request')

  // --- 审批 ---
  ctx.on('approval/request', async (request, next) => {
    trace(`approval: enter tool=${request?.toolName ?? '?'} aborted=${request?.signal?.aborted === true}`)
    if (settings().confirmApprovals === false) return next()
    if (isSubagent(request?.agent, config.ignoreSubagents)) return next()
    remember(request?.agent)
    const muted = muteReasonOf(request?.agent, settings())
    if (muted !== null) {
      trace(`approval: skipped (${muted} muted)`)
      return next()
    }
    if (!ensure()) return next()
    if (await dshFocused()) {
      trace('approval: skipped (DSH focused)')
      return next()
    }
    const tool = typeof request?.toolName === 'string' && request.toolName.length > 0 ? request.toolName : '未知工具'
    const rawOpts = Array.isArray(request?.options) ? request.options : (Array.isArray(request?.choices) ? request.choices : null)
    const forwardedChoices = rawOpts && rawOpts.length > 0
      ? rawOpts.map((opt, idx) => (typeof opt === 'string'
          ? { id: opt, label: opt }
          : {
              id: String(opt?.id ?? opt?.outcome ?? opt?.value ?? idx),
              label: String(opt?.label ?? opt?.name ?? opt?.id ?? `选项 ${idx + 1}`),
              hint: typeof opt?.description === 'string' ? opt.description : undefined,
            }))
      : [
          { id: 'allowed-once', label: '允许一次' },
          { id: 'rejected', label: '拒绝' },
        ]
    const payload = buildApprovalPayload({
      host: 'dsh',
      hostLabel: HOST_PROFILES.dsh.shortName,
      title: titleOf(ctx, request?.agent),
      toolName: tool,
      reason: request?.reason,
      choices: forwardedChoices,
      settings: settings(),
    })
    trace(`approval: showing tool=${tool}`)
    const outcome = await runCard(payload, { signal: request?.signal })
    if (outcome.result === 'choose') {
      const picked = outcome.answers?.approval?.[0]
      if (picked) {
        const mapped = picked === 'allow' ? 'allowed-once' : (picked === 'deny' ? 'rejected' : picked)
        trace(`approval: ${mapped} (signal aborted=${request?.signal?.aborted === true})`)
        return mapped
      }
    }
    trace(`approval: falling back (${outcome.result})`)
    return next()
  }, true)

  ctx.on('approval/request', (request, next) => {
    trace(`approval: chain continued past answer-card tool=${request?.toolName ?? '?'}`)
    return next()
  })

  // --- 提问 / 计划待审 ---
  ctx.on('user-questions/request', async (request, next) => {
    if (settings().answerQuestions === false) return next()
    if (isSubagent(request?.agent, config.ignoreSubagents)) return next()
    remember(request?.agent)
    const muted = muteReasonOf(request?.agent, settings())
    if (muted !== null) {
      trace(`question: skipped (${muted} muted)`)
      return next()
    }
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (questions.length === 0) return next()
    if (!ensure()) return next()
    if (await dshFocused()) {
      trace('question: skipped (DSH focused)')
      return next()
    }
    const { groups, payload } = buildQuestionPayload({
      host: 'dsh',
      hostLabel: HOST_PROFILES.dsh.shortName,
      title: titleOf(ctx, request?.agent),
      questions,
      settings: settings(),
    })
    trace(`question: showing count=${questions.length}`)
    const outcome = await runCard(payload, { signal: request?.signal })
    if (outcome.result !== 'choose') {
      trace(`question: falling back (${outcome.result})`)
      return next()
    }
    const answers = mapQuestionAnswers(groups, outcome).map(({ id, selected, custom }) => ({
      id,
      selected,
      ...(custom ? { custom } : {}),
    }))
    trace(`question: answered count=${answers.length}`)
    return { answers }
  }, true)

  // --- 任务完成 ---
  const lastStatus = new Map()
  const lastCompleteAt = new Map()
  ctx.on('agent/status', ({ agent, status }) => {
    const id = typeof agent?.id === 'string' ? agent.id : 'unknown'
    const previous = lastStatus.get(id)
    lastStatus.set(id, status)
    if (settings().notifyOnComplete === false) return
    if (status !== 'idle' || previous !== 'running') return
    if (isSubagent(agent, config.ignoreSubagents)) return
    remember(agent)
    const muted = muteReasonOf(agent, settings())
    if (muted !== null) {
      trace(`complete: skipped (${muted} muted)`)
      return
    }
    const now = Date.now()
    const last = lastCompleteAt.get(id)
    if (last !== undefined && now - last < Number(settings().completeCooldownMs)) return
    lastCompleteAt.set(id, now)

    const completeTitle = titleOf(ctx, agent)
    const completeCwd = typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : ''
    // DSH 的 agent 句柄支持 followup()，完成卡直接带追问输入框（无需回到界面）。
    const payload = buildCompletePayload({
      host: 'dsh',
      hostLabel: HOST_PROFILES.dsh.shortName,
      title: completeTitle,
      settings: settings(),
      allowFollowUp: supportsFollowUp('dsh', settings()),
    })
    const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : ''
    ;(async () => {
      if (!ensure()) return
      if (await dshFocused()) {
        trace('complete: skipped (DSH focused)')
        return
      }
      const outcome = await runCard(payload)
      if (outcome.result === 'choose') {
        const followUp = String(outcome.texts?.followup ?? (outcome.answers?.followup?.[0] ?? '')).trim()
        // 卡片里写了追问：直接让 agent 开新一轮，不抢焦点、不切换窗口。
        if (followUp.length > 0) {
          let sent = false
          try {
            sent = sendFollowUp(agent, followUp)
          } catch (error) {
            trace(`complete: follow-up failed ${String(error)}`)
          }
          if (sent) {
            trace(`complete: follow-up queued chars=${followUp.length}`)
            trace('complete: closed (follow-up)')
            return
          }
          trace('complete: follow-up unavailable, falling back to activate')
        }
        const custom = String(settings().returnCommand ?? '').trim()
        pendingFocus = custom.length === 0 && sessionId.length > 0 ? { sessionId, at: Date.now() } : null
        trace(`complete: open DSH session=${sessionId || 'none'}${custom.length > 0 ? ' (custom command)' : ''}`)
        activateDSH({ sessionId, cwd: completeCwd, title: completeTitle })
      }
      trace(`complete: closed (${outcome.result})`)
    })().catch(() => undefined)
  })

  // --- DSH 设置页接口 ---
  function sendJson(res, status, body) {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    } catch {
      // 连接已断。
    }
  }

  function isLocalRequest(req) {
    try {
      const connection = ctx.get?.('connection')
      const rejection = typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : undefined
      if (rejection === 401 || rejection === 403) return false
    } catch {
      // 兜底来源检查。
    }
    const origin = String(req?.headers?.origin ?? '')
    return origin.length === 0 || /^(?:dsh-app:|https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?)$/i.test(origin)
  }

  function readJsonBody(req) {
    return new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 65536) {
          req.destroy()
          resolve(null)
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch {
          resolve(null)
        }
      })
      req.on('error', () => resolve(null))
    })
  }

  function mountRoute(path, handler) {
    if (typeof ctx.inject !== 'function') return
    ctx.inject(['webServer'], (scoped) =>
      scoped.effect(() => scoped.webServer.register({ kind: 'exact', path, handler })))
  }

  mountRoute('/dsh-answer-card/recent', async (req, res) => {
    if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
    const workspaces = []
    const seen = new Set()
    for (const item of recent) {
      if (item.cwd.length === 0 || seen.has(item.cwd)) continue
      seen.add(item.cwd)
      workspaces.push({ path: item.cwd, lastAt: item.lastAt })
    }
    return sendJson(res, 200, { ok: true, sessions: recent, workspaces })
  })

  mountRoute('/dsh-answer-card/settings', async (req, res) => {
    if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
    if (req.method === 'GET') {
      const current = settings()
      return sendJson(res, 200, {
        ok: true,
        settings: current,
        defaults: DEFAULT_SETTINGS,
        positions: POSITIONS,
        file: settingsFile,
        theme: resolveHostTheme({ host: 'dsh', settings: current }),
      })
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      if (body === null) return sendJson(res, 400, { ok: false, error: 'bad_json' })
      const next = writeSettings(body, settingsFile)
      cachedMtime = settingsMtime(settingsFile)
      cachedSettings = next
      trace(`settings: saved ${Object.keys(body).join(',')}`)
      return sendJson(res, 200, { ok: true, settings: next })
    }
    return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
  })

  mountRoute('/dsh-answer-card/test', async (req, res) => {
    if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
    if (!ensure()) return sendJson(res, 503, { ok: false, error: 'helper_unavailable' })
    runCard(buildTestPayload({ host: 'dsh', hostLabel: HOST_PROFILES.dsh.shortName, settings: settings() }))
      .then((outcome) => trace(`test: closed (${outcome.result})`))
    return sendJson(res, 200, { ok: true })
  })

  mountRoute('/dsh-answer-card/test-return', async (req, res) => {
    if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
    if (!ensure()) return sendJson(res, 503, { ok: false, error: 'helper_unavailable' })
    runCard(buildReturnTestPayload({ host: 'dsh', hostLabel: HOST_PROFILES.dsh.shortName, settings: settings() }))
      .then((outcome) => {
        trace(`test-return: closed (${outcome.result})`)
        if (outcome.result === 'choose') activateDSH()
      })
    return sendJson(res, 200, { ok: true })
  })

  mountRoute('/dsh-answer-card/theme', async (req, res) => {
    if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
    const body = await readJsonBody(req)
    if (body === null) return sendJson(res, 400, { ok: false, error: 'bad_json' })
    const saved = writeHostThemeSnapshot('dsh', body)
    return sendJson(res, 200, { ok: true, theme: saved })
  })

  mountRoute('/dsh-answer-card/focus', async (req, res) => {
    if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
    if (pendingFocus !== null && Date.now() - pendingFocus.at > FOCUS_TTL_MS) pendingFocus = null
    if (pendingFocus !== null) trace(`focus: handed out session=${pendingFocus.sessionId}`)
    return sendJson(res, 200, { ok: true, target: pendingFocus })
  })

  mountRoute('/dsh-answer-card/focus/ack', async (req, res) => {
    if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
    pendingFocus = null
    trace('focus: acked by client')
    return sendJson(res, 200, { ok: true })
  })

  // --- 共享设置组件（与 Antigravity 同一份 UI）---
  const uiScriptPath = fileURLToPath(new URL('../../shared/ui/answer-card-settings.js', import.meta.url))

  mountRoute('/dsh-answer-card/ui.js', async (req, res) => {
    if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
    try {
      const code = readFileSync(uiScriptPath, 'utf8')
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(code)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error) })
    }
  })

  // 与 Antigravity MCP App 的 app_* 工具同构：一份 UI，两种传输。
  mountRoute('/dsh-answer-card/app', async (req, res) => {
    if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
    const body = await readJsonBody(req)
    if (!body || typeof body.name !== 'string') return sendJson(res, 400, { ok: false, error: 'bad_request' })
    try {
      const result = await handleToolCall(body.name, body.args ?? {}, { settingsFile, recentFile, hostConfig: config })
      const payload = result?.structuredContent ?? { ok: false, error: 'empty_result' }
      return sendJson(res, result?.isError ? 500 : 200, payload)
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error) })
    }
  })

  ctx.effect(() => () => {
    queue.reset()
    lastStatus.clear()
    lastCompleteAt.clear()
    trace('apply: disposed')
  })
}
