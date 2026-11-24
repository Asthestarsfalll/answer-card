/**
 * dsh-answer-card —— macOS 屏幕悬浮窗：需要你批准 / 回答 / 收尾时，弹一张置顶卡片，
 * 点选项即等于在 DSH 里作答。
 *
 * 三个来源：
 *   1. `approval/request`（waterfall）—— 工具要权限。点「允许一次」返回 `allowed-once`，
 *      点「拒绝」返回 `rejected`；点「稍后处理」把决定交回后续 answerer（DSH 里的审批条）。
 *   2. `user-questions/request`（waterfall）—— `ask_user_question` 与计划待审。点完提交后
 *      按 `{answers:[{id, selected:[label]}]}` 的形状返回，等价于你在客户端卡片上选。
 *   3. `agent/status` running→idle —— 根 agent 跑完一轮，弹一张「本轮已完成」，点一下回到 DSH。
 *
 * 只在 DSH 不在前台时弹（可关）。窗口由同目录的 Swift 助手画：无边框、置顶、不抢焦点，
 * 点完把结果用一行 JSON 写回 stdout。助手首次使用时用 `swiftc` 编译到用户缓存目录。
 *
 * @module dsh-answer-card
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_SETTINGS,
  POSITIONS,
  readRecent,
  resolveSettings,
  settingsMtime,
  settingsPath,
  writeRecent,
  writeSettings,
} from './settings.mjs'

/** 插件名（Loader 拿它做日志与条目 id）。 */
export const name = 'dsh-answer-card'

/** 只用 Cordis 事件与服务，不注入任何东西。 */
export const inject = []

/** 可被 profile 的 patch 覆盖的默认值。 */
export const DEFAULT_CONFIG = {
  /** 工具要权限时弹。 */
  confirmApprovals: true,
  /** 模型提问 / 计划待审时弹。 */
  answerQuestions: true,
  /** 根 agent 跑完一轮时弹。 */
  notifyOnComplete: true,
  /** 子 agent、后台委派、workflow worker 不弹。 */
  ignoreSubagents: true,
  /** DSH 在前台时不弹（应用内本来就有卡片）。 */
  skipWhenDSHFocused: true,
  /** 认作「DSH 在前台」的 bundle id。 */
  dshBundleIds: ['io.dsh.desktop'],
  /** 兜底：前台 app 名字里含这些词也算 DSH 在前台。 */
  dshProcessNames: ['DeepSeek Harness', 'DSH Desktop'],
  /** 卡片自动关闭的毫秒数；0 = 一直等你点。 */
  autoDismissMs: 0,
  /** 同一会话两次「完成」提醒的最小间隔（毫秒）。 */
  completeCooldownMs: 10000,
  /** 助手二进制路径；留空用缓存目录里的编译产物。 */
  helperPath: '',
  /** 诊断日志文件；留空不写。 */
  traceFile: '',
  /** 设置文件路径；留空用 $DSH_HOME/dsh-answer-card.json。 */
  settingsFile: '',
}

const HERE = dirname(fileURLToPath(import.meta.url))
const SWIFT_SOURCE = join(HERE, '..', 'helper', 'PromptWindow.swift')
const CACHE_DIR = join(homedir(), 'Library', 'Caches', 'dsh-answer-card')
/**
 * 按 Swift 源码哈希命名二进制：改了助手就自动重编，不会误用旧缓存，
 * 升级插件时也不会跑到上一版的行为。
 * @returns {string} 二进制路径。
 */
function defaultHelperPath() {
  try {
    const digest = createHash('sha256').update(readFileSync(SWIFT_SOURCE)).digest('hex').slice(0, 12)
    return join(CACHE_DIR, `PromptWindow-${digest}`)
  } catch {
    return join(CACHE_DIR, 'PromptWindow')
  }
}

const KIND = {
  approval: {
    kicker: 'DSH · 需要你批准',
    submit: '确认',
    dismiss: '稍后处理',
    accent: '#4D6BFE',
  },
  question: {
    kicker: 'DSH · 需要你回答',
    submit: '提交答案',
    dismiss: '稍后处理',
    accent: '#4D6BFE',
  },
  complete: {
    kicker: 'DSH · 本轮已完成',
    submit: '回到 DSH',
    dismiss: '知道了',
    accent: '#2FBF71',
  },
}

/**
 * 认作子 agent 的会话：显式 origin，或委派深度大于 0。
 * @param {any} agent 触发事件的 agent。
 * @param {boolean} ignore 是否启用忽略。
 * @returns {boolean} true 表示不该弹。
 */
export function isSubagent(agent, ignore) {
  if (!ignore) return false
  const header = agent?.session?.header
  if (header?.origin === 'subagent') return true
  return typeof header?.delegationDepth === 'number' && header.delegationDepth > 0
}

/**
 * 取卡片第一行：会话标题 → 工作目录名 → 会话 id 前 8 位。
 * @param {any} ctx Cordis 上下文。
 * @param {any} agent 事件里的 agent。
 * @returns {string} 展示用标题。
 */
export function titleOf(ctx, agent) {
  const session = agent?.session
  try {
    const title = ctx?.get?.('sessionTitle')?.get?.(session)?.title
    if (typeof title === 'string' && title.trim().length > 0) return title.trim()
  } catch {
    // 服务缺席时退回下面的兜底。
  }
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) {
    const segment = cwd.split(/[\\/]/).filter(Boolean).pop()
    if (segment && !/^[A-Za-z]:$/.test(segment)) return segment
  }
  const id = typeof session?.id === 'string' ? session.id : ''
  return id.length >= 8 ? id.slice(0, 8) : 'DeepSeek Harness'
}

/**
 * 把可能很长的计划详情压成卡片能放下的几行。
 * @param {string | undefined} text 原文。
 * @param {number} limit 上限字符数。
 * @returns {string | undefined} 截断后的文本。
 */
export function shorten(text, limit = 420) {
  if (typeof text !== 'string') return undefined
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return undefined
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/**
 * 解析助手的一行 JSON 输出；拿不到就返回错误结果，调用方据此回退。
 * @param {string} text 子进程 stdout。
 * @returns {{ result: string, answers?: Record<string, string[]> }}
 */
export function parseHelperOutput(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim().length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index])
      if (parsed && typeof parsed === 'object' && typeof parsed.result === 'string') return parsed
    } catch {
      // 不是 JSON 行就继续往上找。
    }
  }
  return { result: 'error' }
}

/** @param {typeof DEFAULT_CONFIG} config 生效配置 */
function traceOf(config) {
  return (message) => {
    if (typeof config.traceFile !== 'string' || config.traceFile.length === 0) return
    try {
      appendFileSync(config.traceFile, `${new Date().toISOString()} ${message}\n`)
    } catch {
      // 诊断写不进去不影响提醒。
    }
  }
}

/**
 * 插件入口。
 * @param {any} ctx Cordis 上下文。
 * @param {Partial<typeof DEFAULT_CONFIG>} [rawConfig] patch 覆盖项。
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  const settingsFile = typeof config.settingsFile === 'string' && config.settingsFile.length > 0
    ? config.settingsFile
    : settingsPath()
  /**
   * 「回到 DSH」后要跳转的目标会话；客户端下一次轮询取走并 ack。
   * 只在内存里活一分钟，过期自动丢弃（客户端没开着也不会一直留着）。
   */
  let pendingFocus = null
  const FOCUS_TTL_MS = 60_000

  /** 设置文件变了才重读，事件路径上不做多余 IO。 */
  let cachedSettings = resolveSettings(config, settingsFile)
  let cachedMtime = settingsMtime(settingsFile)
  function settings() {
    const mtime = settingsMtime(settingsFile)
    if (mtime !== cachedMtime) {
      cachedMtime = mtime
      cachedSettings = resolveSettings(config, settingsFile)
    }
    return cachedSettings
  }

  /** 卡片外观参数，来自设置页。 */
  function look(kindAccent) {
    const s = settings()
    return {
      accent: kindAccent === undefined ? s.accent : kindAccent,
      position: s.position,
      width: s.width,
      fontScale: s.fontScale,
      sound: s.sound,
      autoDismissMs: s.autoDismissMs,
    }
  }
  /** 最近出现过的会话：设置页用它列「例外」清单。 */
  let recent = readRecent()
  let recentDirty = false
  let recentSavedAt = 0

  /** 会话的目录（工作区）。 */
  function cwdOf(agent) {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' ? cwd : ''
  }

  /**
   * 记一次「这个会话要弹卡了」：更新最近清单，最多 60 条，节流写盘。
   * 静音判断放在之后，所以被静音的会话也会进清单——设置页才看得见它。
   * @param {any} agent 触发事件的 agent。
   * @returns {void}
   */
  function remember(agent) {
    const id = agent?.session?.id
    if (typeof id !== 'string' || id.length === 0) return
    const entry = {
      id,
      title: titleOf(ctx, agent),
      cwd: cwdOf(agent),
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
      writeRecent(recent)
    }
  }

  /** 进程退出前把没落盘的最近清单写掉。 */
  ctx.effect(() => () => {
    if (recentDirty) writeRecent(recent)
  })

  /**
   * 该不该为这个会话静音。
   * @param {any} agent 触发事件的 agent。
   * @returns {'session'|'workspace'|null} 命中哪一层；都没命中返回 null。
   */
  function muteReason(agent) {
    return muteReasonOf(agent, settings())
  }

  const trace = traceOf(config)
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`${name}: ${message}`)
    } catch {
      // 日志服务缺席时静默。
    }
    trace(`warn: ${message}`)
  }

  const helperPath = typeof config.helperPath === 'string' && config.helperPath.length > 0
    ? config.helperPath
    : defaultHelperPath()

  let compileError = ''
  /**
   * 确保助手可用；首次调用时编译，失败只记一次日志。
   * @returns {boolean} 是否可用。
   */
  function ensureHelper() {
    if (existsSync(helperPath)) return true
    if (compileError.length > 0) return false
    if (!existsSync(SWIFT_SOURCE)) {
      compileError = `helper source missing at ${SWIFT_SOURCE}`
      warn(compileError)
      return false
    }
    if (process.platform !== 'darwin') {
      compileError = 'floating windows are macOS-only'
      warn(compileError)
      return false
    }
    try {
      mkdirSync(CACHE_DIR, { recursive: true })
      const built = spawnSync(
        'swiftc',
        ['-O', '-o', helperPath, SWIFT_SOURCE, '-framework', 'AppKit'],
        { timeout: 120000, encoding: 'utf8' },
      )
      if (built.status !== 0 || !existsSync(helperPath)) {
        compileError = `swiftc failed: ${String(built.stderr ?? '').slice(0, 400)}`
        warn(compileError)
        return false
      }
      trace(`helper compiled -> ${helperPath}`)
      return true
    } catch (error) {
      compileError = `swiftc unavailable: ${String(error)}`
      warn(compileError)
      return false
    }
  }

  /**
   * 问一次前台 app（`--probe`，不画窗口）。
   * @returns {Promise<{ bundleId: string, name: string } | undefined>}
   */
  function probeFrontmost() {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      let child
      try {
        child = spawn(helperPath, ['--probe'], { stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        finish(undefined)
        return
      }
      let output = ''
      child.stdout?.on('data', (chunk) => {
        output += String(chunk)
      })
      child.once('error', () => finish(undefined))
      child.once('exit', () => {
        const parsed = parseHelperOutput(output)
        finish(parsed.result === 'error' ? undefined : parsed)
      })
      setTimeout(() => {
        try {
          child?.kill()
        } catch {
          // 已退出。
        }
        finish(undefined)
      }, 1500)
    })
  }

  /**
   * DSH 是否在前台；探不到就当不在前台（宁可多弹，也不漏提醒）。
   * @returns {Promise<boolean>}
   */
  async function dshFocused() {
    if (settings().skipWhenDSHFocused === false) return false
    const front = await probeFrontmost()
    if (front === undefined) return false
    const bundleId = String(front.bundleId ?? '').toLowerCase()
    const names = config.dshBundleIds.map((id) => String(id).toLowerCase())
    if (bundleId.length > 0 && names.includes(bundleId)) return true
    const appName = String(front.name ?? '')
    return config.dshProcessNames.some((word) => appName.includes(String(word)))
  }

  /**
   * 把 DSH 拉回前台：先 `open -b` 让 Electron 自己 restore→show→focus（顺带取消最小化），
   * 再用 AppKit 的 activateAllWindows 把窗口切到你**当前所在**的 Space。
   * 两条都失败也不抛——提醒已经送达，回不到 DSH 不该影响任何东西。
   */
  function activateDSH() {
    // 设置里填了「回到 DSH 的命令」就只执行它：默认的激活/跳会话/聚焦全部让位，
    // 免得两套动作打架（比如命令自己开的是另一个客户端）。
    const command = String(settings().returnCommand ?? '').trim()
    if (command.length > 0) {
      trace('activate: custom command')
      try {
        spawn(command, { shell: true, stdio: 'ignore', detached: true }).unref()
      } catch (error) {
        trace(`activate: custom command failed ${String(error)}`)
      }
      return
    }
    const bundle = config.dshBundleIds?.[0] ?? 'io.dsh.desktop'
    try {
      spawn('open', ['-b', bundle], { stdio: 'ignore', detached: true }).unref()
    } catch (error) {
      trace(`activate: open failed ${String(error)}`)
    }
    try {
      const args = ['--activate', bundle]
      if (settings().warpPointer !== false) args.push('--warp')
      const child = spawn(helperPath, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      let output = ''
      child.stdout?.on('data', (chunk) => { output += String(chunk) })
      child.once('error', (error) => trace(`activate: helper failed ${String(error)}`))
      child.once('exit', () => trace(`activate: ${output.trim() || 'no output'}`))
    } catch (error) {
      trace(`activate: spawn failed ${String(error)}`)
    }
  }

  /**
   * 弹一张卡片并等结果。助手退出码/JSON 异常都归为 `error`，调用方回退给 DSH 界面。
   * @param {object} payload 交给 Swift 的载荷。
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options] 取消与超时。
   * @returns {Promise<{ result: string, answers?: Record<string, string[]> }>}
   */
  function showCard(payload, options = {}) {
    return new Promise((resolve) => {
      let child
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      try {
        child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (error) {
        trace(`spawn failed: ${String(error)}`)
        finish({ result: 'error' })
        return
      }
      let output = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => {
        output += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.once('error', (error) => {
        trace(`helper error: ${String(error)}`)
        finish({ result: 'error' })
      })
      child.once('exit', (code) => {
        if (stderr.trim().length > 0) trace(`helper stderr: ${stderr.trim().slice(0, 300)}`)
        trace(`helper exit=${String(code)}`)
        finish(parseHelperOutput(output))
      })
      child.stdin?.on('error', () => {
        // 助手提前退出时写 stdin 会 EPIPE，忽略。
      })
      child.stdin?.end(JSON.stringify(payload))

      const signal = options.signal
      if (signal !== undefined) {
        const abort = () => {
          try {
            child?.kill()
          } catch {
            // 已退出。
          }
          finish({ result: 'cancelled' })
        }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      }
      const autoMs = Number(settings().autoDismissMs)
      const timeoutMs = Number(options.timeoutMs ?? (autoMs > 0 ? autoMs + 2000 : 0))
      if (timeoutMs > 0) {
        setTimeout(() => {
          try {
            child?.kill()
          } catch {
            // 已退出。
          }
          finish({ result: 'timeout' })
        }, timeoutMs)
      }
    })
  }

  /** 同一时刻只弹一张卡：串行排队，前一张关了再弹下一张。 */
  let chain = Promise.resolve()
  /**
   * @template T
   * @param {() => Promise<T>} task 排队执行的任务。
   * @returns {Promise<T>}
   */
  function enqueue(task) {
    const run = chain.then(task, task)
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  if (!ensureHelper()) trace('helper unavailable at apply time; will retry on first request')

  // --- 审批：抢在客户端审批桥前面，自己给出 outcome；点了「稍后处理」就把决定交回去。
  ctx.on('approval/request', async (request, next) => {
    if (settings().confirmApprovals === false) return next()
    if (isSubagent(request?.agent, config.ignoreSubagents)) return next()
    remember(request?.agent)
    const muted = muteReason(request?.agent)
    if (muted !== null) {
      trace(`approval: skipped (${muted} muted)`)
      return next()
    }
    if (!ensureHelper()) return next()
    if (await dshFocused()) {
      trace('approval: skipped (DSH focused)')
      return next()
    }
    const tool = typeof request?.toolName === 'string' && request.toolName.length > 0 ? request.toolName : '未知工具'
    const reason = shorten(request?.reason, 200)
    const labels = KIND.approval
    const payload = {
      kind: 'approval',
      kicker: labels.kicker,
      title: titleOf(ctx, request?.agent),
      subtitle: `工具：${tool}`,
      message: reason === undefined ? '这个操作需要你点头才继续。' : `这个操作需要你点头才继续。\n${reason}`,
      groups: [{
        id: 'approval',
        text: '这次调用要不要放行？',
        multi: false,
        choices: [
          { id: 'allow', label: '允许一次', hint: '仅这一次' },
          { id: 'deny', label: '拒绝', hint: '模型会收到拒绝结果' },
        ],
      }],
      submit: labels.submit,
      dismiss: labels.dismiss,
      ...look(),
    }
    trace(`approval: showing tool=${tool}`)
    const outcome = await enqueue(() => showCard(payload, { signal: request?.signal }))
    if (outcome.result === 'choose') {
      const picked = outcome.answers?.approval ?? []
      if (picked.includes('allow')) {
        trace('approval: allowed-once')
        return 'allowed-once'
      }
      if (picked.includes('deny')) {
        trace('approval: rejected')
        return 'rejected'
      }
    }
    trace(`approval: falling back (${outcome.result})`)
    return next()
  }, true)

  // --- 提问 / 计划待审：答完直接返回 answers；取消或稍后处理则交回客户端卡片。
  ctx.on('user-questions/request', async (request, next) => {
    if (settings().answerQuestions === false) return next()
    if (isSubagent(request?.agent, config.ignoreSubagents)) return next()
    remember(request?.agent)
    const muted = muteReason(request?.agent)
    if (muted !== null) {
      trace(`question: skipped (${muted} muted)`)
      return next()
    }
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (questions.length === 0) return next()
    if (!ensureHelper()) return next()
    if (await dshFocused()) {
      trace('question: skipped (DSH focused)')
      return next()
    }
    const labels = KIND.question
    const groups = questions.map((question, index) => {
      const id = typeof question?.id === 'string' && question.id.length > 0 ? question.id : `q${index}`
      const options = Array.isArray(question?.options) ? question.options : []
      const text = typeof question?.question === 'string' ? question.question : '（模型没有给出题干）'
      const header = typeof question?.header === 'string' ? question.header : ''
      return {
        id,
        text: header.length > 0 ? `${header}｜${text}` : text,
        detail: shorten(question?.detail, 600),
        multi: question?.multiSelect === true,
        input: options.length === 0,
        choices: options.map((option, optionIndex) => ({
          id: String(optionIndex),
          label: typeof option?.label === 'string' ? option.label : `选项 ${optionIndex + 1}`,
          hint: typeof option?.description === 'string' ? option.description : undefined,
        })),
      }
    })
    const payload = {
      kind: 'question',
      kicker: labels.kicker,
      title: titleOf(ctx, request?.agent),
      subtitle: questions.length > 1 ? `共 ${questions.length} 个问题` : undefined,
      groups,
      submit: labels.submit,
      dismiss: labels.dismiss,
      ...look(),
    }
    trace(`question: showing count=${questions.length}`)
    const outcome = await enqueue(() => showCard(payload, { signal: request?.signal }))
    if (outcome.result !== 'choose') {
      trace(`question: falling back (${outcome.result})`)
      return next()
    }
    const picked = outcome.answers ?? {}
    const answers = groups.map((group) => {
      if (group.input) {
        const typed = (picked[group.id] ?? [])[0]
        return { id: group.id, selected: [], ...(typeof typed === 'string' && typed.length > 0 ? { custom: typed } : {}) }
      }
      const chosen = picked[group.id] ?? []
      const selected = chosen
        .map((key) => group.choices.find((choice) => choice.id === key)?.label)
        .filter((label) => typeof label === 'string')
      return { id: group.id, selected }
    })
    trace(`question: answered count=${answers.length}`)
    return { answers }
  }, true)

  // --- 任务完成：根 agent 从 running 落到 idle 的那一次。
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
    const muted = muteReason(agent)
    if (muted !== null) {
      trace(`complete: skipped (${muted} muted)`)
      return
    }
    const now = Date.now()
    const last = lastCompleteAt.get(id)
    if (last !== undefined && now - last < Number(settings().completeCooldownMs)) return
    lastCompleteAt.set(id, now)
    const labels = KIND.complete
    const payload = {
      kind: 'complete',
      kicker: labels.kicker,
      title: titleOf(ctx, agent),
      message: '这一轮跑完了，可以回去看看结果。',
      groups: [],
      submit: labels.submit,
      dismiss: labels.dismiss,
      ...look(labels.accent),
    }
    const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : ''
    // 完成提醒不阻塞任何东西，失败也不影响 agent；但没弹的必要就不弹。
    ;(async () => {
      if (!ensureHelper()) return
      if (await dshFocused()) {
        trace('complete: skipped (DSH focused)')
        return
      }
      const outcome = await enqueue(() => showCard(payload, {}))
      if (outcome.result === 'choose') {
        const custom = String(settings().returnCommand ?? '').trim()
        // 默认链路才需要客户端跳会话；自定义命令自己负责回到哪里。
        pendingFocus = custom.length === 0 && sessionId.length > 0 ? { sessionId, at: Date.now() } : null
        trace(`complete: open DSH session=${sessionId || 'none'}${custom.length > 0 ? ' (custom command)' : ''}`)
        activateDSH()
      }
      trace(`complete: closed (${outcome.result})`)
    })().catch(() => undefined)
  })

  // --- 设置页接口 -------------------------------------------------------
  // GET/POST /dsh-answer-card/settings：读写设置；POST /dsh-answer-card/test：弹一张自检卡。
  // 只在有 webServer 的 profile 上挂；没有网页端时插件照常工作，只是没有设置页。

  function sendJson(res, status, body) {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    } catch {
      // 连接已断。
    }
  }

  /** 只放行本机来源；有宿主准入服务时以它为准。 */
  function isLocalRequest(req) {
    try {
      const connection = ctx.get?.('connection')
      const rejection = typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : undefined
      if (rejection === 401 || rejection === 403) return false
    } catch {
      // 没有准入服务时继续走来源检查。
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

  /** 自检卡：按当前设置弹一张，用来确认位置/字号/宽度/主色。 */
  function showTestCard() {
    const s = settings()
    enqueue(() => showCard({
      kind: 'test',
      kicker: 'DSH · 卡片测试',
      title: '这是一张测试卡片',
      subtitle: `位置 ${s.position} · 字号 ${Math.round(Number(s.fontScale ?? 1) * 100)}% · 宽度 ${s.width}pt`,
      message: '看到这张卡，说明设置里的位置、宽度、字号、主色都已生效。',
      groups: [{
        id: 'demo',
        text: '点一个选项，再点提交：',
        multi: false,
        choices: [
          { id: 'ok', label: '一切正常' },
          { id: 'bad', label: '哪里不对' },
        ],
      }],
      submit: '提交',
      dismiss: '关闭',
      ...look(),
    })).then((outcome) => trace(`test: closed (${outcome.result})`))
  }

  /** 「回到 DSH」的测试卡：完成卡的样式，点了就走真实的返回流程（含自定义命令）。 */
  function showReturnTestCard() {
    const s = settings()
    const command = String(s.returnCommand ?? '').trim()
    enqueue(() => showCard({
      kind: 'complete',
      kicker: 'DSH · 回到 DSH 测试',
      title: '测试「回到 DSH」',
      subtitle: command.length > 0 ? '当前：自定义命令' : '当前：默认行为',
      message: command.length > 0
        ? `点下面按钮会执行：${command.slice(0, 120)}`
        : '点下面按钮会激活 DSH 窗口，并把鼠标指针移到输入框。测试卡没有真实会话，所以不跳会话。',
      groups: [],
      submit: '回到 DSH',
      dismiss: '关闭',
      ...look(s.accent),
    })).then((outcome) => {
      trace(`test-return: closed (${outcome.result})`)
      if (outcome.result === 'choose') activateDSH()
    })
  }

  function mountRoute(path, handler) {
    if (typeof ctx.inject !== 'function') return
    ctx.inject(['webServer'], (scoped) =>
      scoped.effect(() => scoped.webServer.register({ kind: 'exact', path, handler })))
  }

  // GET /recent：设置页「例外」清单的数据源——最近弹过卡的会话与目录。
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
      return sendJson(res, 200, {
        ok: true,
        settings: settings(),
        defaults: DEFAULT_SETTINGS,
        positions: POSITIONS,
        file: settingsFile,
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
    if (!ensureHelper()) return sendJson(res, 503, { ok: false, error: 'helper_unavailable' })
    showTestCard()
    return sendJson(res, 200, { ok: true })
  })

  mountRoute('/dsh-answer-card/test-return', async (req, res) => {
    if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
    if (!ensureHelper()) return sendJson(res, 503, { ok: false, error: 'helper_unavailable' })
    showReturnTestCard()
    return sendJson(res, 200, { ok: true })
  })

  // GET /focus：客户端取「该跳去哪个会话」；POST /focus/ack：取走即清。
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

  ctx.effect(() => () => {
    chain = Promise.resolve()
    lastStatus.clear()
    lastCompleteAt.clear()
    trace('apply: disposed')
  })
}

/**
 * 该不该为这个会话静音（纯函数，便于测试）。
 *
 * 会话按 id 精确匹配；工作区按 `session.header.cwd` 精确匹配，
 * 条目以 `/` 结尾时按前缀匹配（这样一条能覆盖整个工作区）。
 *
 * @param {any} agent 触发事件的 agent。
 * @param {Record<string, unknown>} settings 生效设置。
 * @returns {'session'|'workspace'|null} 命中哪一层；都没命中返回 null。
 */
export function muteReasonOf(agent, settings) {
  const id = agent?.session?.id
  const mutedSessions = Array.isArray(settings?.mutedSessions) ? settings.mutedSessions : []
  if (typeof id === 'string' && mutedSessions.includes(id)) return 'session'
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const muted = Array.isArray(settings?.mutedWorkspaces) ? settings.mutedWorkspaces : []
  for (const entry of muted) {
    if (typeof entry !== 'string' || entry.length === 0) continue
    if (entry.endsWith('/') ? cwd.startsWith(entry) : cwd === entry) return 'workspace'
  }
  return null
}
