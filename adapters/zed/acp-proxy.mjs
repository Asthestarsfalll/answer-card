#!/usr/bin/env node
/**
 * answer-card · Zed ACP (Agent Client Protocol) 透明代理适配器。
 *
 * 在 Zed 配置外部 Agent（如 Claude Code / Codex / Gemini CLI）时包一层本代理：
 *   node adapters/zed/acp-proxy.mjs -- <agent-command> [args...]
 *
 * 能力：
 *   1. 拦截 Agent 发往 Zed 的 `session/request_permission`：
 *      - Zed 不在前台时弹出 macOS 悬浮审批卡片，直接将选中的 optionId 回复给 Agent；
 *      - Zed 在前台 / 静音 / 点「稍后处理」/ 超时则原样透传给 Zed，回退原生权限条。
 *   2. 监听 `session/prompt` 回合结束响应：
 *      - 不阻塞透传；Zed 不在前台时异步弹「本轮已完成」卡片，一键切回 Zed。
 *
 * @module answer-card/adapters/zed/acp-proxy
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  activateHost,
  createCardQueue,
  createTracer,
  ensureHelper,
  isHostFocused,
  isMainModule,
  showCard,
  withCardLock,
} from '../../core/helper.mjs'
import { baseName, buildApprovalPayload, buildCompletePayload, shorten } from '../../core/protocol.mjs'
import { HOST_PROFILES, defaultRecentPath, defaultSettingsPath, isCoolingDown, muteReasonOf, recordRecentEntry, resolveSettings } from '../../core/settings.mjs'

const HOST = 'zed'
const PROFILE = HOST_PROFILES.zed

/**
 * 将 ACP `session/request_permission` 参数构造为悬浮窗载荷（纯函数，便于单测）。
 * @param {Record<string, any>} params
 * @param {Record<string, any>} settings
 */
export function buildAcpPermissionPayload(params, settings) {
  const toolCall = params?.toolCall ?? {}
  const toolTitle = typeof toolCall.title === 'string' && toolCall.title.trim()
    ? toolCall.title.trim()
    : (typeof toolCall.kind === 'string' ? toolCall.kind : '工具调用')
  const rawOptions = Array.isArray(params?.options) ? params.options : []
  const choices = rawOptions.length > 0
    ? rawOptions.map((opt, idx) => ({
        id: String(opt?.optionId ?? opt?.id ?? idx),
        label: String(opt?.name ?? opt?.label ?? `选项 ${idx + 1}`),
        hint: typeof opt?.kind === 'string' ? opt.kind : undefined,
      }))
    : [
        { id: 'allow_once', label: '允许一次', hint: 'allow_once' },
        { id: 'reject_once', label: '拒绝', hint: 'reject_once' },
      ]

  return buildApprovalPayload({
    host: HOST,
    hostLabel: PROFILE.shortName,
    title: baseName(params?.cwd) || PROFILE.displayName,
    toolName: shorten(toolTitle, 120) || '工具调用',
    reason: toolCall?.rawInput ? JSON.stringify(toolCall.rawInput, null, 2) : undefined,
    choices,
    settings,
  })
}

function parseProxyCommand(argv) {
  const sep = argv.indexOf('--')
  const rest = sep >= 0 ? argv.slice(sep + 1) : argv
  return { command: rest[0], args: rest.slice(1) }
}

function runProxy() {
  const { command, args } = parseProxyCommand(process.argv.slice(2))
  if (!command) {
    process.stderr.write('usage: acp-proxy.mjs -- <acp-agent-command> [args...]\n')
    process.exit(2)
  }

  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] })
  const queue = createCardQueue()
  const pendingPromptIds = new Set()
  let lastSessionId = ''
  let lastCwd = process.cwd()

  const writeToZed = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
  const writeToAgent = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')

  // Zed -> Agent
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
    if (!line.trim()) return
    try {
      const msg = JSON.parse(line)
      if (msg?.method === 'session/new' && typeof msg?.params?.cwd === 'string') {
        lastCwd = msg.params.cwd
      }
      if (msg?.method === 'session/prompt' && msg?.id !== undefined) {
        pendingPromptIds.add(msg.id)
        if (typeof msg?.params?.sessionId === 'string') lastSessionId = msg.params.sessionId
      }
      writeToAgent(msg)
    } catch {
      child.stdin.write(line + '\n')
    }
  })

  // Agent -> Zed
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', async (line) => {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      process.stdout.write(line + '\n')
      return
    }

    const settings = resolveSettings({}, defaultSettingsPath(), HOST)
    const trace = createTracer(settings.traceFile)

    // 1. 拦截审批请求
    if (msg?.method === 'session/request_permission' && msg?.id !== undefined) {
      const sessionId = String(msg?.params?.sessionId ?? lastSessionId)
      if (sessionId) recordRecentEntry({ id: sessionId, title: baseName(lastCwd), cwd: lastCwd }, defaultRecentPath(HOST))
      const muted = muteReasonOf({ sessionId, cwd: lastCwd }, settings)
      const ensured = ensureHelper({ trace })
      if (
        settings.confirmApprovals !== false &&
        muted === null &&
        ensured.ok &&
        !(await isHostFocused({
          helperPath: ensured.helperPath,
          bundleIds: PROFILE.bundleIds,
          processNames: PROFILE.processNames,
          skipWhenHostFocused: settings.skipWhenHostFocused,
        }))
      ) {
        const payload = buildAcpPermissionPayload({ ...msg.params, cwd: lastCwd }, settings)
        const outcome = await queue.enqueue(() => withCardLock(() => showCard(ensured.helperPath, payload, { trace })))
        const picked = outcome.result === 'choose' ? outcome.answers?.approval?.[0] : undefined
        if (picked) {
          trace(`zed-acp: resolved permission optionId=${picked}`)
          writeToAgent({
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: { outcome: 'selected', optionId: picked } },
          })
          return
        }
      }
      // 透传给 Zed 原生 UI。
      writeToZed(msg)
      return
    }

    // 2. 透传普通消息，若为 session/prompt 完成响应则异步弹完成卡
    writeToZed(msg)
    if (msg?.id !== undefined && pendingPromptIds.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
      pendingPromptIds.delete(msg.id)
      if (settings.notifyOnComplete === false) return
      const sessionId = lastSessionId || 'zed-default'
      if (muteReasonOf({ sessionId, cwd: lastCwd }, settings) !== null) return
      if (isCoolingDown(`${HOST}:${sessionId}`, Number(settings.completeCooldownMs ?? 10000))) return
      const ensured = ensureHelper({ trace })
      if (!ensured.ok) return
      ;(async () => {
        if (await isHostFocused({
          helperPath: ensured.helperPath,
          bundleIds: PROFILE.bundleIds,
          processNames: PROFILE.processNames,
          skipWhenHostFocused: settings.skipWhenHostFocused,
        })) return
        const payload = buildCompletePayload({
          host: HOST,
          hostLabel: PROFILE.shortName,
          title: baseName(lastCwd) || PROFILE.displayName,
          settings,
        })
        const outcome = await queue.enqueue(() => withCardLock(() => showCard(ensured.helperPath, payload, { trace })))
        if (outcome.result === 'choose') {
          activateHost({
            helperPath: ensured.helperPath,
            bundleIds: PROFILE.bundleIds,
            processNames: PROFILE.processNames,
            windowHints: [baseName(lastCwd), lastCwd].filter(Boolean),
            returnCommand: settings.returnCommand,
            warpPointer: settings.warpPointer,
            context: { host: HOST, sessionId, cwd: lastCwd, title: baseName(lastCwd) },
            trace,
          })
        }
      })().catch(() => undefined)
    }
  })

  child.on('exit', (code) => process.exit(code ?? 0))
  process.stdin.on('end', () => child.stdin.end())
}

if (isMainModule(import.meta.url)) {
  runProxy()
}
