#!/usr/bin/env node
/**
 * answer-card · 跨宿主 stdio MCP Server（零外部依赖）。
 *
 * 适用于 Zed (`context_servers`) 以及可选接入 Antigravity / 任意支持 MCP 的客户端：
 *   - `answer_card_ask`     : 弹出悬浮提问卡（单选 / 多选 / 自由文本），直接返回用户答案
 *   - `answer_card_approve` : 弹出悬浮审批卡（允许一次 / 拒绝 / 稍后处理）
 *   - `answer_card_notify`  : 弹出任务完成提醒卡，可一键切回宿主应用
 *
 * 宿主身份通过 `--host <zed|antigravity|dsh>` 或环境变量 `ANSWER_CARD_HOST` 指定（默认 `zed`）。
 *
 * @module answer-card/core/mcp
 */

import { createInterface } from 'node:readline'
import { startBridgeServerAuto } from './bridge.mjs'
import { activateHost, createCardQueue, createTracer, ensureHelper, isHostFocused, isMainModule, showCard, withCardLock } from './helper.mjs'
import { baseName, buildApprovalPayload, buildCompletePayload, buildQuestionPayload, buildReturnTestPayload, buildTestPayload, mapQuestionAnswers } from './protocol.mjs'
import { defaultRecentPath, defaultSettingsPath, getHostProfile, muteReasonOf, readSettingsLayers, recordRecentEntry, resolveSettings, writeSettings } from './settings.mjs'
import { openExternalUrl, startSettingsServer } from './settings-server.mjs'
import { resolveHostTheme } from './theme.mjs'

const SERVER_INFO = { name: 'answer-card', version: '1.0.0' }
const PROTOCOL_VERSION = '2024-11-05'

function hostFromArgs() {
  const idx = process.argv.indexOf('--host')
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1]
  return process.env.ANSWER_CARD_HOST || 'zed'
}

const HOST = hostFromArgs()
const PROFILE = getHostProfile(HOST)
const queue = createCardQueue()
let settingsServerPromise = null

function ensureSettingsServer(settingsFile = defaultSettingsPath()) {
  if (!settingsServerPromise) {
    settingsServerPromise = startSettingsServer({ host: HOST, settingsFile }).catch((err) => {
      settingsServerPromise = null
      throw err
    })
  }
  return settingsServerPromise
}

const TOOLS = [
  {
    name: 'answer_card_ask',
    description: 'Show a topmost macOS floating card asking the user one or more questions (single-select, multi-select, or free text) and return their answer immediately without forcing a window switch.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Card title (e.g. task or workspace name).' },
        cwd: { type: 'string', description: 'Optional workspace path for mute filtering.' },
        sessionId: { type: 'string', description: 'Optional session ID for mute filtering.' },
        force: { type: 'boolean', description: 'Show even when host app is frontmost (default false).' },
        questions: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              header: { type: 'string' },
              question: { type: 'string' },
              detail: { type: 'string' },
              multiSelect: { type: 'boolean' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                },
              },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
    },
  },
  {
    name: 'answer_card_approve',
    description: 'Show a topmost macOS floating approval card for a tool action or plan confirmation, returning allow / deny / dismiss.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Card title.' },
        toolName: { type: 'string', description: 'Action or tool name.' },
        reason: { type: 'string', description: 'Short explanation of what will happen.' },
        cwd: { type: 'string' },
        sessionId: { type: 'string' },
        force: { type: 'boolean' },
      },
      required: ['toolName'],
    },
  },
  {
    name: 'answer_card_notify',
    description: 'Show a topmost macOS floating completion notification card with a button to jump back to the host app.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task or workspace title.' },
        message: { type: 'string', description: 'Short summary of what finished.' },
        cwd: { type: 'string' },
        sessionId: { type: 'string' },
        force: { type: 'boolean' },
      },
      required: ['title'],
    },
  },
  {
    name: 'answer_card_open_settings',
    description: 'Start the local Answer Card visual settings page (same UI as Antigravity and DSH, themed to the current host) and open it in the browser.',
    inputSchema: {
      type: 'object',
      properties: {
        open: { type: 'boolean', description: 'Whether to open the browser automatically (default true).' },
      },
    },
  },
  {
    name: 'answer_card_settings',
    description: 'Read or update Answer Card settings for the current host (e.g. Zed) or shared defaults, or trigger a test card.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'test', 'test_return'],
          description: 'Action to perform (default "get").',
        },
        scope: {
          type: 'string',
          enum: ['host', 'shared'],
          description: 'Scope for "set": "host" updates hosts.<host> overrides, "shared" updates global defaults (default "host").',
        },
        patch: {
          type: 'object',
          description: 'Partial settings object when action="set".',
        },
      },
    },
  },
]

function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function respond(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result })
}

function respondError(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } })
}

function toolResult(data, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    ...(isError ? { isError: true } : {}),
  }
}

const KNOWN_TOOLS = new Set(TOOLS.map((t) => t.name))

export async function handleToolCall(toolName, args = {}, options = {}) {
  if (!KNOWN_TOOLS.has(toolName)) {
    return toolResult({ status: 'error', error: `unknown tool: ${toolName}` }, true)
  }
  const settingsFile = options.settingsFile || defaultSettingsPath()

  if (toolName === 'answer_card_open_settings') {
    const srv = await ensureSettingsServer(settingsFile)
    const opened = args.open === false ? false : openExternalUrl(srv.url)
    return toolResult({ status: opened ? 'opened' : 'ready', host: HOST, url: srv.url, settingsFile })
  }

  if (toolName === 'answer_card_settings') {
    const action = typeof args.action === 'string' ? args.action : 'get'
    if (action === 'get') {
      const effective = resolveSettings({}, settingsFile, HOST)
      const layers = readSettingsLayers(settingsFile, HOST)
      return toolResult({
        status: 'ok',
        host: HOST,
        settingsFile,
        effective,
        shared: layers.shared,
        hostOverrides: layers.hostOverrides,
        theme: resolveHostTheme({ host: HOST, settings: effective }),
      })
    }
    if (action === 'set') {
      const patch = args.patch && typeof args.patch === 'object' ? args.patch : null
      if (!patch) return toolResult({ status: 'error', error: 'patch object is required' }, true)
      const scope = args.scope === 'shared' ? undefined : HOST
      const next = writeSettings(patch, settingsFile, scope)
      return toolResult({ status: 'saved', host: HOST, scope: scope || 'shared', settingsFile, settings: next })
    }
    if (action === 'test' || action === 'test_return') {
      const settings = resolveSettings({}, settingsFile, HOST)
      const trace = createTracer(settings.traceFile)
      const ensured = ensureHelper({ trace })
      if (!ensured.ok) return toolResult({ status: 'unavailable', error: ensured.error }, true)
      const payload = action === 'test'
        ? buildTestPayload({ host: HOST, hostLabel: PROFILE.shortName, settings })
        : buildReturnTestPayload({ host: HOST, hostLabel: PROFILE.shortName, settings })
      const outcome = await queue.enqueue(() => withCardLock(() => showCard(ensured.helperPath, payload, { trace })))
      if (action === 'test_return' && outcome.result === 'choose') {
        activateHost({
          helperPath: ensured.helperPath,
          bundleIds: PROFILE.bundleIds,
          processNames: PROFILE.processNames,
          returnCommand: settings.returnCommand,
          warpPointer: settings.warpPointer,
          trace,
        })
      }
      return toolResult({ status: 'ok', outcome })
    }
    return toolResult({ status: 'error', error: `unknown action: ${action}` }, true)
  }

  const settings = resolveSettings({}, settingsFile, HOST)
  const trace = createTracer(settings.traceFile)
  const cwd = typeof args.cwd === 'string' ? args.cwd : ''
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
  const title = (typeof args.title === 'string' && args.title.trim()) || baseName(cwd) || PROFILE.displayName

  if (sessionId) recordRecentEntry({ id: sessionId, title, cwd }, defaultRecentPath(HOST))

  const muted = muteReasonOf({ sessionId, cwd }, settings)
  if (muted !== null && args.force !== true) {
    return toolResult({ status: 'skipped', reason: `${muted}_muted` })
  }

  const ensured = ensureHelper({ trace })
  if (!ensured.ok) {
    return toolResult({ status: 'unavailable', error: ensured.error }, true)
  }

  if (args.force !== true) {
    const focused = await isHostFocused({
      helperPath: ensured.helperPath,
      bundleIds: PROFILE.bundleIds,
      processNames: PROFILE.processNames,
      skipWhenHostFocused: settings.skipWhenHostFocused,
    })
    if (focused) {
      return toolResult({ status: 'skipped', reason: 'host_focused' })
    }
  }

  if (toolName === 'answer_card_ask') {
    if (settings.answerQuestions === false && args.force !== true) {
      return toolResult({ status: 'skipped', reason: 'disabled' })
    }
    const questions = Array.isArray(args.questions) ? args.questions : []
    if (questions.length === 0) return toolResult({ status: 'error', error: 'questions is required' }, true)
    const { groups, payload } = buildQuestionPayload({
      host: HOST,
      hostLabel: PROFILE.shortName,
      title,
      questions,
      settings,
    })
    const outcome = await queue.enqueue(() => withCardLock(() => showCard(ensured.helperPath, payload, { trace })))
    if (outcome.result !== 'choose') {
      return toolResult({ status: outcome.result })
    }
    return toolResult({ status: 'answered', answers: mapQuestionAnswers(groups, outcome) })
  }

  if (toolName === 'answer_card_approve') {
    if (settings.confirmApprovals === false && args.force !== true) {
      return toolResult({ status: 'skipped', reason: 'disabled' })
    }
    const payload = buildApprovalPayload({
      host: HOST,
      hostLabel: PROFILE.shortName,
      title,
      toolName: String(args.toolName || 'action'),
      reason: typeof args.reason === 'string' ? args.reason : undefined,
      allowText: true,
      placeholder: '可选：填写拒绝原因或替代指令（回车换行，⌘⏎ 提交）…',
      settings,
    })
    const outcome = await queue.enqueue(() => withCardLock(() => showCard(ensured.helperPath, payload, { trace })))
    if (outcome.result === 'choose') {
      const picked = outcome.answers?.approval ?? []
      const note = typeof outcome.texts?.approval === 'string' ? outcome.texts.approval.trim() : ''
      if (picked.includes('allow')) return toolResult({ status: 'allowed', ...(note ? { note } : {}) })
      if (picked.includes('deny') || note) return toolResult({ status: 'denied', ...(note ? { reason: note } : {}) })
    }
    return toolResult({ status: outcome.result })
  }

  if (toolName === 'answer_card_notify') {
    if (settings.notifyOnComplete === false && args.force !== true) {
      return toolResult({ status: 'skipped', reason: 'disabled' })
    }
    const payload = buildCompletePayload({
      host: HOST,
      hostLabel: PROFILE.shortName,
      title,
      message: typeof args.message === 'string' ? args.message : undefined,
      settings,
    })
    const outcome = await queue.enqueue(() => withCardLock(() => showCard(ensured.helperPath, payload, { trace })))
    if (outcome.result === 'choose') {
      activateHost({
        helperPath: ensured.helperPath,
        bundleIds: PROFILE.bundleIds,
        processNames: PROFILE.processNames,
        windowHints: [title, baseName(cwd), cwd].filter(Boolean),
        returnCommand: settings.returnCommand,
        warpPointer: settings.warpPointer,
        context: { host: HOST, sessionId, cwd, title },
        trace,
      })
      return toolResult({ status: 'returned_to_host' })
    }
    return toolResult({ status: outcome.result })
  }

  return toolResult({ status: 'error', error: `unknown tool: ${toolName}` }, true)
}

export async function dispatchRpc(message) {
  if (!message || typeof message !== 'object') return
  const { id, method, params } = message
  const hasId = id !== undefined && id !== null

  if (method === 'initialize') {
    if (hasId) {
      respond(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
    }
    return
  }
  if (method === 'notifications/initialized') return
  if (method === 'ping') {
    if (hasId) respond(id, {})
    return
  }
  if (method === 'tools/list') {
    if (hasId) respond(id, { tools: TOOLS })
    return
  }
  if (method === 'tools/call') {
    try {
      const result = await handleToolCall(params?.name, params?.arguments)
      if (hasId) respond(id, result)
    } catch (error) {
      if (hasId) respond(id, toolResult({ status: 'error', error: String(error) }, true))
    }
    return
  }
  if (hasId) respondError(id, -32601, `Method not found: ${method}`)
}

if (isMainModule(import.meta.url)) {
  const bridgePromise = startBridgeServerAuto()
  const closeBridge = () => {
    bridgePromise.then((srv) => srv?.close?.()).catch(() => undefined)
  }
  process.once('SIGINT', closeBridge)
  process.once('SIGTERM', closeBridge)

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.once('close', closeBridge)
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const msg = JSON.parse(trimmed)
      dispatchRpc(msg).catch((err) => {
        if (msg?.id !== undefined) respondError(msg.id, -32603, String(err))
      })
    } catch {
      // 忽略损坏行，不让 stdio server 崩溃。
    }
  })
}
