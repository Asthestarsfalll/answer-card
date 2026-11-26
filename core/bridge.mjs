/**
 * answer-card · 远程 SSH 反向转发桥接（零外部依赖）。
 *
 * 解决远程 SSH 会话（如 Linux 服务器上的 Antigravity / Zed）无法直接弹出本机 macOS 悬浮窗的问题：
 *   - 本机 macOS：由 Antigravity MCP App / Zed MCP Server 自动启动，仅监听 `127.0.0.1:19876`
 *   - SSH 隧道：在 `~/.ssh/config` 中加 `RemoteForward 19876 127.0.0.1:19876`
 *   - 远端 Linux：装好本插件并同步 `~/.config/answer-card/bridge-token`（权限 0600），
 *     `core/helper.mjs` 自动检测并把 probe / card / activate 通过隧道转回本机 Mac 弹窗。
 *
 * 安全设计：
 *   - 仅绑定 `127.0.0.1`
 *   - `/probe`、`/card`、`/activate` 强制校验 Bearer / `X-Answer-Card-Token`（`timingSafeEqual`）
 *   - `/card` 外观与主题、`/activate` 的 `returnCommand` 均强制读取本机 Mac 自身配置，
 *     绝不执行远端 HTTP 请求体中携带的命令。
 *
 * @module answer-card/core/bridge
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { defaultSettingsPath, getHostProfile, resolveSettings } from './settings.mjs'
import { resolveHostTheme } from './theme.mjs'

export const DEFAULT_BRIDGE_PORT = 19876
export const BRIDGE_PREFIX = 'bridge://'
const MAX_BODY_BYTES = 512 * 1024

export function defaultBridgeTokenPath(configDir = dirname(defaultSettingsPath())) {
  return join(configDir, 'bridge-token')
}

export function readBridgeToken(tokenFile = defaultBridgeTokenPath()) {
  const fromEnv = String(process.env.ANSWER_CARD_BRIDGE_TOKEN ?? '').trim()
  if (fromEnv.length > 0) return fromEnv
  try {
    if (!existsSync(tokenFile)) return ''
    return readFileSync(tokenFile, 'utf8').trim()
  } catch {
    return ''
  }
}

export function ensureBridgeToken(tokenFile = defaultBridgeTokenPath()) {
  const existing = readBridgeToken(tokenFile)
  if (existing.length > 0) return existing
  const generated = randomBytes(24).toString('hex')
  try {
    mkdirSync(dirname(tokenFile), { recursive: true })
    const temp = `${tokenFile}.${process.pid}.tmp`
    writeFileSync(temp, generated + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, tokenFile)
    try { chmodSync(tokenFile, 0o600) } catch { /* ignore */ }
  } catch {
    // 写盘失败时仍返回本次运行期 token。
  }
  return generated
}

export function encodeBridgeHelperPath(url) {
  return `${BRIDGE_PREFIX}${String(url || '').replace(/\/+$/, '')}`
}

export function parseBridgeHelperPath(helperPath) {
  if (typeof helperPath !== 'string' || !helperPath.startsWith(BRIDGE_PREFIX)) return null
  const url = helperPath.slice(BRIDGE_PREFIX.length).trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(url) ? url : null
}

/**
 * 判断当前进程是否应走远程桥接客户端模式：
 *   - 显式 `ANSWER_CARD_BRIDGE_URL=off`：禁用
 *   - 显式 `ANSWER_CARD_BRIDGE_URL=http://...`（或 `options.bridgeUrl`）：启用
 *   - 非 macOS 宿主（如 SSH 远端 Linux）且存在 `bridge-token`：自动指向 `http://127.0.0.1:<port>`
 * @param {{ bridgeUrl?: string, bridgePort?: number, bridgeToken?: string, tokenFile?: string, platform?: string }} [options]
 * @returns {{ url: string, token: string } | null}
 */
export function resolveBridgeTarget(options = {}) {
  const rawUrl = String(options.bridgeUrl ?? process.env.ANSWER_CARD_BRIDGE_URL ?? '').trim()
  if (rawUrl.toLowerCase() === 'off' || rawUrl === '0') return null
  const token = String(options.bridgeToken ?? '').trim() || readBridgeToken(options.tokenFile)
  if (rawUrl.length > 0) {
    return { url: rawUrl.replace(/\/+$/, ''), token }
  }
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin' && token.length > 0) {
    const port = Number(options.bridgePort ?? process.env.ANSWER_CARD_BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT)
    const safePort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_BRIDGE_PORT
    return { url: `http://127.0.0.1:${safePort}`, token }
  }
  return null
}

function tokenEquals(expected, supplied) {
  if (!expected || !supplied) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(supplied, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function extractToken(req) {
  const headerToken = String(req.headers?.['x-answer-card-token'] ?? '').trim()
  if (headerToken) return headerToken
  const auth = String(req.headers?.authorization ?? '').trim()
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim()
  return ''
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
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

/**
 * 合并本机 Mac 的视觉设置与动态主题到远端传来的卡片载荷中，
 * 确保 SSH 远端弹出的卡片与本机设置（位置、宽度、字号、提示音、实时配色）完全一致。
 */
function mergeLocalCardAppearance(remotePayload, host, settingsFile, stateDir) {
  const hostId = getHostProfile(host || 'antigravity').id
  const localSettings = resolveSettings({}, settingsFile, hostId)
  const theme = resolveHostTheme({ host: hostId, settings: localSettings, stateDir })
  const isComplete = remotePayload?.kind === 'complete'
  return {
    ...remotePayload,
    accent: (isComplete ? theme.completeAccent : theme.accent) || remotePayload?.accent,
    theme: {
      mode: theme.mode,
      background: theme.background,
      surface: theme.surface,
      border: theme.border,
      textPrimary: theme.textPrimary,
      textSecondary: theme.textSecondary,
    },
    position: localSettings.position,
    width: localSettings.width,
    fontScale: localSettings.fontScale,
    sound: localSettings.sound,
    ...(remotePayload?.autoDismissMs === undefined && localSettings.autoDismissMs > 0
      ? { autoDismissMs: localSettings.autoDismissMs }
      : {}),
  }
}

/**
 * 构造桥接 HTTP 请求处理函数（无端口依赖，便于单测）。
 */
export function createBridgeRequestHandler(options = {}) {
  const token = String(options.token || '') || ensureBridgeToken(options.tokenFile)
  const settingsFile = options.settingsFile || defaultSettingsPath()
  const stateDir = options.stateDir

  let helperModulePromise = null
  const getHelperModule = () => {
    if (!helperModulePromise) helperModulePromise = import('./helper.mjs')
    return helperModulePromise
  }

  const handler = async (req, res) => {
    const pathname = String(req.url || '/').split('?')[0]

    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'answer-card-bridge',
        platform: process.platform,
      })
    }

    if (!tokenEquals(token, extractToken(req))) {
      return sendJson(res, 403, { ok: false, error: 'unauthorized' })
    }

    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
    }

    const body = await readJsonBody(req)
    if (body === null || typeof body !== 'object') {
      return sendJson(res, 400, { ok: false, error: 'bad_json' })
    }

    const helperMod = await getHelperModule()
    const ensureFn = options.ensureHelperFn ?? ((opts) => helperMod.ensureHelper({ ...opts, bridgeUrl: 'off' }))
    const probeFn = options.probeFrontmostFn ?? helperMod.probeFrontmost
    const showFn = options.showCardFn ?? helperMod.showCard
    const activateFn = options.activateHostFn ?? helperMod.activateHost
    const lockFn = options.withCardLockFn ?? helperMod.withCardLock

    const ensured = ensureFn({})
    if (!ensured.ok) {
      return sendJson(res, 503, { ok: false, error: ensured.error || 'helper_unavailable' })
    }

    if (pathname === '/probe') {
      const frontmost = await probeFn(ensured.helperPath)
      return sendJson(res, 200, { ok: true, frontmost: frontmost ?? null })
    }

    if (pathname === '/card') {
      if (!body.payload || typeof body.payload !== 'object') {
        return sendJson(res, 400, { ok: false, error: 'payload_required' })
      }
      const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : 'antigravity'
      const merged = mergeLocalCardAppearance(body.payload, host, settingsFile, stateDir)
      const timeoutMs = Number.isFinite(Number(body.timeoutMs)) ? Number(body.timeoutMs) : undefined
      const outcome = await lockFn(() => showFn(ensured.helperPath, merged, { timeoutMs }))
      return sendJson(res, 200, { ok: true, outcome })
    }

    if (pathname === '/activate') {
      const host = typeof body.host === 'string' && body.host.trim()
        ? body.host.trim()
        : (typeof body.context?.host === 'string' ? body.context.host : 'antigravity')
      const profile = getHostProfile(host)
      const localSettings = resolveSettings({}, settingsFile, profile.id)
      const bundleIds = Array.isArray(body.bundleIds) && body.bundleIds.length > 0 ? body.bundleIds : profile.bundleIds
      const processNames = Array.isArray(body.processNames) && body.processNames.length > 0 ? body.processNames : profile.processNames
      const windowHints = Array.isArray(body.windowHints) ? body.windowHints : []
      // 安全约束：returnCommand 与 warpPointer 只信任本机 Mac 自身配置，绝不执行远端传入命令。
      activateFn({
        helperPath: ensured.helperPath,
        bundleIds,
        processNames,
        windowHints,
        returnCommand: localSettings.returnCommand,
        warpPointer: localSettings.warpPointer,
        context: body.context && typeof body.context === 'object' ? body.context : { host: profile.id },
      })
      return sendJson(res, 200, { ok: true })
    }

    return sendJson(res, 404, { ok: false, error: 'not_found' })
  }

  return { handler, token }
}

/**
 * 启动仅监听 `127.0.0.1` 的本机桥接 HTTP 服务。
 */
export function startBridgeServer(options = {}) {
  const { handler, token } = createBridgeRequestHandler(options)
  const port = Number.isInteger(options.port) && options.port >= 0
    ? options.port
    : Number(process.env.ANSWER_CARD_BRIDGE_PORT || DEFAULT_BRIDGE_PORT)

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handler(req, res).catch((err) => {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(err) })
      })
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const boundPort = typeof addr === 'object' && addr ? addr.port : port
      resolve({
        url: `http://127.0.0.1:${boundPort}`,
        port: boundPort,
        token,
        server,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

/**
 * 插件常驻进程启动时自动拉起本机 macOS 桥接（端口已被同机其它实例占用时静默复用，绝不影响主进程）。
 */
export async function startBridgeServerAuto(options = {}) {
  if (process.platform !== 'darwin') return null
  if (process.env.ANSWER_CARD_BRIDGE === '0' || process.env.ANSWER_CARD_BRIDGE === 'off') return null
  try {
    return await startBridgeServer(options)
  } catch (err) {
    if (err && (err.code === 'EADDRINUSE' || err.code === 'EPERM' || err.code === 'EACCES')) {
      return null
    }
    return null
  }
}

// --- 桥接客户端（运行在远端 SSH 主机上）---

async function bridgePost(url, path, token, body, timeoutMs) {
  const controller = new AbortController()
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function bridgeProbeFrontmost(url, token) {
  const data = await bridgePost(url, '/probe', token, {}, 1500)
  if (!data || data.ok !== true || !data.frontmost) return undefined
  return data.frontmost
}

export async function bridgeShowCard(url, token, payload, options = {}) {
  const trace = options.trace ?? (() => {})
  const autoMs = Number(options.autoDismissMs ?? payload?.autoDismissMs ?? 0)
  const cardTimeoutMs = Number(options.timeoutMs ?? (autoMs > 0 ? autoMs + 2000 : 170000))
  const httpTimeoutMs = cardTimeoutMs > 0 ? cardTimeoutMs + 3000 : 175000
  const host = typeof options.host === 'string' && options.host
    ? options.host
    : (typeof payload?.kicker === 'string' ? payload.kicker.split('·')[0].trim().toLowerCase() : 'antigravity')
  const data = await bridgePost(url, '/card', token, {
    host,
    payload,
    timeoutMs: cardTimeoutMs,
  }, httpTimeoutMs)
  if (!data || data.ok !== true || !data.outcome) {
    trace(`bridge: showCard unavailable (${url})`)
    return { result: 'error' }
  }
  return data.outcome
}

export function bridgeActivateHost(url, token, options = {}) {
  const trace = options.trace ?? (() => {})
  bridgePost(url, '/activate', token, {
    host: options.context?.host,
    bundleIds: options.bundleIds ?? [],
    processNames: options.processNames ?? [],
    windowHints: options.windowHints ?? [],
    context: options.context ?? {},
  }, 3000).then((data) => {
    trace(`bridge: activate ${data?.ok ? 'ok' : 'failed'}`)
  }).catch(() => undefined)
}
