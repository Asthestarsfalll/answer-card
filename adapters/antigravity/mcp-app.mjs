#!/usr/bin/env node
/**
 * answer-card · Antigravity MCP App 设置面板服务器（零外部依赖）。
 *
 * 暴露：
 *   - UI 资源：`ui://answer-card/settings.html` (`text/html;profile=mcp-app`)
 *   - 入口工具：`open_answer_card_settings`（挂载 aux_pane 侧边栏 `+` 菜单与左侧 global 边栏）
 *   - App 专用工具（visibility: ["app"]，对模型隐藏）：
 *       - `app_get_state`
 *       - `app_save_settings`
 *       - `app_test_card`
 *       - `app_test_return`
 *       - `app_probe_frontmost`
 *
 * @module answer-card/adapters/antigravity/mcp-app
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { activateHost, createCardQueue, ensureHelper, isMainModule, probeFrontmost, showCard, withCardLock } from '../../core/helper.mjs'
import { buildReturnTestPayload, buildTestPayload } from '../../core/protocol.mjs'
import {
  APPROVAL_POLICIES,
  DEFAULT_SETTINGS,
  HOST_ORDER,
  HOST_PROFILES,
  getHostProfile,
  POSITIONS,
  THEME_MODES,
  clearHostSettingsKeys,
  defaultRecentPath,
  defaultSettingsPath,
  readRecent,
  readSettingsLayers,
  resolveSettings,
  writeSettings,
} from '../../core/settings.mjs'
import { readThemeSyncStatus, resolveHostTheme, writeHostThemeSnapshot, writeThemeSyncStatus } from '../../core/theme.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_HTML_PATH = join(HERE, 'ui', 'settings.html')
export const APP_URI = 'ui://answer-card/settings.html'
const MIME_TYPE = 'text/html;profile=mcp-app'
const SERVER_INFO = { name: 'answer-card-settings', version: '1.0.0' }
const PROTOCOL_VERSION = '2024-11-05'

function parseCliDataDir(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--data-dir=')) return token.slice('--data-dir='.length)
    if (token === '--data-dir' && i + 1 < argv.length) return argv[i + 1]
  }
  return process.env.PLUGIN_DATA || ''
}

const DATA_DIR = parseCliDataDir()
const queue = createCardQueue()

export const TOOLS = [
  {
    name: 'open_answer_card_settings',
    title: 'Answer Card Settings',
    description: 'Open the interactive Answer Card settings panel to configure floating card appearance, per-agent triggers, approval policy, custom return command, muted workspaces/sessions, and run test cards.',
    inputSchema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          enum: HOST_ORDER,
          description: 'Optional host profile tab to focus initially (defaults to antigravity).',
        },
      },
    },
    _meta: {
      ui: { resourceUri: APP_URI },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'Answer Card' },
          { type: 'global', title: 'Answer Card' },
        ],
      },
    },
  },
  {
    name: 'app_get_state',
    title: 'Get Answer Card Settings State',
    description: 'Read current Answer Card settings, host overrides, and recent sessions/workspaces.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', enum: HOST_ORDER },
      },
    },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'app_save_settings',
    title: 'Save Answer Card Settings',
    description: 'Persist shared or per-host Answer Card settings.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['host', 'shared'] },
        host: { type: 'string', enum: HOST_ORDER },
        patch: { type: 'object' },
        resetKeys: { type: 'array', items: { type: 'string' } },
      },
    },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'app_test_card',
    title: 'Send Answer Card Self-Test',
    description: 'Pop a floating test card using current settings.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', enum: HOST_ORDER },
      },
    },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'app_test_return',
    title: 'Test Return-to-Host Card',
    description: 'Pop a completion test card to verify default activation or custom returnCommand.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', enum: HOST_ORDER },
      },
    },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'app_probe_frontmost',
    title: 'Probe Frontmost Application',
    description: 'Detect current frontmost macOS app bundleId and name.',
    inputSchema: { type: 'object', properties: {} },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'app_sync_host_theme',
    title: 'Sync Live Host Theme',
    description: 'Persist live host theme snapshot (light/dark + CSS variables) so floating cards adapt dynamically to the active Antigravity theme.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', enum: HOST_ORDER },
        theme: { type: 'string' },
        variables: { type: 'object' },
      },
    },
    _meta: { ui: { visibility: ['app'] } },
  },
]

function normalizeHost(raw) {
  return HOST_ORDER.includes(raw) ? raw : 'antigravity'
}

function recentFileFor(host, dataDir = DATA_DIR) {
  if (host === 'antigravity' && dataDir) return join(dataDir, 'recent.json')
  return defaultRecentPath(host)
}

export function buildState(hostInput = 'antigravity', options = {}) {
  const host = normalizeHost(hostInput)
  const settingsFile = options.settingsFile || process.env.ANSWER_CARD_SETTINGS_FILE || defaultSettingsPath()
  const recentFile = options.recentFile || recentFileFor(host, options.dataDir ?? DATA_DIR)
  const effective = resolveSettings(options.hostConfig || {}, settingsFile, host)
  const layers = readSettingsLayers(settingsFile)
  const sessions = readRecent(recentFile)
  const workspaces = []
  const seen = new Set()
  for (const item of sessions) {
    if (!item.cwd || seen.has(item.cwd)) continue
    seen.add(item.cwd)
    workspaces.push({ path: item.cwd, lastAt: item.lastAt })
  }
  const resolvedTheme = resolveHostTheme({ host, settings: effective, stateDir: options.stateDir })
  const themeSync = readThemeSyncStatus(host, options.stateDir)
  return {
    ok: true,
    host,
    hosts: HOST_ORDER.map((id) => {
      const meta = getHostProfile(id)
      return {
        id,
        displayName: meta.displayName,
        shortName: meta.shortName,
        capabilities: meta.capabilities,
      }
    }),
    settingsFile,
    effective,
    shared: { ...DEFAULT_SETTINGS, ...layers.shared },
    hostOverrides: layers.hosts[host] || {},
    resolvedTheme,
    themeSync,
    defaults: DEFAULT_SETTINGS,
    positions: POSITIONS,
    themeModes: THEME_MODES,
    approvalPolicies: APPROVAL_POLICIES,
    recent: { sessions, workspaces },
  }
}

export function readAppHtml() {
  const custom = process.env.ANSWER_CARD_APP_HTML
  const path = custom && existsSync(custom) ? custom : DEFAULT_HTML_PATH
  return readFileSync(path, 'utf8')
}

export async function handleToolCall(name, args = {}, options = {}) {
  const host = normalizeHost(args?.host)
  const profile = HOST_PROFILES[host] || HOST_PROFILES.antigravity
  const settingsFile = options.settingsFile || process.env.ANSWER_CARD_SETTINGS_FILE || defaultSettingsPath()

  if (name === 'open_answer_card_settings') {
    const state = buildState(host, options)
    return {
      content: [{
        type: 'text',
        text: `Opened Answer Card settings (${host}). Position: ${state.effective.position}, width: ${state.effective.width}pt, approvalPolicy: ${state.effective.approvalPolicy}.`,
      }],
      structuredContent: state,
    }
  }

  if (name === 'app_get_state') {
    const state = buildState(host, options)
    return {
      content: [{ type: 'text', text: JSON.stringify(state) }],
      structuredContent: state,
    }
  }

  if (name === 'app_save_settings') {
    const scope = args?.scope === 'shared' ? 'shared' : 'host'
    if (Array.isArray(args?.resetKeys) && args.resetKeys.length > 0 && scope === 'host') {
      clearHostSettingsKeys(args.resetKeys, settingsFile, host)
    }
    if (args?.patch && typeof args.patch === 'object' && Object.keys(args.patch).length > 0) {
      writeSettings(args.patch, settingsFile, scope === 'host' ? host : undefined)
    }
    const state = buildState(host, options)
    return {
      content: [{ type: 'text', text: JSON.stringify(state) }],
      structuredContent: state,
    }
  }

  if (name === 'app_test_card' || name === 'app_test_return') {
    const ensured = ensureHelper()
    if (!ensured.ok) {
      const payload = { ok: false, error: ensured.error }
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: true }
    }
    const settings = resolveSettings(options.hostConfig || {}, settingsFile, host)
    const cardPayload = name === 'app_test_card'
      ? buildTestPayload({ host, hostLabel: profile.shortName, settings })
      : buildReturnTestPayload({ host, hostLabel: profile.shortName, settings })

    // 异步弹卡立即返回，避免阻塞 UI 按钮或触发 4 并发上限。
    queue.enqueue(() => withCardLock(() => showCard(ensured.helperPath, cardPayload)))
      .then((outcome) => {
        if (name === 'app_test_return' && outcome.result === 'choose') {
          activateHost({
            helperPath: ensured.helperPath,
            bundleIds: profile.bundleIds,
            processNames: profile.processNames,
            returnCommand: settings.returnCommand,
            warpPointer: settings.warpPointer,
          })
        }
      })
      .catch(() => undefined)

    const result = { ok: true, sent: name, host }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
  }

  if (name === 'app_probe_frontmost') {
    const ensured = ensureHelper()
    if (!ensured.ok) {
      return { content: [{ type: 'text', text: ensured.error }], structuredContent: { ok: false, error: ensured.error }, isError: true }
    }
    const front = await probeFrontmost(ensured.helperPath)
    const result = { ok: true, frontmost: front ?? null }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
  }

  if (name === 'app_sync_host_theme') {
    const saved = writeHostThemeSnapshot(host, {
      theme: args?.theme,
      variables: args?.variables,
    }, options.stateDir)
    writeThemeSyncStatus(host, saved ? { failed: false } : { failed: true, error: 'empty_theme_payload' }, options.stateDir)
    const state = buildState(host, options)
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...state, synced: Boolean(saved) }) }],
      structuredContent: { ...state, synced: Boolean(saved) },
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    structuredContent: { ok: false, error: `Unknown tool: ${name}` },
    isError: true,
  }
}

export async function dispatchRpc(message, options = {}) {
  if (!message || typeof message !== 'object') return null
  const { id, method, params } = message
  const hasId = id !== undefined && id !== null

  if (method === 'initialize') {
    return hasId
      ? {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
            capabilities: { tools: {}, resources: {} },
            serverInfo: SERVER_INFO,
          },
        }
      : null
  }
  if (method === 'notifications/initialized') return null
  if (method === 'ping') return hasId ? { jsonrpc: '2.0', id, result: {} } : null
  if (method === 'tools/list') return hasId ? { jsonrpc: '2.0', id, result: { tools: TOOLS } } : null
  if (method === 'resources/list') {
    return hasId
      ? {
          jsonrpc: '2.0',
          id,
          result: {
            resources: [{
              uri: APP_URI,
              name: 'Answer Card Settings',
              description: 'Interactive macOS Answer Card settings UI',
              mimeType: MIME_TYPE,
              _meta: { ui: { prefersBorder: false } },
            }],
          },
        }
      : null
  }
  if (method === 'resources/read') {
    if (!hasId) return null
    if (params?.uri !== APP_URI) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown resource: ${params?.uri}` } }
    }
    try {
      const html = readAppHtml()
      return {
        jsonrpc: '2.0',
        id,
        result: {
          contents: [{
            uri: APP_URI,
            mimeType: MIME_TYPE,
            text: html,
            _meta: { ui: { prefersBorder: false } },
          }],
        },
      }
    } catch (error) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: `Failed to read UI HTML: ${String(error)}` } }
    }
  }
  if (method === 'tools/call') {
    if (!hasId) return null
    try {
      const result = await handleToolCall(params?.name, params?.arguments, options)
      return { jsonrpc: '2.0', id, result }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: String(error) }],
          structuredContent: { ok: false, error: String(error) },
          isError: true,
        },
      }
    }
  }
  return hasId
    ? { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
    : null
}

if (isMainModule(import.meta.url)) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      return
    }
    dispatchRpc(msg)
      .then((res) => {
        if (res) process.stdout.write(JSON.stringify(res) + '\n')
      })
      .catch((err) => {
        if (msg?.id !== undefined) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: String(err) },
          }) + '\n')
        }
      })
  })
}
