/**
 * answer-card · Antigravity 生命周期 Hook 适配层。
 *
 * 挂载事件（hooks.json）：
 *   1. PreToolUse (ask_question)     -> 后台弹悬浮提问卡；答完将答案通过 deny.reason 交回模型；
 *                                       前台/静音/稍后处理/超时则 allow，无损回退原生弹窗。
 *   2. PreToolUse (run_command 等)    -> 按 approvalPolicy 后台弹悬浮审批卡；允许返回 allow，
 *                                       拒绝返回 deny，稍后处理/前台/超时返回 {} 交回原生权限引擎。
 *   3. Stop                          -> 一轮完成后后台弹完成卡；留空点主按钮激活 Antigravity，
 *                                       输入追问文字则直接返回 decision:"continue" 续跑下一轮。
 *
 * 失败开放：任何异常或超时均输出安全回退 JSON，绝不卡死对话。
 *
 * @module answer-card/adapters/antigravity/hook
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  activateHost,
  createTracer,
  ensureHelper,
  isHostFocused,
  isMainModule,
  showCard,
  withCardLock,
} from '../../core/helper.mjs'
import {
  baseName,
  buildApprovalPayload,
  buildCompletePayload,
  buildQuestionPayload,
  mapQuestionAnswers,
  shorten,
  shortenMultiline,
} from '../../core/protocol.mjs'
import {
  HOST_PROFILES,
  defaultRecentPath,
  defaultSettingsPath,
  defaultStateDir,
  isCoolingDown,
  muteReasonOf,
  recordRecentEntry,
  resolveSettings,
  writeSettings,
} from '../../core/settings.mjs'

const HOST = 'antigravity'
const PROFILE = HOST_PROFILES.antigravity
/** 留足余量，确保在 hooks.json 的 180s 超时前优雅退出。 */
const MAX_CARD_WAIT_MS = 170_000

const EXTERNAL_COMMAND_PATTERNS = [
  /\bgit\s+push\b/i,
  /\bgh\s+/i,
  /\b(?:curl|wget)\b/i,
  /\brm\s+-[a-z]*[rf]/i,
  /\bsudo\b/i,
  /\bnpm\s+publish\b/i,
  /\b(?:docker|kubectl|ssh|scp|rsync|brew)\b/i,
  /\bkill(?:all)?\b/i,
]

/**
 * 构造 Antigravity `PreToolUse` 所需的 `permissionOverrides` 临时授权列表，
 * 使悬浮窗点击「允许」后直接放行，不再弹出 Antigravity 原生二次确认框。
 * @param {{ name?: string, args?: Record<string, any> }} toolCall
 * @returns {string[]}
 */
export function buildPermissionOverrides(toolCall) {
  const name = String(toolCall?.name ?? '')
  const args = toolCall?.args && typeof toolCall.args === 'object' ? toolCall.args : {}
  if (name === 'call_mcp_tool') {
    const server = String(args.ServerName ?? '').trim()
    const tool = String(args.ToolName ?? '').trim()
    if (server && tool) return [`mcp(${server}/${tool})`]
    return []
  }
  if (name === 'run_command') {
    const cmd = String(args.CommandLine ?? '').trim()
    if (!cmd) return []
    const grants = [`command(${cmd})`]
    if (args.BypassSandbox === true) grants.push(`unsandboxed(${cmd})`)
    return grants
  }
  if (name === 'write_file' || name === 'edit_file') {
    const path = String(args.Path ?? '').trim()
    return path ? [`write_file(${path})`] : []
  }
  return []
}

function allowWithOverrides(toolCall) {
  const overrides = buildPermissionOverrides(toolCall)
  return overrides.length > 0
    ? { decision: 'allow', permissionOverrides: overrides }
    : { decision: 'allow' }
}

function isPathInWorkspace(targetPath, input = {}) {
  if (typeof targetPath !== 'string' || targetPath.length === 0) return false
  const roots = [
    ...(Array.isArray(input?.workspacePaths) ? input.workspacePaths : []),
    ...(typeof input?.cwd === 'string' && input.cwd ? [input.cwd] : []),
    ...(typeof input?.artifactDirectoryPath === 'string' && input.artifactDirectoryPath ? [input.artifactDirectoryPath] : []),
  ].filter((p) => typeof p === 'string' && p.length > 0)
  return roots.some((root) => {
    const normalized = root.endsWith('/') ? root : `${root}/`
    return targetPath === root || targetPath.startsWith(normalized)
  })
}

/**
 * 为某次工具调用生成安全的「总是允许 / 本次会话允许」规则键：
 *   - `call_mcp_tool` -> `mcp:<ServerName>:<ToolName>`
 *   - `run_command`（无链式/管道/命令替换）-> `cmd:<bin> [subcmd]`，否则精确匹配 `cmd_exact:<cmd>`
 *   - 工作区外的 `write_file` / `edit_file` -> `<tool>:external:<path>`（避免工作区内的「会话/总是允许」误跳过外部配置确认）
 *   - 其它工具 -> `<toolName>`
 * @param {{ name?: string, args?: Record<string, any> }} toolCall
 * @param {Record<string, any>} [input]
 * @returns {string}
 */
export function approvalRuleKey(toolCall, input = {}) {
  const name = String(toolCall?.name ?? '')
  const args = toolCall?.args && typeof toolCall.args === 'object' ? toolCall.args : {}
  if (name === 'call_mcp_tool') {
    return `mcp:${args.ServerName ?? ''}:${args.ToolName ?? ''}`
  }
  if (name === 'run_command') {
    const cmd = String(args.CommandLine ?? '').trim()
    if (!cmd) return 'run_command'
    if (/[;&|`$\n<>]/.test(cmd)) {
      return `cmd_exact:${cmd.slice(0, 240)}`
    }
    const tokens = cmd.split(/\s+/).filter(Boolean)
    const bin = tokens[0]
    const sub = tokens[1] && !tokens[1].startsWith('-') && !tokens[1].includes('/') ? tokens[1] : ''
    return sub ? `cmd:${bin} ${sub}` : `cmd:${bin}`
  }
  if ((name === 'write_file' || name === 'edit_file') && typeof args.Path === 'string' && args.Path.trim()) {
    const targetPath = args.Path.trim()
    const hasRoots = Array.isArray(input?.workspacePaths) || Boolean(input?.cwd) || Boolean(input?.artifactDirectoryPath)
    if (hasRoots && !isPathInWorkspace(targetPath, input)) {
      return `${name}:external:${targetPath}`
    }
  }
  return name
}

function readSessionAllows(stateDir) {
  const file = join(stateDir, 'session-allows.json')
  try {
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function isSessionAllowed(sessionId, ruleKey, stateDir) {
  if (!sessionId || !ruleKey) return false
  const data = readSessionAllows(stateDir)
  const entry = data[sessionId]
  return Boolean(entry && Array.isArray(entry.rules) && entry.rules.includes(ruleKey))
}

export function recordSessionAllow(sessionId, ruleKey, stateDir) {
  if (!sessionId || !ruleKey) return
  const file = join(stateDir, 'session-allows.json')
  const now = Date.now()
  const data = readSessionAllows(stateDir)
  const existing = Array.isArray(data[sessionId]?.rules) ? data[sessionId].rules : []
  data[sessionId] = {
    updatedAt: now,
    rules: existing.includes(ruleKey) ? existing : [...existing, ruleKey],
  }
  // 清理超过 24 小时的旧会话记录。
  for (const [k, v] of Object.entries(data)) {
    if (!v || !Number.isFinite(v.updatedAt) || now - v.updatedAt > 86_400_000) delete data[k]
  }
  try {
    mkdirSync(stateDir, { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    renameSync(temp, file)
  } catch {
    // 写失败不阻断本次放行。
  }
}

/**
 * 判断某次工具调用是否应触发悬浮审批卡片（纯函数，便于单测）。
 * @param {{ name?: string, args?: Record<string, any> }} toolCall
 * @param {Record<string, any>} settings
 * @returns {boolean}
 */
export function shouldInterceptApproval(toolCall, settings, input = {}) {
  if (settings.confirmApprovals === false) return false
  const name = String(toolCall?.name ?? '')
  if (!name || name === 'ask_question') return false

  const ignored = Array.isArray(settings.approvalIgnoreTools) ? settings.approvalIgnoreTools : []
  const ruleKey = approvalRuleKey(toolCall, input)
  const isExternalFile = ruleKey.startsWith(`${name}:external:`)
  if (ignored.includes(ruleKey) || (!isExternalFile && ignored.includes(name))) return false

  const args = toolCall?.args && typeof toolCall.args === 'object' ? toolCall.args : {}
  const policy = settings.approvalPolicy || 'external'
  if (policy === 'all') return true
  if (policy === 'mutating') {
    return ['run_command', 'call_mcp_tool', 'write_file', 'edit_file'].includes(name)
  }
  if (policy === 'commands') {
    return ['run_command', 'call_mcp_tool'].includes(name)
  }
  // 默认 'external'：拦截越沙箱命令、高风险/外部命令、工作区外文件写操作与 MCP 工具。
  if (name === 'call_mcp_tool') return true
  if (name === 'write_file' || name === 'edit_file') {
    return isExternalFile
  }
  if (name === 'run_command') {
    if (args.BypassSandbox === true) return true
    const cmd = String(args.CommandLine ?? '')
    return EXTERNAL_COMMAND_PATTERNS.some((re) => re.test(cmd))
  }
  return false
}

/**
 * 计算 PreToolUse 跳过/回退时的安全决策（Antigravity 要求 PreToolUse 必须显式返回 decision，
 * 省略 decision 会触发 fail-closed 拦截）：
 *   - 越沙箱命令、高风险命令、MCP 工具、工作区外文件写操作 -> { decision: 'ask' }（走原生权限/Always Allow 缓存）
 *   - ask_question、沙箱内普通命令、工作区/产物目录内文件编辑 -> { decision: 'allow' }
 * @param {{ name?: string, args?: Record<string, any> }} toolCall
 * @param {Record<string, any>} input
 * @returns {{ decision: 'allow' | 'ask' }}
 */
export function passthroughDecision(toolCall, input = {}) {
  const name = String(toolCall?.name ?? '')
  const args = toolCall?.args && typeof toolCall.args === 'object' ? toolCall.args : {}
  if (name === 'ask_question') return { decision: 'allow' }
  if (name === 'call_mcp_tool') return { decision: 'ask' }
  if (name === 'run_command') {
    if (args.BypassSandbox === true) return { decision: 'ask' }
    const cmd = String(args.CommandLine ?? '')
    if (EXTERNAL_COMMAND_PATTERNS.some((re) => re.test(cmd))) return { decision: 'ask' }
    return { decision: 'allow' }
  }
  if (name === 'write_file' || name === 'edit_file') {
    const targetPath = typeof args.Path === 'string' ? args.Path : ''
    return isPathInWorkspace(targetPath, input) ? { decision: 'allow' } : { decision: 'ask' }
  }
  return { decision: 'ask' }
}

/**
 * 为工具调用生成简洁的人类可读摘要。
 * @param {{ name?: string, args?: Record<string, any> }} toolCall
 * @returns {{ toolLabel: string, reason: string | undefined }}
 */
export function describeToolCall(toolCall) {
  const name = String(toolCall?.name ?? '未知工具')
  const args = toolCall?.args && typeof toolCall.args === 'object' ? toolCall.args : {}
  if (name === 'run_command') {
    const summary = typeof args.toolSummary === 'string' ? args.toolSummary.trim() : ''
    const cmd = typeof args.CommandLine === 'string' ? args.CommandLine.trim() : ''
    const lines = []
    if (summary && args.BypassSandbox === true) {
      lines.push(`**${summary}**  \`BypassSandbox\``)
    } else if (summary) {
      lines.push(`**${summary}**`)
    } else if (args.BypassSandbox === true) {
      lines.push('`BypassSandbox`')
    }
    if (cmd) lines.push(`\`${cmd.replace(/`/g, '\'')}\``)
    return {
      toolLabel: 'run_command',
      reason: shortenMultiline(lines.join('\n'), 2000),
    }
  }
  if (name === 'call_mcp_tool') {
    const label = [args.ServerName, args.ToolName].filter(Boolean).join('/') || 'call_mcp_tool'
    const argText = args.Arguments && Object.keys(args.Arguments).length > 0
      ? shortenMultiline(JSON.stringify(args.Arguments, null, 2), 1200)
      : undefined
    return { toolLabel: `MCP: ${label}`, reason: argText }
  }
  if (name === 'write_file' || name === 'edit_file') {
    return { toolLabel: name, reason: shorten(args.Path, 240) }
  }
  return { toolLabel: name, reason: shortenMultiline(JSON.stringify(args, null, 2), 1200) }
}

/**
 * 从 Antigravity hook 输入推断卡片标题。
 * @param {Record<string, any>} input
 * @returns {string}
 */
export function titleFromInput(input) {
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : input?.workspacePaths?.[0]
  const dir = baseName(cwd)
  const prompt = shorten(input?.lastUserInput, 44)
  if (dir && prompt) return `${dir} · ${prompt}`
  if (dir) return dir
  if (prompt) return prompt
  const id = typeof input?.conversationId === 'string' ? input.conversationId : ''
  return id.length >= 8 ? id.slice(0, 8) : PROFILE.displayName
}

/**
 * 将 Antigravity ask_question 参数统一转换为 core/protocol 的问题数组。
 * @param {Array<any>} rawQuestions
 */
export function normalizeAskQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return []
  return rawQuestions.map((q, idx) => ({
    id: typeof q?.id === 'string' && q.id ? q.id : `q${idx}`,
    header: typeof q?.header === 'string' ? q.header : undefined,
    question: typeof q?.question === 'string' ? q.question : '（模型没有给出题干）',
    detail: typeof q?.detail === 'string' ? q.detail : undefined,
    multiSelect: q?.is_multi_select === true || q?.multiSelect === true,
    options: Array.isArray(q?.options) ? q.options : [],
  }))
}

/**
 * 将悬浮卡片回答格式化为清晰指令，回传给模型继续执行。
 * @param {Array<{ id: string, question: string, selected: string[], custom?: string }>} answers
 * @returns {string}
 */
export function formatQuestionReason(answers) {
  const lines = [
    '[answer-card] User already answered via macOS floating Answer Card. Treat these answers as authoritative and proceed directly without calling ask_question again:',
  ]
  for (let i = 0; i < answers.length; i += 1) {
    const a = answers[i]
    const parts = []
    if (a.selected.length > 0) parts.push(a.selected.join(', '))
    if (a.custom) parts.push(`Note: ${a.custom}`)
    lines.push(`${i + 1}. ${a.question} => ${parts.join(' | ') || '(skipped)'}`)
  }
  return lines.join('\n')
}

/**
 * 从 transcript.jsonl 尾部安全读取最后一段助手回复摘要（最多读 32KB）。
 * @param {string | undefined} transcriptPath
 * @returns {string | undefined}
 */
function readLastAssistantSnippet(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return undefined
  let fd
  try {
    const st = statSync(transcriptPath)
    const size = Math.min(st.size, 65536)
    if (size <= 0) return undefined
    const buf = Buffer.alloc(size)
    fd = openSync(transcriptPath, 'r')
    readSync(fd, buf, 0, size, st.size - size)
    const lines = buf.toString('utf8').split(/\r?\n/).reverse()
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        const text = entry?.text ?? entry?.content ?? entry?.message?.content ?? entry?.response
        if (typeof text === 'string' && text.trim().length > 0) {
          return shortenMultiline(text, 4000)
        }
      } catch {
        // 跳过半截行或非 JSON 行。
      }
    }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
  return undefined
}

function getPaths() {
  const dataDir = process.env.PLUGIN_DATA || ''
  return {
    settingsFile: process.env.ANSWER_CARD_SETTINGS_FILE || defaultSettingsPath(),
    recentFile: dataDir ? join(dataDir, 'recent.json') : defaultRecentPath(HOST),
    stateDir: dataDir ? join(dataDir, 'state') : defaultStateDir(),
  }
}

/**
 * 处理一次 Antigravity Hook 请求（可被单测直接调用）。
 * @param {Record<string, any>} input
 * @param {{ showCardFn?: typeof showCard, ensureHelperFn?: typeof ensureHelper, isHostFocusedFn?: typeof isHostFocused, activateHostFn?: typeof activateHost, paths?: ReturnType<typeof getPaths> }} [deps]
 * @returns {Promise<Record<string, any>>}
 */
export async function handleHookInput(input, deps = {}) {
  const event = String(input?.hookEventName ?? '')
  const paths = deps.paths ?? getPaths()
  const settings = resolveSettings({}, paths.settingsFile, HOST)
  const trace = createTracer(settings.traceFile)
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : (input?.workspacePaths?.[0] ?? '')
  const sessionId = typeof input?.conversationId === 'string' ? input.conversationId : ''
  const title = titleFromInput(input)

  const ensureFn = deps.ensureHelperFn ?? ensureHelper
  const focusedFn = deps.isHostFocusedFn ?? isHostFocused
  const showFn = deps.showCardFn ?? ((helperPath, payload, opts) =>
    withCardLock(() => showCard(helperPath, payload, opts)))
  const activateFn = deps.activateHostFn ?? activateHost

  const cardTimeout = () => {
    const autoMs = Number(settings.autoDismissMs ?? 0)
    return autoMs > 0 ? Math.min(autoMs + 2000, MAX_CARD_WAIT_MS) : MAX_CARD_WAIT_MS
  }

  // --- PreToolUse ---------------------------------------------------------
  if (event === 'PreToolUse') {
    const toolCall = input?.toolCall ?? {}
    const toolName = String(toolCall?.name ?? '')

    // 1. 模型提问（ask_question）
    if (toolName === 'ask_question') {
      if (settings.answerQuestions === false) return { decision: 'allow' }
      if (sessionId) recordRecentEntry({ id: sessionId, title, cwd }, paths.recentFile)
      const muted = muteReasonOf({ sessionId, cwd }, settings)
      if (muted !== null) {
        trace(`ag-question: skipped (${muted} muted)`)
        return { decision: 'allow' }
      }
      const questions = normalizeAskQuestions(toolCall?.args?.questions)
      if (questions.length === 0) return { decision: 'allow' }

      const ensured = ensureFn({ trace })
      if (!ensured.ok) return { decision: 'allow' }
      if (await focusedFn({
        helperPath: ensured.helperPath,
        bundleIds: PROFILE.bundleIds,
        processNames: PROFILE.processNames,
        skipWhenHostFocused: settings.skipWhenHostFocused,
      })) {
        trace('ag-question: skipped (Antigravity focused)')
        return { decision: 'allow' }
      }

      const { groups, payload } = buildQuestionPayload({
        host: HOST,
        hostLabel: PROFILE.shortName,
        title,
        questions,
        settings,
      })
      trace(`ag-question: showing count=${questions.length}`)
      const outcome = await showFn(ensured.helperPath, payload, { timeoutMs: cardTimeout(), trace })
      if (outcome.result !== 'choose') {
        trace(`ag-question: falling back (${outcome.result})`)
        return { decision: 'allow' }
      }
      const answers = mapQuestionAnswers(groups, outcome)
      trace(`ag-question: answered count=${answers.length}`)
      return {
        decision: 'deny',
        reason: formatQuestionReason(answers),
      }
    }

    // 2. 工具审批（run_command / call_mcp_tool / write_file / edit_file）
    const ruleKey = approvalRuleKey(toolCall, input)
    const isExternalFile = ruleKey.startsWith(`${toolName}:external:`)
    const ignored = Array.isArray(settings.approvalIgnoreTools) ? settings.approvalIgnoreTools : []
    if (ignored.includes(ruleKey) || (!isExternalFile && ignored.includes(toolName))) {
      trace(`ag-approval: auto-allowed by always-allow rule=${ruleKey}`)
      return allowWithOverrides(toolCall)
    }
    if (isSessionAllowed(sessionId, ruleKey, paths.stateDir)) {
      trace(`ag-approval: auto-allowed by session rule=${ruleKey}`)
      return allowWithOverrides(toolCall)
    }

    const fallback = passthroughDecision(toolCall, input)
    if (!shouldInterceptApproval(toolCall, settings, input)) return fallback
    if (sessionId) recordRecentEntry({ id: sessionId, title, cwd }, paths.recentFile)
    const muted = muteReasonOf({ sessionId, cwd }, settings)
    if (muted !== null) {
      trace(`ag-approval: skipped (${muted} muted)`)
      return fallback
    }
    const ensured = ensureFn({ trace })
    if (!ensured.ok) return fallback
    if (await focusedFn({
      helperPath: ensured.helperPath,
      bundleIds: PROFILE.bundleIds,
      processNames: PROFILE.processNames,
      skipWhenHostFocused: settings.skipWhenHostFocused,
    })) {
      trace('ag-approval: skipped (Antigravity focused)')
      return fallback
    }

    const { toolLabel, reason } = describeToolCall(toolCall)
    const payload = buildApprovalPayload({
      host: HOST,
      hostLabel: PROFILE.shortName,
      title,
      toolName: toolLabel,
      reason,
      choices: [
        { id: 'allow', label: '允许一次' },
        { id: 'allow_session', label: '本次会话允许' },
        { id: 'allow_always', label: '总是允许' },
        { id: 'deny', label: '拒绝' },
      ],
      allowText: true,
      inputPlaceholder: '拒绝原因或替代指令（直接输入提交 = 拒绝并告知模型，⌘⏎ 提交）…',
      settings,
    })
    trace(`ag-approval: showing tool=${toolLabel}`)
    const outcome = await showFn(ensured.helperPath, payload, { timeoutMs: cardTimeout(), trace })
    if (outcome.result === 'choose') {
      const picked = outcome.answers?.approval ?? []
      const note = String(outcome.texts?.approval ?? '').trim()
      if (picked.includes('allow')) {
        trace(`ag-approval: allowed once tool=${toolLabel}`)
        return allowWithOverrides(toolCall)
      }
      if (picked.includes('allow_session')) {
        recordSessionAllow(sessionId, ruleKey, paths.stateDir)
        trace(`ag-approval: allowed for session rule=${ruleKey}`)
        return allowWithOverrides(toolCall)
      }
      if (picked.includes('allow_always')) {
        const nextRules = ignored.includes(ruleKey) ? ignored : [...ignored, ruleKey]
        writeSettings({ approvalIgnoreTools: nextRules }, paths.settingsFile, HOST)
        trace(`ag-approval: always allowed rule=${ruleKey}`)
        return allowWithOverrides(toolCall)
      }
      if (picked.includes('deny') || note.length > 0) {
        trace(`ag-approval: denied tool=${toolLabel}${note ? ' (with reason)' : ''}`)
        return {
          decision: 'deny',
          reason: note
            ? `[answer-card] User rejected this tool call. User instruction: ${note}`
            : '[answer-card] User rejected this tool call.',
        }
      }
    }
    trace(`ag-approval: falling back (${outcome.result})`)
    return fallback
  }

  // --- Stop ---------------------------------------------------------------
  if (event === 'Stop') {
    if (settings.notifyOnComplete === false) return {}
    if (input?.continuationActive === true) return {}
    if (input?.terminationReason === 'USER_CANCELED') return {}

    if (sessionId) recordRecentEntry({ id: sessionId, title, cwd }, paths.recentFile)
    const muted = muteReasonOf({ sessionId, cwd }, settings)
    if (muted !== null) {
      trace(`ag-complete: skipped (${muted} muted)`)
      return {}
    }

    const cooldownKey = `${HOST}:${sessionId || cwd || 'default'}`
    if (isCoolingDown(cooldownKey, Number(settings.completeCooldownMs ?? 10000), paths.stateDir)) {
      trace('ag-complete: skipped (cooldown)')
      return {}
    }

    const ensured = ensureFn({ trace })
    if (!ensured.ok) return {}
    if (await focusedFn({
      helperPath: ensured.helperPath,
      bundleIds: PROFILE.bundleIds,
      processNames: PROFILE.processNames,
      skipWhenHostFocused: settings.skipWhenHostFocused,
    })) {
      trace('ag-complete: skipped (Antigravity focused)')
      return {}
    }

    const isError = input?.terminationReason === 'ERROR'
    const message = isError
      ? shorten(input?.error, 240)
      : readLastAssistantSnippet(input?.transcriptPath)

    const payload = buildCompletePayload({
      host: HOST,
      hostLabel: PROFILE.shortName,
      title,
      subtitle: isError ? '执行异常终止' : undefined,
      message,
      settings,
      allowFollowUp: settings.allowQuickFollowUp !== false,
    })

    trace(`ag-complete: showing reason=${input?.terminationReason ?? 'unknown'}`)
    const outcome = await showFn(ensured.helperPath, payload, { timeoutMs: cardTimeout(), trace })
    if (outcome.result === 'choose') {
      const followUp = String(outcome.texts?.followup ?? (outcome.answers?.followup?.[0] ?? '')).trim()
      if (followUp.length > 0) {
        trace('ag-complete: user sent follow-up')
        return {
          decision: 'continue',
          reason: `[answer-card] User follow-up from floating Answer Card:\n${followUp}`,
        }
      }
      trace('ag-complete: activating Antigravity')
      const dirName = baseName(cwd)
      activateFn({
        helperPath: ensured.helperPath,
        bundleIds: PROFILE.bundleIds,
        processNames: PROFILE.processNames,
        windowHints: [title, dirName, cwd].filter(Boolean),
        returnCommand: settings.returnCommand,
        warpPointer: settings.warpPointer,
        context: { host: HOST, sessionId, cwd, title },
        trace,
      })
    }
    return {}
  }

  return {}
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

if (isMainModule(import.meta.url)) {
  readStdin()
    .then(async (raw) => {
      if (!raw.trim()) {
        process.stdout.write('{}\n')
        return
      }
      const input = JSON.parse(raw)
      const output = await handleHookInput(input)
      process.stdout.write(JSON.stringify(output ?? {}) + '\n')
    })
    .catch(() => {
      // 失败开放：PreToolUse 回退原生确认，Stop 非 continue 即正常结束。
      process.stdout.write('{"decision":"ask"}\n')
    })
}
