/**
 * answer-card · 卡片载荷构造器（审批 / 提问 / 完成 / 自检）。
 *
 * 将各宿主事件统一映射到 PromptWindow.swift 载荷格式。
 *
 * @module answer-card/core/protocol
 */

import { resolveHostTheme } from './theme.mjs'

/**
 * 压缩过长文本为单行摘要（用于标题、工具名等单行区域）。
 * @param {string | undefined} text
 * @param {number} [limit]
 * @returns {string | undefined}
 */
export function shorten(text, limit = 840) {
  if (typeof text !== 'string') return undefined
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return undefined
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/**
 * 截断文本但保留换行与 Markdown 结构（用于卡片正文与详情）。
 * @param {string | undefined} text
 * @param {number} [limit]
 * @returns {string | undefined}
 */
export function shortenMultiline(text, limit = 840) {
  if (typeof text !== 'string') return undefined
  const cleaned = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (cleaned.length === 0) return undefined
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1).trimEnd()}…` : cleaned
}

/**
 * 从路径取可读目录名。
 * @param {string | undefined} path
 * @returns {string}
 */
export function baseName(path) {
  if (typeof path !== 'string' || path.length === 0) return ''
  const segment = path.split(/[\\/]/).filter(Boolean).pop()
  if (segment && !/^[A-Za-z]:$/.test(segment)) return segment
  return ''
}

/**
 * 从设置与宿主实时主题动态生成外观载荷（支持浅色/深色自适应）。
 * @param {Record<string, any>} settings
 * @param {string} [overrideAccent]
 * @param {string} [host]
 */
export function appearanceOf(settings, overrideAccent, host) {
  const resolved = resolveHostTheme({ host, settings })
  return {
    accent: overrideAccent || resolved.accent,
    theme: {
      mode: resolved.mode,
      background: resolved.background,
      surface: resolved.surface,
      border: resolved.border,
      textPrimary: resolved.textPrimary,
      textSecondary: resolved.textSecondary,
    },
    position: settings.position,
    width: settings.width,
    fontScale: settings.fontScale,
    sound: settings.sound,
    autoDismissMs: settings.autoDismissMs,
  }
}

/**
 * 构造「工具审批」卡片载荷：原样转发宿主/Agent 提供的标题、工具名、详情与选项，不额外拼接引导文案。
 * @param {{
 *   host?: string,
 *   hostLabel: string,
 *   title: string,
 *   toolName: string,
 *   reason?: string,
 *   choices?: Array<{ id: string, label: string, hint?: string }>,
 *   settings: Record<string, any>,
 * }} params
 */
export function buildApprovalPayload({
  host,
  hostLabel,
  title,
  toolName,
  reason,
  choices,
  allowText = false,
  inputPlaceholder,
  settings,
}) {
  const detail = shortenMultiline(reason, 4000)
  const resolvedChoices = Array.isArray(choices) && choices.length > 0
    ? choices
    : [
        { id: 'allow', label: '允许一次' },
        { id: 'deny', label: '拒绝' },
      ]
  return {
    kind: 'approval',
    kicker: hostLabel,
    title,
    subtitle: toolName || undefined,
    message: detail,
    groups: [{
      id: 'approval',
      text: '',
      multi: false,
      ...(inputPlaceholder ? { placeholder: inputPlaceholder } : {}),
      choices: resolvedChoices,
    }],
    ...(allowText ? { allowText: true } : {}),
    submit: '确认',
    dismiss: '稍后处理',
    ...appearanceOf(settings, undefined, host),
  }
}

/**
 * 构造「模型提问 / 计划待审」卡片载荷。
 * @param {{
 *   host?: string,
 *   hostLabel: string,
 *   title: string,
 *   questions: Array<{ id?: string, header?: string, question?: string, detail?: string, multiSelect?: boolean, options?: Array<{ label?: string, description?: string } | string> }>,
 *   settings: Record<string, any>,
 *   allowText?: boolean,
 * }} params
 */
export function buildQuestionPayload({ host, hostLabel, title, questions, settings, allowText = true }) {
  const groups = questions.map((question, index) => {
    const id = typeof question?.id === 'string' && question.id.length > 0 ? question.id : `q${index}`
    const options = Array.isArray(question?.options) ? question.options : []
    const text = typeof question?.question === 'string' && question.question.trim().length > 0
      ? question.question.trim()
      : '（模型没有给出题干）'
    const header = typeof question?.header === 'string' ? question.header.trim() : ''
    return {
      id,
      text: header.length > 0 ? `${header}｜${text}` : text,
      detail: shortenMultiline(question?.detail, 4000),
      multi: question?.multiSelect === true,
      input: options.length === 0,
      choices: options.map((option, optionIndex) => {
        if (typeof option === 'string') {
          return { id: String(optionIndex), label: option }
        }
        return {
          id: String(optionIndex),
          label: typeof option?.label === 'string' ? option.label : `选项 ${optionIndex + 1}`,
          hint: typeof option?.description === 'string' ? option.description : undefined,
        }
      }),
    }
  })

  return {
    groups,
    payload: {
      kind: 'question',
      kicker: hostLabel,
      title,
      subtitle: questions.length > 1 ? `共 ${questions.length} 个问题` : undefined,
      groups,
      allowText,
      submit: '提交答案',
      dismiss: '稍后处理',
      ...appearanceOf(settings, undefined, host),
    },
  }
}

/**
 * 将 Swift 卡片返回映射为结构化答案数组。
 * @param {Array<any>} groups
 * @param {{ answers?: Record<string, string[]>, texts?: Record<string, string> }} outcome
 */
export function mapQuestionAnswers(groups, outcome) {
  const picked = outcome?.answers ?? {}
  const texts = outcome?.texts ?? {}
  return groups.map((group) => {
    if (group.input) {
      const typed = (picked[group.id] ?? [])[0] ?? texts[group.id] ?? ''
      const clean = typeof typed === 'string' ? typed.trim() : ''
      return { id: group.id, question: group.text, selected: [], ...(clean.length > 0 ? { custom: clean } : {}) }
    }
    const chosen = picked[group.id] ?? []
    const selected = chosen
      .map((key) => group.choices.find((choice) => choice.id === key)?.label)
      .filter((label) => typeof label === 'string')
    const typed = typeof texts[group.id] === 'string' ? texts[group.id].trim() : ''
    return { id: group.id, question: group.text, selected, ...(typed.length > 0 ? { custom: typed } : {}) }
  })
}

/**
 * 卡片是否支持「卡内追问」：取决于宿主有没有把追问送回 agent 的通道。
 * - Antigravity：Stop hook 返回 `decision: continue`，可由设置关闭
 * - DSH：agent 句柄的 `followup()` 直接排队下一轮，始终可用
 * - Zed 原生 agent：没有注入通道
 * @param {string} [host]
 * @param {Record<string, any>} [settings]
 * @returns {boolean}
 */
export function supportsFollowUp(host, settings = {}) {
  const id = String(host || '').toLowerCase()
  if (id === 'dsh') return true
  if (id === 'antigravity') return settings.allowQuickFollowUp !== false
  return false
}

/**
 * 完成卡的追问输入分组。
 * @param {string} hostLabel
 * @returns {Array<Record<string, any>>}
 */
function followUpGroups(hostLabel) {
  return [{
    id: 'followup',
    text: '',
    multi: false,
    input: true,
    optional: true,
    placeholder: `直接输入追问继续，或留空点「回到 ${hostLabel}」…`,
    choices: [],
  }]
}

/**
 * 构造「任务完成」卡片载荷。
 * @param {{ host?: string, hostLabel: string, title: string, message?: string, subtitle?: string, settings: Record<string, any>, allowFollowUp?: boolean }} params
 */
export function buildCompletePayload({ host, hostLabel, title, message, subtitle, settings, allowFollowUp = false }) {
  const groups = allowFollowUp ? followUpGroups(hostLabel) : []
  const resolvedTheme = resolveHostTheme({ host, settings })
  const completeAccent = resolvedTheme.completeAccent || '#2FBF71'

  return {
    kind: 'complete',
    kicker: `${hostLabel} · 已完成`,
    title,
    subtitle,
    message: shortenMultiline(message, 8000),
    groups,
    submit: `回到 ${hostLabel}`,
    ...(allowFollowUp ? { submitWhenTyped: `发送到 ${hostLabel}` } : {}),
    dismiss: '知道了',
    ...appearanceOf(settings, completeAccent, host),
  }
}

/**
 * 构造自检测试卡片载荷。
 * @param {{ host?: string, hostLabel: string, settings: Record<string, any> }} params
 */
export function buildTestPayload({ host, hostLabel, settings }) {
  return {
    kind: 'test',
    kicker: `${hostLabel} · 卡片测试`,
    title: '这是一张测试卡片',
    subtitle: `位置 \`${settings.position}\` · 字号 **${Math.round(Number(settings.fontScale ?? 1) * 100)}%** · 宽度 **${settings.width}pt**`,
    message: '- 支持 **加粗**、*斜体*、`行内代码` 与 [GitHub 链接](https://github.com/Asthestarsfalll/answer-card)\n- 下方输入框支持 **自动换行**（回车换行，`⌘⏎` 快捷提交）\n- 可拖动卡片空白区域自由调整位置',
    groups: [{
      id: 'demo',
      text: '点一个选项，或在下方输入框试试居中效果：',
      multi: false,
      choices: [
        { id: 'ok', label: '排版与居中正常' },
        { id: 'bad', label: '还需要继续微调' },
      ],
    }],
    allowText: true,
    submit: '提交',
    dismiss: '关闭',
    ...appearanceOf(settings, undefined, host),
  }
}

/**
 * 构造「回到宿主」测试卡片载荷。
 * @param {{ host?: string, hostLabel: string, settings: Record<string, any> }} params
 */
export function buildReturnTestPayload({ host, hostLabel, settings }) {
  const command = String(settings.returnCommand ?? '').trim()
  // 与真实完成卡保持一致：支持追问的宿主也带上输入框。
  const allowFollowUp = supportsFollowUp(host, settings)
  return {
    kind: 'complete',
    kicker: `${hostLabel} · 回到 ${hostLabel} 测试`,
    title: `测试「回到 ${hostLabel}」`,
    subtitle: command.length > 0 ? '当前：自定义命令' : '当前：默认行为',
    message: command.length > 0
      ? `点下面按钮会执行：${command.slice(0, 120)}`
      : `点下面按钮会激活 ${hostLabel} 窗口，并把鼠标指针移到输入框附近。`,
    groups: allowFollowUp ? followUpGroups(hostLabel) : [],
    submit: `回到 ${hostLabel}`,
    ...(allowFollowUp ? { submitWhenTyped: `发送到 ${hostLabel}` } : {}),
    dismiss: '关闭',
    ...appearanceOf(settings, settings.accent, host),
  }
}
