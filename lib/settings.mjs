/**
 * dsh-answer-card · 设置存储。
 *
 * 三层合并，后者覆盖前者：
 *   1. DEFAULT_SETTINGS
 *   2. profile 的 cordis.patch.yml（即 apply() 收到的 config）
 *   3. 用户在 DSH 设置页改出来的 JSON 文件
 *
 * 文件放在 `$DSH_HOME`（没设就是 ~/.dsh）下的 `dsh-answer-card.json`，
 * 与 settings 页面同源；写入走「临时文件 + rename」，避免半截文件。
 *
 * @module dsh-answer-card/settings
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

/** 设置页可改的默认值。 */
export const DEFAULT_SETTINGS = {
  /** 审批请求（工具要权限）弹卡。 */
  confirmApprovals: true,
  /** 模型提问 / 计划待审弹卡。 */
  answerQuestions: true,
  /** 根 agent 跑完一轮弹卡。 */
  notifyOnComplete: true,
  /** 只有 DSH 不在前台时才弹。 */
  skipWhenDSHFocused: true,
  /** 卡片位置，见 POSITIONS。 */
  position: 'center',
  /** 卡片宽度（pt），夹在 320–720。 */
  width: 452,
  /** 字号缩放，夹在 0.7–1.8。 */
  fontScale: 1,
  /** 主色（按钮/强调文字）。 */
  accent: '#4D6BFE',
  /** 自动关闭毫秒数；0 表示一直等你点。 */
  autoDismissMs: 0,
  /** 弹出时播放系统提示音。 */
  /** 点「回到 DSH」后把鼠标指针挪到输入框附近（跨屏之后省得自己找鼠标）。 */
  warpPointer: true,
  sound: false,
  /** 同一会话两次「完成」提醒的最小间隔（毫秒）。 */
  completeCooldownMs: 10000,
}

/** 设置文件路径（每台机器一个）。 */
export function settingsPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-answer-card.json')
}

/**
 * 把任意输入收敛成合法设置。
 * @param {Record<string, unknown>} raw 待收敛的值。
 * @returns {Record<string, unknown>} 只含合法键与合法值的对象。
 */
export function normalizeSettings(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  const bools = [
    'confirmApprovals',
    'answerQuestions',
    'notifyOnComplete',
    'skipWhenDSHFocused',
    'sound',
    'warpPointer',
  ]
  for (const key of bools) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key]
  }
  if (POSITIONS.includes(raw.position)) out.position = raw.position
  if (Number.isFinite(raw.width)) out.width = Math.round(Math.min(720, Math.max(320, raw.width)))
  if (Number.isFinite(raw.fontScale)) {
    out.fontScale = Math.round(Math.min(1.8, Math.max(0.7, raw.fontScale)) * 100) / 100
  }
  if (typeof raw.accent === 'string' && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(raw.accent.trim())) {
    out.accent = raw.accent.trim()
  }
  if (Number.isFinite(raw.autoDismissMs)) {
    out.autoDismissMs = Math.round(Math.min(60000, Math.max(0, raw.autoDismissMs)))
  }
  if (Number.isFinite(raw.completeCooldownMs)) {
    out.completeCooldownMs = Math.round(Math.min(600000, Math.max(0, raw.completeCooldownMs)))
  }
  return out
}

/**
 * 读设置文件；文件不存在或坏了就当空设置（不抛错）。
 * @param {string} [path] 自定义路径，测试用。
 * @returns {Record<string, unknown>} 已收敛的设置。
 */
export function readSettingsFile(path = settingsPath()) {
  try {
    if (!existsSync(path)) return {}
    return normalizeSettings(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return {}
  }
}

/**
 * 合并三层设置。
 * @param {Record<string, unknown>} [config] patch 传来的配置。
 * @param {string} [path] 自定义路径，测试用。
 * @returns {Record<string, unknown>} 生效设置。
 */
export function resolveSettings(config = {}, path = settingsPath()) {
  const fromConfig = normalizeSettings(config ?? {})
  return { ...DEFAULT_SETTINGS, ...fromConfig, ...readSettingsFile(path) }
}

/**
 * 写入设置文件（合并已有内容）。
 * @param {Record<string, unknown>} patch 本次改动。
 * @param {string} [path] 自定义路径，测试用。
 * @returns {Record<string, unknown>} 写入后的完整设置。
 */
export function writeSettings(patch, path = settingsPath()) {
  const next = { ...readSettingsFile(path), ...normalizeSettings(patch) }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  renameSync(temp, path)
  return { ...DEFAULT_SETTINGS, ...next }
}

/**
 * 设置文件的修改时间，用来判断要不要重读。
 * @param {string} [path] 自定义路径，测试用。
 * @returns {number} mtimeMs；文件不存在返回 0。
 */
export function settingsMtime(path = settingsPath()) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}
