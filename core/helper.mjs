/**
 * answer-card · Swift 悬浮窗运行器、前台探测、应用激活与跨进程互斥锁。
 *
 * 所有宿主（Antigravity / DSH / Zed）共用同一份编译缓存与交互链路。
 *
 * @module answer-card/core/helper
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bridgeActivateHost,
  bridgeProbeFrontmost,
  bridgeShowCard,
  encodeBridgeHelperPath,
  parseBridgeHelperPath,
  readBridgeToken,
  resolveBridgeTarget,
} from './bridge.mjs'

/**
 * 兼容软链与空格路径的 ESM 主入口判断（Node 会对 import.meta.url 解软链，
 * 而 process.argv[1] 保留软链路径，直接字符串比较在软链插件目录会误判为 false）。
 * @param {string} metaUrl
 * @returns {boolean}
 */
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(process.argv[1]))
  } catch {
    return false
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))
export const SWIFT_SOURCE = join(HERE, 'swift', 'PromptWindow.swift')
export const CACHE_DIR = process.env.ANSWER_CARD_CACHE_DIR || join(homedir(), 'Library', 'Caches', 'answer-card')

/**
 * 创建诊断日志函数。
 * @param {string} [traceFile]
 * @returns {(message: string) => void}
 */
export function createTracer(traceFile = '') {
  return (message) => {
    if (typeof traceFile !== 'string' || traceFile.length === 0) return
    try {
      appendFileSync(traceFile, `${new Date().toISOString()} ${message}\n`)
    } catch {
      // 日志写不进去不影响主流程。
    }
  }
}

/**
 * 按 Swift 源码哈希生成缓存二进制路径：源码变更自动触发重编。
 * @returns {string}
 */
export function defaultHelperPath() {
  try {
    const digest = createHash('sha256').update(readFileSync(SWIFT_SOURCE)).digest('hex').slice(0, 12)
    return join(CACHE_DIR, `PromptWindow-${digest}`)
  } catch {
    return join(CACHE_DIR, 'PromptWindow')
  }
}

/**
 * 解析助手的一行 JSON 输出；失败返回 `{ result: 'error' }`。
 * @param {string} text
 * @returns {{ result: string, answers?: Record<string, string[]>, texts?: Record<string, string>, bundleId?: string, name?: string }}
 */
export function parseHelperOutput(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim().length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index])
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.result === 'string' || typeof parsed.bundleId === 'string' || Array.isArray(parsed.screens)) {
          return parsed
        }
      }
    } catch {
      // 非 JSON 行跳过。
    }
  }
  return { result: 'error' }
}

/**
 * 确保 Swift 助手已编译可用（首次运行约 1–3 秒，之后复用缓存）。
 * @param {{ helperPath?: string, trace?: (msg: string) => void, warn?: (msg: string) => void }} [options]
 * @returns {{ ok: boolean, helperPath: string, error?: string }}
 */
export function ensureHelper(options = {}) {
  const trace = options.trace ?? (() => {})
  const warn = options.warn ?? trace

  // 远端 SSH Linux 或显式指定桥接地址时，自动切换为本机 Mac 桥接模式。
  const bridgeTarget = resolveBridgeTarget(options)
  if (bridgeTarget) {
    const bridgePath = encodeBridgeHelperPath(bridgeTarget.url)
    trace(`helper bridge -> ${bridgeTarget.url}`)
    return { ok: true, mode: 'bridge', helperPath: bridgePath }
  }

  const helperPath = typeof options.helperPath === 'string' && options.helperPath.length > 0
    ? options.helperPath
    : defaultHelperPath()

  if (existsSync(helperPath)) return { ok: true, helperPath }
  if (!existsSync(SWIFT_SOURCE)) {
    const error = `helper source missing at ${SWIFT_SOURCE}`
    warn(error)
    return { ok: false, helperPath, error }
  }
  if (process.platform !== 'darwin') {
    const error = 'floating windows are macOS-only'
    warn(error)
    return { ok: false, helperPath, error }
  }
  try {
    mkdirSync(dirname(helperPath), { recursive: true })
    const moduleCacheDir = join(dirname(helperPath), 'module-cache')
    mkdirSync(moduleCacheDir, { recursive: true })
    const tempOut = `${helperPath}.${process.pid}.tmp`
    const built = spawnSync(
      'swiftc',
      ['-O', '-module-cache-path', moduleCacheDir, '-o', tempOut, SWIFT_SOURCE, '-framework', 'AppKit'],
      { timeout: 120000, encoding: 'utf8' },
    )
    if (built.status !== 0 || !existsSync(tempOut)) {
      try { rmSync(tempOut, { force: true }) } catch { /* ignore */ }
      const error = `swiftc failed: ${String(built.stderr ?? '').slice(0, 400)}`
      warn(error)
      return { ok: false, helperPath, error }
    }
    try {
      // 并发编译时直接原子替换或复用已就绪产物。
      if (!existsSync(helperPath)) {
        renameSync(tempOut, helperPath)
      } else {
        rmSync(tempOut, { force: true })
      }
    } catch {
      if (!existsSync(helperPath)) {
        const error = `failed to finalize compiled helper at ${helperPath}`
        warn(error)
        return { ok: false, helperPath, error }
      }
      try { rmSync(tempOut, { force: true }) } catch { /* ignore */ }
    }
    trace(`helper compiled -> ${helperPath}`)
    return { ok: true, helperPath }
  } catch (err) {
    const error = `swiftc unavailable: ${String(err)}`
    warn(error)
    return { ok: false, helperPath, error }
  }
}

/**
 * 探测当前前台应用（不画窗口）。
 * @param {string} helperPath
 * @returns {Promise<{ bundleId: string, name: string } | undefined>}
 */
export function probeFrontmost(helperPath) {
  const bridgeUrl = parseBridgeHelperPath(helperPath)
  if (bridgeUrl) {
    return bridgeProbeFrontmost(bridgeUrl, readBridgeToken())
  }
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
    child.stdout?.on('data', (chunk) => { output += String(chunk) })
    child.once('error', () => finish(undefined))
    child.once('exit', () => {
      const parsed = parseHelperOutput(output)
      finish(parsed.result === 'error' ? undefined : parsed)
    })
    setTimeout(() => {
      try { child?.kill() } catch { /* ignore */ }
      finish(undefined)
    }, 1500)
  })
}

/**
 * 宿主应用是否正在前台；探不到一律按不在前台处理（失败开放）。
 * @param {{ helperPath: string, bundleIds?: string[], processNames?: string[], skipWhenHostFocused?: boolean }} options
 * @returns {Promise<boolean>}
 */
export async function isHostFocused(options) {
  if (options.skipWhenHostFocused === false) return false
  const front = await probeFrontmost(options.helperPath)
  if (front === undefined) return false
  const bundleId = String(front.bundleId ?? '').toLowerCase()
  const targetBundles = (options.bundleIds ?? []).map((id) => String(id).toLowerCase()).filter(Boolean)
  if (bundleId.length > 0 && targetBundles.includes(bundleId)) return true
  const appName = String(front.name ?? '').toLowerCase()
  const targetNames = (options.processNames ?? []).map((n) => String(n).toLowerCase()).filter(Boolean)
  return targetNames.some((word) => appName.includes(word))
}

/**
 * 激活宿主应用并可选精准切到对应窗口与移动鼠标指针；若设置了 `returnCommand` 则只执行自定义命令（注入会话环境变量）。
 * @param {{
 *   helperPath: string,
 *   bundleIds?: string[],
 *   processNames?: string[],
 *   windowHints?: string[],
 *   returnCommand?: string,
 *   warpPointer?: boolean,
 *   context?: { host?: string, sessionId?: string, cwd?: string, title?: string },
 *   trace?: (msg: string) => void,
 * }} options
 */
export function activateHost(options) {
  const trace = options.trace ?? (() => {})
  const bridgeUrl = parseBridgeHelperPath(options.helperPath)
  if (bridgeUrl) {
    bridgeActivateHost(bridgeUrl, readBridgeToken(), options)
    return
  }
  const command = String(options.returnCommand ?? '').trim()
  if (command.length > 0) {
    trace('activate: custom command')
    try {
      const extraEnv = {
        ...process.env,
        ...(options.context?.host ? { ANSWER_CARD_HOST: options.context.host } : {}),
        ...(options.context?.sessionId ? { ANSWER_CARD_SESSION_ID: options.context.sessionId } : {}),
        ...(options.context?.cwd ? { ANSWER_CARD_CWD: options.context.cwd } : {}),
        ...(options.context?.title ? { ANSWER_CARD_TITLE: options.context.title } : {}),
      }
      spawn(command, { shell: true, env: extraEnv, stdio: 'ignore', detached: true }).unref()
    } catch (error) {
      trace(`activate: custom command failed ${String(error)}`)
    }
    return
  }

  const bundles = (options.bundleIds ?? []).filter(Boolean)
  const names = (options.processNames ?? []).filter(Boolean)
  const hints = (options.windowHints ?? [])
    .map((h) => String(h || '').replace(/\|/g, ' ').trim())
    .filter(Boolean)
  const primaryBundle = bundles[0]
  if (primaryBundle) {
    try {
      spawn('open', ['-b', primaryBundle], { stdio: 'ignore', detached: true }).unref()
    } catch (error) {
      trace(`activate: open failed ${String(error)}`)
    }
  } else if (names[0]) {
    try {
      spawn('open', ['-a', names[0]], { stdio: 'ignore', detached: true }).unref()
    } catch (error) {
      trace(`activate: open -a failed ${String(error)}`)
    }
  }

  try {
    const args = ['--activate', bundles.join(',')]
    if (names.length > 0) args.push('--name', names.join(','))
    if (hints.length > 0) args.push('--window-hint', hints.join('|'))
    if (options.warpPointer !== false) args.push('--warp')
    const child = spawn(options.helperPath, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    child.stdout?.on('data', (chunk) => { output += String(chunk) })
    child.once('error', (error) => trace(`activate: helper failed ${String(error)}`))
    child.once('exit', () => trace(`activate: ${output.trim() || 'no output'}`))
  } catch (error) {
    trace(`activate: spawn failed ${String(error)}`)
  }
}

/**
 * 弹出卡片并等待用户操作。
 * @param {string} helperPath
 * @param {object} payload
 * @param {{ signal?: AbortSignal, timeoutMs?: number, autoDismissMs?: number, trace?: (msg: string) => void }} [options]
 * @returns {Promise<{ result: string, answers?: Record<string, string[]>, texts?: Record<string, string> }>}
 */
export function showCard(helperPath, payload, options = {}) {
  const trace = options.trace ?? (() => {})
  const bridgeUrl = parseBridgeHelperPath(helperPath)
  if (bridgeUrl) {
    return bridgeShowCard(bridgeUrl, readBridgeToken(), payload, options)
  }
  return new Promise((resolve) => {
    let child
    let settled = false
    let timer
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
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
    child.stdout?.on('data', (chunk) => { output += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
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
      // 助手提前退出时忽略 EPIPE。
    })
    child.stdin?.end(JSON.stringify(payload))

    const signal = options.signal
    if (signal !== undefined) {
      const abort = () => {
        try { child?.kill() } catch { /* ignore */ }
        finish({ result: 'cancelled' })
      }
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }

    const autoMs = Number(options.autoDismissMs ?? payload.autoDismissMs ?? 0)
    const timeoutMs = Number(options.timeoutMs ?? (autoMs > 0 ? autoMs + 2000 : 0))
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child?.kill() } catch { /* ignore */ }
        finish({ result: 'timeout' })
      }, timeoutMs)
    }
  })
}

/**
 * 进程内串行队列（供常驻宿主如 DSH / MCP Server 使用）。
 */
export function createCardQueue() {
  let chain = Promise.resolve()
  return {
    enqueue(task) {
      const run = chain.then(task, task)
      chain = run.then(() => undefined, () => undefined)
      return run
    },
    reset() {
      chain = Promise.resolve()
    },
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 跨进程文件互斥锁（供 Antigravity 无状态 hook 进程使用），确保同一时刻屏幕只弹一张卡。
 * @template T
 * @param {() => Promise<T>} task
 * @param {{ lockDir?: string, maxWaitMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withCardLock(task, options = {}) {
  const lockDir = options.lockDir ?? join(CACHE_DIR, 'card.lock')
  const maxWaitMs = Number(options.maxWaitMs ?? 120_000)
  const pidFile = join(lockDir, 'pid')
  const start = Date.now()
  let acquired = false

  mkdirSync(dirname(lockDir), { recursive: true })
  while (!acquired) {
    try {
      mkdirSync(lockDir)
      writeFileSync(pidFile, String(process.pid), 'utf8')
      acquired = true
    } catch {
      // 检查是否死锁（原进程已退出或锁超过 5 分钟）。
      let stale = false
      try {
        const pid = Number(readFileSync(pidFile, 'utf8').trim())
        if (!isPidAlive(pid)) stale = true
      } catch {
        try {
          if (Date.now() - statSync(lockDir).mtimeMs > 5_000) stale = true
        } catch {
          stale = false
        }
      }
      if (stale) {
        try { rmSync(lockDir, { recursive: true, force: true }) } catch { /* ignore */ }
        continue
      }
      if (Date.now() - start >= maxWaitMs) break
      await new Promise((r) => setTimeout(r, 120))
    }
  }

  try {
    return await task()
  } finally {
    if (acquired) {
      try { rmSync(lockDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}
