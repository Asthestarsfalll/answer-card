/**
 * Antigravity MCP App 启动器。
 *
 * 所有设置界面都在 adapters/shared/ui/settings-element.mjs 的
 * <answer-card-settings> 自定义元素里；这里只负责：
 *   1. 连接 MCP App 宿主；
 *   2. 把 MCP 工具调用包装成组件需要的 transport.call；
 *   3. 把宿主主题上下文转交给组件。
 */

import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps'
import { defineAnswerCardSettings } from '../../../shared/ui/settings-element.mjs'

const app = new App({ name: 'Answer Card Settings', version: '1.0.0' }, {})

function extractPayload(res) {
  if (!res || typeof res !== 'object') return null
  if (res.structuredContent && typeof res.structuredContent === 'object') {
    return res.structuredContent
  }
  const text = Array.isArray(res.content) ? res.content.find((c) => typeof c?.text === 'string')?.text : undefined
  if (typeof text === 'string' && text.trim().startsWith('{')) {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  return null
}

async function call(name, args = {}) {
  const res = await app.callServerTool({ name, arguments: args })
  const payload = extractPayload(res)
  if (res?.isError) {
    const message = payload?.error || res?.content?.[0]?.text || '操作失败'
    throw new Error(message)
  }
  return payload
}

function applyPageTheme(ctx) {
  if (!ctx) return
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme)
    document.documentElement.dataset.theme = ctx.theme
  }
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables)
}

function showFatalError(err) {
  const box = document.createElement('pre')
  box.style.cssText = 'margin:24px;padding:14px;border-radius:10px;background:rgba(239,68,68,.08);color:#f87171;white-space:pre-wrap;font:12px ui-monospace,Menlo,monospace;'
  box.textContent = `Answer Card 设置加载失败：${String(err)}`
  document.body.prepend(box)
}

defineAnswerCardSettings()

const element = document.createElement('answer-card-settings')
element.host = 'antigravity'
document.body.appendChild(element)

let pendingState = null

// 必须在 connect() 前注册，避免丢失宿主最早的结果。
app.ontoolresult = (result) => {
  const payload = extractPayload(result)
  if (payload?.ok && payload.effective) {
    pendingState = payload
    element.applyState(payload)
  }
}

app.onhostcontextchanged = (ctx) => {
  applyPageTheme(ctx)
  element.applyHostContext(ctx)
}

app.connect()
  .then(() => {
    const ctx = app.getHostContext()
    applyPageTheme(ctx)
    element.transport = {
      call,
      getHostContext: () => app.getHostContext(),
      supportsThemeSync: true,
      themeHost: 'antigravity',
    }
    element.applyHostContext(ctx)
    if (pendingState) element.applyState(pendingState)
  })
  .catch((err) => {
    showFatalError(err)
  })
