/**
 * answer-card · 跨宿主动态主题解析器。
 *
 * 优先级（自高到低）：
 *   1. 用户显式覆写（`settings.themeMode` = light/dark、`settings.accent` 非空）
 *   2. 宿主实时上报的主题快照（`state/theme-<host>.json`）：
 *      - Antigravity：MCP App 通过 `hostContext` (`theme` + `styles.variables`) 实时同步
 *      - DSH：Web 端 `client.js` 读取实时计算样式同步
 *   3. 宿主本地配置直读（Zed：读取 `~/.config/zed/settings.json` 与 `~/.config/zed/themes/*.json`）
 *   4. macOS 实时系统外观（`NSApp.effectiveAppearance` / `defaults read -g AppleInterfaceStyle`）
 *      + 对应 Agent 的浅色 / 深色原生调色板
 *
 * @module answer-card/core/theme
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultStateDir, getHostProfile } from './settings.mjs'

/**
 * 解析 CSS 颜色为 `{ r, g, b, a }`（支持 `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()`）。
 * @param {unknown} raw
 * @returns {{ r: number, g: number, b: number, a: number } | undefined}
 */
export function parseCssColor(raw) {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (!text || text.toLowerCase() === 'transparent') return undefined

  const hex3or4 = /^#([0-9a-f]{3})([0-9a-f])?$/i.exec(text)
  if (hex3or4) {
    const [r, g, b] = hex3or4[1].split('').map((c) => parseInt(c + c, 16))
    const a = hex3or4[2] ? parseInt(hex3or4[2] + hex3or4[2], 16) / 255 : 1
    return { r, g, b, a }
  }
  const hex6or8 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(text)
  if (hex6or8) {
    const r = parseInt(hex6or8[1], 16)
    const g = parseInt(hex6or8[2], 16)
    const b = parseInt(hex6or8[3], 16)
    const a = hex6or8[4] ? parseInt(hex6or8[4], 16) / 255 : 1
    return { r, g, b, a }
  }
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d+(?:\.\d+)?)(%)?)?\s*\)$/i.exec(text)
  if (rgb) {
    const clamp = (n) => Math.max(0, Math.min(255, Math.round(Number(n))))
    let a = 1
    if (rgb[4] !== undefined) {
      const rawAlpha = Number(rgb[4])
      a = rgb[5] === '%' ? rawAlpha / 100 : rawAlpha
      a = Math.max(0, Math.min(1, a))
    }
    return { r: clamp(rgb[1]), g: clamp(rgb[2]), b: clamp(rgb[3]), a }
  }
  const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%)?)?\s*\)$/i.exec(text)
  if (srgb) {
    const to255 = (n) => Math.max(0, Math.min(255, Math.round(Number(n) * 255)))
    let a = 1
    if (srgb[4] !== undefined) {
      const rawAlpha = Number(srgb[4])
      a = srgb[5] === '%' ? rawAlpha / 100 : rawAlpha
      a = Math.max(0, Math.min(1, a))
    }
    return { r: to255(srgb[1]), g: to255(srgb[2]), b: to255(srgb[3]), a }
  }
  return undefined
}

function rgbToHex({ r, g, b }) {
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase()
}

function mixHex(baseHex, targetHex, ratio) {
  const a = parseCssColor(baseHex)
  const b = parseCssColor(targetHex)
  if (!a || !b) return baseHex
  return rgbToHex({
    r: a.r * (1 - ratio) + b.r * ratio,
    g: a.g * (1 - ratio) + b.g * ratio,
    b: a.b * (1 - ratio) + b.b * ratio,
  })
}

/**
 * 将 CSS 颜色规整为 `#RRGGBB`；若颜色带透明度（`0 < a < 1`）且提供了 `backdropHex`，
 * 按 Porter-Duff source-over 与背景色混合，避免 `rgba(0,0,0,0.06)` 被截断成纯黑。
 * @param {unknown} raw
 * @param {string} [backdropHex]
 * @returns {string | undefined}
 */
export function normalizeCssColor(raw, backdropHex) {
  const parsed = parseCssColor(raw)
  if (!parsed || parsed.a <= 0.004) return undefined
  if (parsed.a >= 0.996) return rgbToHex(parsed)
  const bg = parseCssColor(backdropHex)
  if (!bg) return undefined
  return rgbToHex({
    r: parsed.r * parsed.a + bg.r * (1 - parsed.a),
    g: parsed.g * parsed.a + bg.g * (1 - parsed.a),
    b: parsed.b * parsed.a + bg.b * (1 - parsed.a),
  })
}

/**
 * 计算颜色相对亮度（0–1），用于判断浅色/深色主题。
 * @param {string | undefined} hex
 * @returns {number | undefined}
 */
export function relativeLuminance(hex) {
  const clean = normalizeCssColor(hex)
  if (!clean) return undefined
  const r = parseInt(clean.slice(1, 3), 16) / 255
  const g = parseInt(clean.slice(3, 5), 16) / 255
  const b = parseInt(clean.slice(5, 7), 16) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * 探测 macOS 当前系统外观（`light` 或 `dark`）。
 * @returns {'light' | 'dark'}
 */
export function detectSystemAppearance() {
  if (process.platform !== 'darwin') return 'dark'
  try {
    const res = spawnSync('defaults', ['read', '-g', 'AppleInterfaceStyle'], {
      encoding: 'utf8',
      timeout: 800,
    })
    if (res.status === 0 && /dark/i.test(String(res.stdout || ''))) return 'dark'
    return 'light'
  } catch {
    return 'dark'
  }
}

/**
 * 去除 JSONC 中的注释和尾逗号，用于解析 Zed `settings.json`。
 * @param {string} text
 * @returns {string}
 */
export function stripJsonc(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += ch
  }
  return out.replace(/,\s*([}\]])/g, '$1')
}

export function themeSnapshotPath(host, stateDir = defaultStateDir()) {
  return join(stateDir, `theme-${host || 'shared'}.json`)
}

export function themeSyncStatusPath(host, stateDir = defaultStateDir()) {
  return join(stateDir, `theme-sync-${host || 'shared'}.json`)
}

export function readThemeSyncStatus(host, stateDir = defaultStateDir()) {
  try {
    const file = themeSyncStatusPath(host, stateDir)
    if (!existsSync(file)) return { attempted: false, failed: false }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return {
      attempted: parsed?.attempted === true,
      failed: parsed?.failed === true,
      error: typeof parsed?.error === 'string' ? parsed.error : '',
      updatedAt: Number.isFinite(parsed?.updatedAt) ? parsed.updatedAt : 0,
    }
  } catch {
    return { attempted: false, failed: false }
  }
}

export function writeThemeSyncStatus(host, status, stateDir = defaultStateDir()) {
  const file = themeSyncStatusPath(host, stateDir)
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({
      attempted: true,
      failed: status?.failed === true,
      ...(status?.error ? { error: String(status.error).slice(0, 300) } : {}),
      updatedAt: Date.now(),
    }, null, 2) + '\n', 'utf8')
    renameSync(temp, file)
  } catch {
    // 忽略状态写失败。
  }
}

/**
 * 读取 Antigravity 全局配置中的 themeMode（作为无快照时的浅/深模式补充信号）。
 * @param {string} [configPath]
 * @returns {'light' | 'dark' | undefined}
 */
export function readAntigravityConfigMode(configPath = join(homedir(), '.gemini', 'config', 'config.json')) {
  try {
    if (!existsSync(configPath)) return undefined
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    const raw = String(parsed?.userSettings?.themeMode ?? parsed?.themeMode ?? '').toUpperCase()
    if (raw.includes('LIGHT')) return 'light'
    if (raw.includes('DARK')) return 'dark'
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 规范化实时上报的宿主主题快照。
 * @param {Record<string, any>} raw
 */
export function normalizeThemeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null
  const vars = raw.variables && typeof raw.variables === 'object' ? raw.variables : {}
  let mode = raw.mode === 'light' || raw.mode === 'dark' ? raw.mode : undefined
  if (!mode && (raw.theme === 'light' || raw.theme === 'dark')) mode = raw.theme
  // 部分宿主只上报文字色（旧版 DSH 客户端）：深色文字 → 浅色主题，反之亦然。
  if (!mode) {
    const textHint = normalizeCssColor(
      raw.textPrimary ?? vars.textPrimary ?? vars['--dsw-alias-label-primary'] ?? vars['--color-text-primary'],
    )
    if (textHint) {
      const lum = relativeLuminance(textHint)
      if (lum !== undefined) mode = lum > 0.5 ? 'dark' : 'light'
    }
  }
  const defaultBackdrop = mode === 'light' ? '#FFFFFF' : '#131314'

  const pickWith = (backdrop, ...keys) => {
    for (const k of keys) {
      const c = normalizeCssColor(raw[k] ?? vars[k], backdrop)
      if (c) return c
    }
    return undefined
  }
  const background = pickWith(
    defaultBackdrop,
    'background',
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-l1',
    '--dsw-alias-bg-layer-1',
    '--color-background-primary',
    '--dsw-alias-bg-primary',
  )
  const bg = background || defaultBackdrop
  if (!mode && background) {
    const lum = relativeLuminance(background)
    if (lum !== undefined) mode = lum > 0.5 ? 'light' : 'dark'
  }
  const surface = pickWith(
    bg,
    'surface',
    '--dsw-alias-bg-l1',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-l2',
    '--dsw-alias-bg-layer-2',
    '--color-background-secondary',
    '--color-background-tertiary',
    '--dsw-alias-bg-secondary',
  )
  const border = pickWith(bg, 'border', '--color-border-primary', '--color-border-secondary', '--dsw-alias-border-primary')
  const textPrimary = pickWith(bg, 'textPrimary', '--color-text-primary', '--dsw-alias-label-primary')
  const textSecondary = pickWith(
    bg,
    'textSecondary',
    '--color-text-secondary',
    '--color-text-tertiary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-label-secondary',
  )
  const accent = pickWith(
    bg,
    'accent',
    '--color-ring-primary',
    '--color-text-info',
    '--color-background-info',
    '--dsw-alias-brand-primary',
  )
  const completeAccent = pickWith(
    bg,
    'completeAccent',
    '--color-text-success',
    '--color-background-success',
    '--dsw-alias-state-success-primary',
  )
  if (!mode && !background && !accent) return null
  return {
    ...(mode ? { mode } : {}),
    ...(background ? { background } : {}),
    ...(surface ? { surface } : {}),
    ...(border ? { border } : {}),
    ...(textPrimary ? { textPrimary } : {}),
    ...(textSecondary ? { textSecondary } : {}),
    ...(accent ? { accent } : {}),
    ...(completeAccent ? { completeAccent } : {}),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  }
}

export function readHostThemeSnapshot(host, stateDir = defaultStateDir()) {
  try {
    const file = themeSnapshotPath(host, stateDir)
    if (!existsSync(file)) return null
    return normalizeThemeSnapshot(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

export function writeHostThemeSnapshot(host, rawSnapshot, stateDir = defaultStateDir()) {
  const clean = normalizeThemeSnapshot(rawSnapshot)
  if (!clean) return null
  const file = themeSnapshotPath(host, stateDir)
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(clean, null, 2) + '\n', 'utf8')
    renameSync(temp, file)
  } catch {
    // 写快照失败不影响运行。
  }
  return clean
}

function defaultZedExtensionsDir() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Zed', 'extensions', 'installed')
  }
  return join(homedir(), '.local', 'share', 'zed', 'extensions', 'installed')
}

function listZedThemeDirs(zedDir, extensionsDir) {
  const dirs = [join(zedDir, 'themes')]
  if (extensionsDir && existsSync(extensionsDir)) {
    try {
      for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const candidate = join(extensionsDir, entry.name, 'themes')
        if (existsSync(candidate)) dirs.push(candidate)
      }
    } catch {
      // 扩展目录不可读时退回用户 themes 目录。
    }
  }
  return dirs
}

/**
 * 动态读取 Zed 的 `settings.json` 及自定义 / 扩展主题文件中的颜色。
 * @param {{ zedConfigDir?: string, zedExtensionsDir?: string, systemAppearance?: 'light' | 'dark' }} [options]
 */
export function readZedTheme(options = {}) {
  const zedDir = options.zedConfigDir || join(homedir(), '.config', 'zed')
  const extensionsDir = options.zedExtensionsDir ?? (options.zedConfigDir ? '' : defaultZedExtensionsDir())
  const settingsFile = join(zedDir, 'settings.json')
  if (!existsSync(settingsFile)) return null
  try {
    const parsed = JSON.parse(stripJsonc(readFileSync(settingsFile, 'utf8')))
    const themeField = parsed?.theme
    const sysMode = options.systemAppearance || detectSystemAppearance()
    let mode = sysMode
    let themeName = ''

    if (typeof themeField === 'string') {
      themeName = themeField.trim()
      if (/light/i.test(themeName)) mode = 'light'
      else if (/dark|night|obsidian|black/i.test(themeName)) mode = 'dark'
    } else if (themeField && typeof themeField === 'object') {
      if (themeField.mode === 'light' || themeField.mode === 'dark') {
        mode = themeField.mode
      } else {
        mode = sysMode
      }
      themeName = String(themeField[mode] ?? '').trim()
    }

    let customColors = null
    if (themeName) {
      for (const themesDir of listZedThemeDirs(zedDir, extensionsDir)) {
        customColors = findZedThemeColors(themesDir, themeName)
        if (customColors) break
      }
    }
    return {
      mode: customColors?.mode || mode,
      themeName,
      ...(customColors || {}),
    }
  } catch {
    return null
  }
}

function findZedThemeColors(themesDir, targetName) {
  if (!existsSync(themesDir)) return null
  const pick = (backdrop, ...candidates) => {
    for (const raw of candidates) {
      const hex = normalizeCssColor(raw, backdrop)
      if (hex) return hex
    }
    return undefined
  }
  try {
    const files = readdirSync(themesDir).filter((f) => f.endsWith('.json'))
    for (const file of files) {
      try {
        const doc = JSON.parse(stripJsonc(readFileSync(join(themesDir, file), 'utf8')))
        const themes = Array.isArray(doc?.themes) ? doc.themes : []
        const hit = themes.find((t) => typeof t?.name === 'string' && t.name.toLowerCase() === targetName.toLowerCase())
        if (!hit || !hit.style) continue
        const s = hit.style
        const mode = hit.appearance === 'light' || hit.appearance === 'dark' ? hit.appearance : undefined
        const fallbackBg = mode === 'light' ? '#FFFFFF' : '#21252B'
        const background = pick(fallbackBg, s['elevated_surface.background'], s['panel.background'], s.background, s['surface.background'])
        const bg = background || fallbackBg
        const rawSurface = pick(bg, s['element.background'], s['surface.background'], s['editor.background'])
        const surface = rawSurface && rawSurface !== background ? rawSurface : undefined
        const border = pick(bg, s['border.variant'], s.border)
        const textPrimary = pick(bg, s.text)
        const textSecondary = pick(bg, s['text.muted'])
        const accent = pick(bg, s['text.accent'], s['border.focused'])
        // 完成色优先跟随主题强调色，主题缺失时才退回 created/success，避免与全局主色脱节。
        const completeAccent = pick(bg, s['text.accent'], s.created, s.success)
        return {
          ...(mode ? { mode } : {}),
          ...(background ? { background } : {}),
          ...(surface ? { surface } : {}),
          ...(border ? { border } : {}),
          ...(textPrimary ? { textPrimary } : {}),
          ...(textSecondary ? { textSecondary } : {}),
          ...(accent ? { accent } : {}),
          ...(completeAccent ? { completeAccent } : {}),
        }
      } catch {
        // 单个主题文件损坏跳过。
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * 解析最终用于渲染悬浮卡片的完整动态主题（支持亮/暗实时自适应）。
 * @param {{ host?: string, settings?: Record<string, any>, stateDir?: string, systemAppearance?: 'light' | 'dark', zedConfigDir?: string }} [options]
 */
export function resolveHostTheme(options = {}) {
  const host = typeof options.host === 'string' && options.host.trim() ? options.host.trim().toLowerCase() : 'antigravity'
  const profile = getHostProfile(host)
  const settings = options.settings || {}
  const stateDir = options.stateDir || defaultStateDir()
  const systemAppearance = options.systemAppearance || detectSystemAppearance()
  const requestedMode = settings.themeMode === 'light' || settings.themeMode === 'dark' ? settings.themeMode : 'auto'

  let live = null
  let source = 'system'

  if (requestedMode === 'auto') {
    if (host === 'zed') {
      const zedTheme = readZedTheme({
        zedConfigDir: options.zedConfigDir,
        zedExtensionsDir: options.zedExtensionsDir,
        systemAppearance,
      })
      if (zedTheme) {
        live = zedTheme
        source = zedTheme.themeName ? `zed:${zedTheme.themeName}` : 'zed:settings'
      }
    }
    if (!live) {
      const snap = readHostThemeSnapshot(host, stateDir)
      if (snap) {
        live = snap
        source = `${host}:live`
      } else if (host === 'antigravity') {
        const cfgMode = readAntigravityConfigMode(options.antigravityConfigPath)
        if (cfgMode) {
          live = { mode: cfgMode }
          source = 'antigravity:config'
        }
      }
    }
  }

  const effectiveMode = requestedMode !== 'auto'
    ? requestedMode
    : (live?.mode || systemAppearance)

  const base = profile.themes[effectiveMode] || profile.themes.dark
  const customAccent = normalizeCssColor(settings.accent)
  const resolvedBg = (requestedMode === 'auto' && live?.background) || base.background
  const derivedSurface = effectiveMode === 'light'
    ? mixHex(resolvedBg, '#000000', 0.055)
    : mixHex(resolvedBg, '#FFFFFF', 0.065)
  const derivedBorder = effectiveMode === 'light'
    ? mixHex(resolvedBg, '#000000', 0.14)
    : mixHex(resolvedBg, '#FFFFFF', 0.15)

  const resolved = {
    mode: effectiveMode,
    source: requestedMode !== 'auto' ? `manual:${requestedMode}` : source,
    background: resolvedBg,
    surface: (requestedMode === 'auto' && live?.surface) || (requestedMode === 'auto' && live?.background ? derivedSurface : base.surface),
    border: (requestedMode === 'auto' && live?.border) || (requestedMode === 'auto' && live?.background ? derivedBorder : base.border),
    textPrimary: (requestedMode === 'auto' && live?.textPrimary) || base.textPrimary,
    textSecondary: (requestedMode === 'auto' && live?.textSecondary) || base.textSecondary,
    accent: customAccent || (requestedMode === 'auto' && live?.accent) || base.accent,
    completeAccent: (requestedMode === 'auto' && live?.completeAccent) || base.completeAccent,
  }

  return {
    ...resolved,
    // 同时附带该宿主原生亮/暗兜底表，供 Swift 端在未命中显式覆盖时使用。
    light: { ...profile.themes.light, ...(customAccent ? { accent: customAccent } : {}) },
    dark: { ...profile.themes.dark, ...(customAccent ? { accent: customAccent } : {}) },
  }
}
