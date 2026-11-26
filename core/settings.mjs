/**
 * answer-card · 共享设置、最近会话记录、静音与冷却存储。
 *
 * 所有宿主（Antigravity / DSH / Zed）共用这套配置规范：
 *   - 默认配置文件：~/.config/answer-card/settings.json
 *   - 支持按宿主覆写：settings.hosts.<hostName>（如 antigravity / dsh / zed）
 *   - DSH 兼容：保留对 skipWhenDSHFocused 旧键及自定义 settingsFile 路径的兼容
 *
 * @module answer-card/core/settings
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 卡片可以出现的位置；与 Swift 助手的 place() 一一对应。 */
export const POSITIONS = [
  'center',
  'top-center',
  'bottom-center',
  'top-right',
  'bottom-right',
  'top-left',
  'bottom-left',
  'cursor',
]

/** Antigravity 审批拦截策略。 */
export const APPROVAL_POLICIES = [
  'external', // 默认：仅拦截越沙箱命令、高风险命令与 MCP 工具
  'commands', // 拦截所有 run_command 与 call_mcp_tool
  'mutating', // 拦截命令、文件写/改与 MCP 工具
  'all',      // 拦截 matcher 命中的全部工具
]

/** 主题模式：auto = 动态跟随 Agent 实时主题 / macOS 系统外观。 */
export const THEME_MODES = ['auto', 'light', 'dark']

/** 各宿主的默认识别元数据与亮/暗双套原生配色（自动随 Agent 主题切换）。 */
export const HOST_PROFILES = {
  antigravity: {
    id: 'antigravity',
    displayName: 'Antigravity',
    shortName: 'Antigravity',
    bundleIds: ['com.google.antigravity'],
    processNames: ['Antigravity', 'Google Antigravity'],
    capabilities: {
      approvalPolicy: true,
      quickFollowUp: true,
      returnCommand: true,
      themeSync: true,
      ignoreTools: true,
    },
    themes: {
      light: {
        accent: '#1A73E8',
        completeAccent: '#1E8E3E',
        background: '#FFFFFF',
        surface: '#F1F3F4',
        border: '#DADCE0',
        textPrimary: '#1F1F1F',
        textSecondary: '#5F6368',
      },
      dark: {
        accent: '#4285F4',
        completeAccent: '#34A853',
        background: '#131314',
        surface: '#1E1F20',
        border: '#333537',
        textPrimary: '#E3E3E3',
        textSecondary: '#9AA0A6',
      },
    },
  },
  dsh: {
    id: 'dsh',
    displayName: 'DeepSeek Harness',
    shortName: 'DSH',
    bundleIds: ['io.dsh.desktop'],
    processNames: ['DeepSeek Harness', 'DSH Desktop'],
    capabilities: {
      approvalPolicy: false,
      quickFollowUp: false,
      returnCommand: true,
      themeSync: false,
      ignoreTools: false,
    },
    themes: {
      light: {
        accent: '#4D6BFE',
        completeAccent: '#16A34A',
        background: '#FFFFFF',
        surface: '#F5F6F8',
        border: '#E2E4E9',
        textPrimary: '#18191C',
        textSecondary: '#6B7280',
      },
      dark: {
        accent: '#4D6BFE',
        completeAccent: '#2FBF71',
        background: '#1C1C1E',
        surface: '#2C2C2E',
        border: '#3A3A3C',
        textPrimary: '#F9FAFB',
        textSecondary: '#ADB2B8',
      },
    },
  },
  zed: {
    id: 'zed',
    displayName: 'Zed',
    shortName: 'Zed',
    bundleIds: ['dev.zed.Zed', 'dev.zed.Zed-Preview', 'dev.zed.Zed-Nightly'],
    processNames: ['Zed'],
    capabilities: {
      approvalPolicy: false,
      quickFollowUp: false,
      returnCommand: true,
      themeSync: false,
      ignoreTools: false,
    },
    themes: {
      light: {
        accent: '#084CCF',
        completeAccent: '#084CCF',
        background: '#FAFAFA',
        surface: '#EFEFF1',
        border: '#D9DADF',
        textPrimary: '#242529',
        textSecondary: '#6C6E78',
      },
      dark: {
        accent: '#589DF6',
        completeAccent: '#589DF6',
        background: '#21252B',
        surface: '#282C33',
        border: '#3B4048',
        textPrimary: '#DCE0E5',
        textSecondary: '#878A98',
      },
    },
  },
}

/** 未在宿主里声明的能力默认值；新宿主按需覆盖。 */
export const DEFAULT_HOST_CAPABILITIES = {
  approvalPolicy: false,
  quickFollowUp: false,
  returnCommand: true,
  themeSync: false,
  ignoreTools: false,
}

/**
 * 已注册宿主顺序；UI 的标签页直接来自这里，不再写死 antigravity/dsh/zed。
 * 新宿主可调用 registerHostProfile() 在运行期注册。
 */
export const HOST_ORDER = Object.keys(HOST_PROFILES)

/** 运行期注册一个新宿主（供未来适配器复用同一份设置 UI）。 */
export function registerHostProfile(id, profile = {}) {
  const key = String(id || '').trim().toLowerCase()
  if (!key) throw new Error('host id is required')
  HOST_PROFILES[key] = {
    id: key,
    displayName: key,
    shortName: key,
    bundleIds: [],
    processNames: [key],
    themes: GENERIC_THEMES,
    ...profile,
    capabilities: { ...DEFAULT_HOST_CAPABILITIES, ...(profile.capabilities || {}) },
  }
  if (!HOST_ORDER.includes(key)) HOST_ORDER.push(key)
  return HOST_PROFILES[key]
}

const GENERIC_THEMES = {
  light: {
    accent: '#2563EB',
    completeAccent: '#16A34A',
    background: '#FFFFFF',
    surface: '#F4F5F7',
    border: '#DFE2E6',
    textPrimary: '#1F2328',
    textSecondary: '#656D76',
  },
  dark: {
    accent: '#589DF6',
    completeAccent: '#2FBF71',
    background: '#18181B',
    surface: '#242429',
    border: '#36363D',
    textPrimary: '#F4F4F5',
    textSecondary: '#A1A1AA',
  },
}

/**
 * 获取宿主元信息；对尚未预注册的新 Harness 自动生成通用配置，方便外部零改动扩展。
 * @param {string | undefined} host
 * @param {Partial<typeof HOST_PROFILES.antigravity>} [overrides]
 */
export function getHostProfile(host, overrides = {}) {
  const id = typeof host === 'string' && host.trim() ? host.trim().toLowerCase() : 'generic'
  const preset = HOST_PROFILES[id]
  if (preset) {
    return {
      ...preset,
      ...overrides,
      capabilities: {
        ...DEFAULT_HOST_CAPABILITIES,
        ...(preset.capabilities || {}),
        ...(overrides.capabilities || {}),
      },
    }
  }
  const label = overrides.displayName || id.charAt(0).toUpperCase() + id.slice(1)
  return {
    id,
    displayName: label,
    shortName: overrides.shortName || label,
    bundleIds: [],
    processNames: [label],
    themes: GENERIC_THEMES,
    ...overrides,
    capabilities: { ...DEFAULT_HOST_CAPABILITIES, ...(overrides.capabilities || {}) },
  }
}

/** 共享默认设置。 */
export const DEFAULT_SETTINGS = {
  /** 审批请求（工具要权限）弹卡。 */
  confirmApprovals: true,
  /** 模型提问 / 计划待审弹卡。 */
  answerQuestions: true,
  /** Agent 跑完一轮弹卡。 */
  notifyOnComplete: true,
  /** 只有宿主应用不在前台时才弹。 */
  skipWhenHostFocused: true,
  /** 兼容 DSH 旧配置键名（始终与 skipWhenHostFocused 同步）。 */
  skipWhenDSHFocused: true,
  /** 卡片位置，见 POSITIONS。 */
  position: 'center',
  /** 卡片宽度（pt），夹在 320–720。 */
  width: 452,
  /** 字号缩放，夹在 0.7–1.8。 */
  fontScale: 1,
  /** 主题模式：auto（跟随 Agent 实时主题）/ light / dark。 */
  themeMode: 'auto',
  /** 主色（留空 = 自动跟随对应 Agent 主题；填 #hex 则覆写）。 */
  accent: '',
  /** 自动关闭毫秒数；0 表示一直等你点。 */
  autoDismissMs: 0,
  /** 弹出时播放系统提示音。 */
  sound: false,
  /** 点「回到宿主」后把鼠标指针挪到输入框附近。 */
  warpPointer: true,
  /** 同一会话两次「完成」提醒的最小间隔（毫秒）。 */
  completeCooldownMs: 10000,
  /** 自定义「回到宿主」命令；留空走默认激活流程。 */
  returnCommand: '',
  /** 不弹卡的工作区目录；精确匹配，末尾带 `/` 按前缀匹配。 */
  mutedWorkspaces: [],
  /** 不弹卡的会话 id。 */
  mutedSessions: [],
  /** Antigravity 审批策略：external | commands | mutating | all。 */
  approvalPolicy: 'external',
  /** 跳过审批弹窗的工具名白名单。 */
  approvalIgnoreTools: [],
  /** 完成卡片是否附带快速追问输入框（Antigravity Stop hook 支持直接续跑）。 */
  allowQuickFollowUp: true,
  /** 诊断日志文件路径；留空不写。 */
  traceFile: '',
}

const LIST_LIMIT = 200
const ITEM_MAX = 512

export function configDir() {
  return process.env.ANSWER_CARD_HOME || join(homedir(), '.config', 'answer-card')
}

export function defaultSettingsPath() {
  return join(configDir(), 'settings.json')
}

export function defaultRecentPath(host = 'shared') {
  return join(configDir(), `recent-${host}.json`)
}

export function defaultStateDir() {
  return join(configDir(), 'state')
}

/**
 * 收敛字符串列表：去空白、去重、限长、限量。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeList(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim().slice(0, ITEM_MAX)
    if (value.length === 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= LIST_LIMIT) break
  }
  return out
}

/**
 * 把任意输入收敛成合法设置；同步兼容 `skipWhenDSHFocused` 与 `skipWhenHostFocused`。
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
export function normalizeSettings(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  const bools = [
    'confirmApprovals',
    'answerQuestions',
    'notifyOnComplete',
    'skipWhenHostFocused',
    'skipWhenDSHFocused',
    'sound',
    'warpPointer',
    'allowQuickFollowUp',
  ]
  for (const key of bools) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key]
  }
  if (typeof out.skipWhenHostFocused === 'boolean' && out.skipWhenDSHFocused === undefined) {
    out.skipWhenDSHFocused = out.skipWhenHostFocused
  } else if (typeof out.skipWhenDSHFocused === 'boolean' && out.skipWhenHostFocused === undefined) {
    out.skipWhenHostFocused = out.skipWhenDSHFocused
  }
  if (POSITIONS.includes(raw.position)) out.position = raw.position
  if (THEME_MODES.includes(raw.themeMode)) out.themeMode = raw.themeMode
  if (APPROVAL_POLICIES.includes(raw.approvalPolicy)) out.approvalPolicy = raw.approvalPolicy
  if (Number.isFinite(raw.width)) out.width = Math.round(Math.min(720, Math.max(320, raw.width)))
  if (Number.isFinite(raw.fontScale)) {
    out.fontScale = Math.round(Math.min(1.8, Math.max(0.7, raw.fontScale)) * 100) / 100
  }
  if (typeof raw.accent === 'string') {
    const trimmed = raw.accent.trim()
    if (trimmed === '' || /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(trimmed)) {
      out.accent = trimmed
    }
  }
  if (Number.isFinite(raw.autoDismissMs)) {
    out.autoDismissMs = Math.round(Math.min(60000, Math.max(0, raw.autoDismissMs)))
  }
  if (Number.isFinite(raw.completeCooldownMs)) {
    out.completeCooldownMs = Math.round(Math.min(600000, Math.max(0, raw.completeCooldownMs)))
  }
  if (typeof raw.returnCommand === 'string') out.returnCommand = raw.returnCommand.trim().slice(0, 2000)
  if (typeof raw.traceFile === 'string') out.traceFile = raw.traceFile.trim().slice(0, 512)
  if (Array.isArray(raw.mutedWorkspaces)) out.mutedWorkspaces = normalizeList(raw.mutedWorkspaces)
  if (Array.isArray(raw.mutedSessions)) out.mutedSessions = normalizeList(raw.mutedSessions)
  if (Array.isArray(raw.approvalIgnoreTools)) out.approvalIgnoreTools = normalizeList(raw.approvalIgnoreTools)
  return out
}

function readRawJson(path) {
  try {
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 读取设置文件原始结构（区分共享顶层与各宿主覆写层），供可视化设置面板展示。
 * @param {string} [path]
 * @returns {{ shared: Record<string, unknown>, hosts: Record<string, Record<string, unknown>> }}
 */
export function readSettingsLayers(path = defaultSettingsPath()) {
  const raw = readRawJson(path)
  const shared = normalizeSettings(raw)
  const hosts = {}
  if (raw.hosts && typeof raw.hosts === 'object') {
    for (const [hostKey, hostVal] of Object.entries(raw.hosts)) {
      if (hostVal && typeof hostVal === 'object') {
        hosts[hostKey] = normalizeSettings(hostVal)
      }
    }
  }
  return { shared, hosts }
}

/**
 * 清除指定宿主的若干覆写键（使其回退到共享层或默认值）。
 * @param {string[]} keys
 * @param {string} [path]
 * @param {string} host
 * @returns {Record<string, unknown>}
 */
export function clearHostSettingsKeys(keys, path = defaultSettingsPath(), host) {
  if (!Array.isArray(keys) || keys.length === 0 || !host) {
    return resolveSettings({}, path, host)
  }
  const raw = readRawJson(path)
  if (raw.hosts && typeof raw.hosts === 'object' && raw.hosts[host] && typeof raw.hosts[host] === 'object') {
    const nextHost = { ...raw.hosts[host] }
    for (const key of keys) delete nextHost[key]
    const hosts = { ...raw.hosts, [host]: nextHost }
    if (Object.keys(nextHost).length === 0) delete hosts[host]
    const nextRaw = { ...raw, hosts }
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(nextRaw, null, 2) + '\n', 'utf8')
    renameSync(temp, path)
  }
  return resolveSettings({}, path, host)
}

/**
 * 读取设置文件（自动合并共享字段 + 可选 `hosts[host]` 覆写层）。
 * @param {string} [path]
 * @param {string} [host]
 * @returns {Record<string, unknown>}
 */
export function readSettingsFile(path = defaultSettingsPath(), host) {
  const raw = readRawJson(path)
  const base = normalizeSettings(raw)
  if (typeof host === 'string' && raw.hosts && typeof raw.hosts === 'object' && raw.hosts[host]) {
    return { ...base, ...normalizeSettings(raw.hosts[host]) }
  }
  return base
}

/**
 * 合并多层设置：默认值 → 宿主静态配置 → 用户配置文件（含 host 覆写）。
 * @param {Record<string, unknown>} [config]
 * @param {string} [path]
 * @param {string} [host]
 * @returns {Record<string, unknown>}
 */
export function resolveSettings(config = {}, path = defaultSettingsPath(), host) {
  const fromConfig = normalizeSettings(config ?? {})
  const fromFile = readSettingsFile(path, host)
  const merged = { ...DEFAULT_SETTINGS, ...fromConfig, ...fromFile }
  // 确保双键一致
  const focused = fromFile.skipWhenHostFocused ?? fromFile.skipWhenDSHFocused
    ?? fromConfig.skipWhenHostFocused ?? fromConfig.skipWhenDSHFocused
    ?? DEFAULT_SETTINGS.skipWhenHostFocused
  merged.skipWhenHostFocused = focused
  merged.skipWhenDSHFocused = focused
  return merged
}

/**
 * 原子写入设置文件；传 `host` 时写入 `hosts[host]` 覆写段，否则写顶层共享段。
 * @param {Record<string, unknown>} patch
 * @param {string} [path]
 * @param {string} [host]
 * @returns {Record<string, unknown>}
 */
export function writeSettings(patch, path = defaultSettingsPath(), host) {
  const raw = readRawJson(path)
  const cleanPatch = normalizeSettings(patch)
  let nextRaw
  if (typeof host === 'string' && host.length > 0) {
    const hosts = raw.hosts && typeof raw.hosts === 'object' ? { ...raw.hosts } : {}
    hosts[host] = { ...normalizeSettings(hosts[host]), ...cleanPatch }
    nextRaw = { ...raw, hosts }
  } else {
    nextRaw = { ...raw, ...cleanPatch }
  }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(nextRaw, null, 2) + '\n', 'utf8')
  renameSync(temp, path)
  return resolveSettings({}, path, host)
}

export function settingsMtime(path = defaultSettingsPath()) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 读最近会话清单。
 * @param {string} [path]
 * @returns {Array<{id:string,title:string,cwd:string,lastAt:number}>}
 */
export function readRecent(path = defaultRecentPath()) {
  try {
    if (!existsSync(path)) return []
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw
      .filter((item) => item !== null && typeof item === 'object' && typeof item.id === 'string')
      .map((item) => ({
        id: item.id,
        title: typeof item.title === 'string' ? item.title : '',
        cwd: typeof item.cwd === 'string' ? item.cwd : '',
        lastAt: Number.isFinite(item.lastAt) ? item.lastAt : 0,
      }))
      .slice(0, 60)
  } catch {
    return []
  }
}

/**
 * 写最近会话清单（原子替换）。
 * @param {Array<{id:string,title:string,cwd:string,lastAt:number}>} list
 * @param {string} [path]
 */
export function writeRecent(list, path = defaultRecentPath()) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(list.slice(0, 60), null, 2) + '\n', 'utf8')
    renameSync(temp, path)
  } catch {
    // 写失败不影响弹卡。
  }
}

/**
 * 记录一次最近触发的会话/工作区并持久化（用于无状态 hook 宿主）。
 * @param {{ id: string, title?: string, cwd?: string }} entry
 * @param {string} [path]
 */
export function recordRecentEntry(entry, path = defaultRecentPath()) {
  if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) return
  const current = readRecent(path)
  const item = {
    id: entry.id,
    title: typeof entry.title === 'string' ? entry.title : '',
    cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
    lastAt: Date.now(),
  }
  const next = [item, ...current.filter((x) => x.id !== item.id)]
    .slice(0, 60)
    .sort((a, b) => b.lastAt - a.lastAt)
  writeRecent(next, path)
}

/**
 * 判断会话或工作区是否被静音（纯函数）。
 * @param {{ sessionId?: string, cwd?: string }} target
 * @param {Record<string, unknown>} settings
 * @returns {'session'|'workspace'|null}
 */
export function muteReasonOf(target, settings) {
  const id = target?.sessionId
  const mutedSessions = Array.isArray(settings?.mutedSessions) ? settings.mutedSessions : []
  if (typeof id === 'string' && id.length > 0 && mutedSessions.includes(id)) return 'session'
  const cwd = target?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const muted = Array.isArray(settings?.mutedWorkspaces) ? settings.mutedWorkspaces : []
  for (const entry of muted) {
    if (typeof entry !== 'string' || entry.length === 0) continue
    if (entry.endsWith('/') ? cwd.startsWith(entry) : cwd === entry) return 'workspace'
  }
  return null
}

/**
 * 跨进程文件冷却检查（用于无状态 hook 宿主如 Antigravity Stop hook）。
 * @param {string} key 会话或宿主唯一键。
 * @param {number} cooldownMs 最小间隔毫秒数。
 * @param {string} [stateDir] 状态目录。
 * @returns {boolean} true 表示仍在冷却中，应跳过。
 */
export function isCoolingDown(key, cooldownMs, stateDir = defaultStateDir()) {
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return false
  const file = join(stateDir, 'cooldowns.json')
  const now = Date.now()
  const data = readRawJson(file)
  const last = Number(data[key] ?? 0)
  if (last > 0 && now - last < cooldownMs) return true
  data[key] = now
  // 清理超过 1 天的陈旧条目，防止文件无限增长。
  for (const [k, ts] of Object.entries(data)) {
    if (!Number.isFinite(ts) || now - Number(ts) > 86_400_000) delete data[k]
  }
  try {
    mkdirSync(stateDir, { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    renameSync(temp, file)
  } catch {
    // 状态写失败不阻断提醒。
  }
  return false
}

/** 宿主专属设置键：迁移进 hosts.<host>，不与共享层混用。 */
export const HOST_SCOPED_KEYS = [
  'confirmApprovals',
  'answerQuestions',
  'notifyOnComplete',
  'skipWhenHostFocused',
  'skipWhenDSHFocused',
  'allowQuickFollowUp',
  'approvalPolicy',
  'approvalIgnoreTools',
  'warpPointer',
  'returnCommand',
  'completeCooldownMs',
  'mutedWorkspaces',
  'mutedSessions',
  'themeMode',
  'accent',
  'sound',
]

/** 全局共享设置键：迁移进顶层，仅补齐目标文件里缺失的项。 */
export const SHARED_SCOPED_KEYS = [
  'position',
  'width',
  'fontScale',
  'autoDismissMs',
  'traceFile',
]

/**
 * 把旧版宿主专属配置文件一次性迁入统一配置。
 * 宿主键写入 hosts.<host>；共享键只补齐目标文件里缺的项，避免覆盖用户现有的全局设置。
 * 已存在 hosts.<host> 时整体跳过。
 * @param {string} host
 * @param {string} legacyPath
 * @param {string} [targetPath]
 * @returns {boolean} 是否发生迁移
 */
export function migrateLegacyHostSettings(host, legacyPath, targetPath = defaultSettingsPath()) {
  const key = String(host || '').trim().toLowerCase()
  if (!key || !legacyPath || !existsSync(legacyPath)) return false
  const target = readRawJson(targetPath)
  if (target.hosts && typeof target.hosts === 'object' && target.hosts[key]) return false
  const legacy = normalizeSettings(readRawJson(legacyPath))
  if (Object.keys(legacy).length === 0) return false

  const hostPatch = {}
  const sharedPatch = {}
  for (const [name, value] of Object.entries(legacy)) {
    if (HOST_SCOPED_KEYS.includes(name)) hostPatch[name] = value
    else if (SHARED_SCOPED_KEYS.includes(name)) sharedPatch[name] = value
  }

  if (Object.keys(hostPatch).length > 0) writeSettings(hostPatch, targetPath, key)
  const now = readRawJson(targetPath)
  const missingShared = {}
  for (const [name, value] of Object.entries(sharedPatch)) {
    if (now[name] === undefined) missingShared[name] = value
  }
  if (Object.keys(missingShared).length > 0) writeSettings(missingShared, targetPath)
  return Object.keys(hostPatch).length > 0 || Object.keys(missingShared).length > 0
}
