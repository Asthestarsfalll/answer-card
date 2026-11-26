/**
 * answer-card · 跨宿主共享设置组件（无框架依赖）。
 *
 * 宿主只需提供：
 *   transport.call(name, args)  -> payload
 *   transport.getHostContext?()  -> MCP hostContext
 *   transport.supportsThemeSync  -> boolean
 * 通过 <answer-card-settings> 挂载；宿主列表来自 state.hosts，不再写死。
 */

const POSITION_LABELS = {
  center: '屏幕中央',
  'top-center': '上方居中',
  'bottom-center': '下方居中',
  'top-right': '右上角',
  'bottom-right': '右下角',
  'top-left': '左上角',
  'bottom-left': '左下角',
  cursor: '光标附近',
}

const THEME_MODE_LABELS = {
  auto: '自动跟随 Agent 实时主题（推荐）',
  light: '始终浅色',
  dark: '始终深色',
}

const APPROVAL_POLICY_LABELS = {
  external: '低打扰：仅越沙箱 / 高风险命令 / MCP（推荐）',
  commands: '全部命令行与 MCP（run_command + call_mcp_tool）',
  mutating: '全部修改操作（命令 + 写/改文件 + MCP）',
  all: '全部匹配工具',
}

export const SETTINGS_CSS = `:host {
  color-scheme: light dark;
  --ac-accent: var(--color-ring-primary, var(--color-text-info, #1A73E8));
  --ac-bg: var(--color-background-primary, #ffffff);
  --ac-card: var(--color-background-secondary, #f4f6f8);
  --ac-text: var(--color-text-primary, #1f1f1f);
  --ac-text-2: var(--color-text-secondary, #4b5563);
  --ac-text-3: var(--color-text-tertiary, #6b7280);
  --ac-border: var(--color-border-primary, rgba(128, 128, 128, 0.25));
  --ac-font: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
}
@media (prefers-color-scheme: dark) {
  :host(:not([data-theme="light"])) {
    --ac-accent: var(--color-ring-primary, var(--color-text-info, #4285F4));
    --ac-bg: var(--color-background-primary, #131314);
    --ac-card: var(--color-background-secondary, #1e1f20);
    --ac-text: var(--color-text-primary, #e3e3e3);
    --ac-text-2: var(--color-text-secondary, #bdc1c6);
    --ac-text-3: var(--color-text-tertiary, #9aa0a6);
  }
}
:host([data-theme="dark"]) {
  --ac-accent: var(--color-ring-primary, var(--color-text-info, #4285F4));
  --ac-bg: var(--color-background-primary, #131314);
  --ac-card: var(--color-background-secondary, #1e1f20);
  --ac-text: var(--color-text-primary, #e3e3e3);
  --ac-text-2: var(--color-text-secondary, #bdc1c6);
  --ac-text-3: var(--color-text-tertiary, #9aa0a6);
}
* { box-sizing: border-box; }
:host {
  display: block;
  background: var(--ac-bg);
  color: var(--ac-text);
  font-family: var(--ac-font);
  font-size: 13px;
  line-height: 1.5;
}
.wrap { max-width: 820px; margin: 0 auto; padding: 18px 16px 32px; }
.loading { padding: 32px; text-align: center; color: var(--ac-text-3); }
.top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.top h1 { margin: 0; font-size: 18px; font-weight: 600; }
.sub { margin: 4px 0 0; font-size: 12px; color: var(--ac-text-3); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.host-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.tab {
  border: 1px solid var(--ac-border);
  background: transparent;
  color: var(--ac-text-2);
  padding: 5px 12px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
}
.tab.active {
  background: var(--ac-accent);
  border-color: var(--ac-accent);
  color: #fff;
}
.file-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--ac-text-3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 280px;
  white-space: nowrap;
}
.status {
  min-height: 18px;
  font-size: 12px;
  color: var(--ac-text-3);
  margin-bottom: 10px;
}
.card {
  background: var(--ac-card);
  border: 1px solid var(--ac-border);
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 14px;
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.section-head h2 { margin: 0; font-size: 14px; font-weight: 600; }
.badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 500;
}
.host-badge {
  background: rgba(77, 107, 254, 0.16);
  color: var(--ac-accent);
}
.shared-badge {
  background: rgba(47, 191, 113, 0.16);
  color: #2FBF71;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 9px 0;
  border-top: 1px solid var(--ac-border);
}
.row:first-of-type { border-top: none; }
.row.stack { flex-direction: column; align-items: stretch; gap: 8px; }
.meta { min-width: 0; flex: 1; }
.label { font-size: 13px; font-weight: 500; }
.hint { font-size: 11.5px; color: var(--ac-text-3); margin-top: 2px; }
.block-hint { margin: 0 0 10px; }
.toggle {
  width: 40px;
  height: 22px;
  border-radius: 11px;
  border: 1px solid var(--ac-border);
  background: transparent;
  position: relative;
  cursor: pointer;
  flex: none;
  padding: 0;
}
.toggle.on { background: var(--ac-accent); border-color: var(--ac-accent); }
.toggle .knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--ac-text-3);
  transition: left 0.15s ease;
}
.toggle.on .knob { left: 20px; background: #fff; }
.input {
  padding: 6px 9px;
  border-radius: 7px;
  border: 1px solid var(--ac-border);
  background: var(--ac-bg);
  color: var(--ac-text);
  font-size: 12.5px;
  font-family: inherit;
}
.select { max-width: 340px; }
.num { width: 110px; }
.grow { flex: 1; min-width: 0; }
.range { width: 200px; accent-color: var(--ac-accent); }
.color-wrap { display: flex; align-items: center; gap: 8px; }
.color { width: 34px; height: 26px; border: none; background: transparent; padding: 0; cursor: pointer; }
.swatches { display: flex; align-items: center; gap: 6px; }
.swatch {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 1px solid var(--ac-border);
  display: inline-block;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--ac-text-2); }
.btn {
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--ac-border);
  background: transparent;
  color: var(--ac-text);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.btn.primary { background: var(--ac-accent); border-color: var(--ac-accent); color: #fff; }
.btn.subtle { color: var(--ac-text-2); }
.btn:hover { opacity: 0.9; }
.inline-form { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
.sub-block { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--ac-border); }
.sub-label { font-size: 12.5px; font-weight: 600; margin-bottom: 4px; }
.chips { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border-radius: 8px;
  border: 1px solid var(--ac-border);
  background: var(--ac-bg);
}
.chip-title { font-weight: 500; white-space: nowrap; }
.chip-detail {
  color: var(--ac-text-3);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.chip-x {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  border: 1px solid var(--ac-border);
  background: transparent;
  color: var(--ac-text-2);
  cursor: pointer;
  flex: none;
  line-height: 18px;
  padding: 0;
}
.empty { font-size: 12px; color: var(--ac-text-3); padding: 2px 0; }
.err-box {
  margin: 10px 0 0;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(239, 68, 68, 0.45);
  background: rgba(239, 68, 68, 0.08);
  color: #f87171;
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }`

export function createSettingsView({ root, hostEl, transport, initialHost = 'antigravity' }) {
  if (!root) throw new Error('root is required')
  if (!hostEl) throw new Error('hostEl is required')
  if (!transport || typeof transport.call !== 'function') throw new Error('transport.call is required')
  const $id = (id) => root.querySelector('#' + id)

  let state = null
  let statusText = ''
  let bootError = ''
  let busy = false
  const debounceTimers = new Map()
  
  function showFatalError(err) {
    bootError = err instanceof Error ? (err.stack || err.message) : String(err)
    render()
  }
  
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
  
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }
  
  function baseName(path) {
    return String(path || '').split('/').filter(Boolean).pop() || path || ''
  }
  
  function setStatus(text) {
    statusText = text
    const el = $id('status-bar')
    if (el) el.textContent = text
  }
  
  function activeHostMeta() {
    if (!state) return { id: 'antigravity', shortName: 'Antigravity', displayName: 'Antigravity' }
    return state.hosts.find((h) => h.id === state.host) || state.hosts[0]
  }
  
  async function callTool(name, args = {}) {
    return transport.call(name, args)
  }
  
  async function refreshState(host) {
    setStatus('同步中…')
    try {
      const next = await callTool('app_get_state', { host: host || state?.host || initialHost })
      if (next && next.ok) {
        bootError = ''
        state = next
        setStatus('')
        render()
      } else {
        bootError = '服务器返回了空的配置状态（app_get_state 无有效数据）'
        render()
      }
    } catch (err) {
      bootError = `读取配置失败：${err.message}`
      setStatus(bootError)
      render()
    }
  }
  
  function savePatch(scope, patch, immediate = false) {
    if (!state) return
    // 本地先乐观更新，避免控件回弹。
    state.effective = { ...state.effective, ...patch }
    if (scope === 'shared') {
      state.shared = { ...state.shared, ...patch }
    } else {
      state.hostOverrides = { ...state.hostOverrides, ...patch }
    }
  
    const key = `${scope}:${Object.keys(patch).sort().join(',')}`
    if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key))
  
    const run = async () => {
      debounceTimers.delete(key)
      setStatus('保存中…')
      try {
        const next = await callTool('app_save_settings', {
          scope,
          host: state.host,
          patch,
        })
        if (next && next.ok) {
          state = next
          setStatus('已保存（即时生效）')
          // 仅更新需要同步列表的区域或重新渲染（输入框正在输入时不打断焦点）。
          const activeTag = document.activeElement?.tagName
          if (activeTag !== 'INPUT' || document.activeElement?.type === 'range' || document.activeElement?.type === 'color') {
            render()
          }
        }
      } catch (err) {
        setStatus(`保存失败：${err.message}`)
      }
    }
  
    if (immediate) {
      run()
    } else {
      debounceTimers.set(key, setTimeout(run, 240))
    }
  }
  
  async function resetHostKeys(keys) {
    if (!state) return
    setStatus('恢复默认…')
    try {
      const next = await callTool('app_save_settings', {
        scope: 'host',
        host: state.host,
        resetKeys: keys,
      })
      if (next && next.ok) {
        state = next
        setStatus('已恢复共享默认')
        render()
      }
    } catch (err) {
      setStatus(`恢复失败：${err.message}`)
    }
  }
  
  async function sendTest(toolName, label) {
    if (!state || busy) return
    busy = true
    setStatus(`正在发送${label}…`)
    try {
      await callTool(toolName, { host: state.host })
      setStatus(`已发送${label}`)
    } catch (err) {
      setStatus(`发送失败：${err.message}`)
    } finally {
      busy = false
    }
  }
  
  function toggleListEntry(key, value) {
    if (!state) return
    const clean = String(value || '').trim()
    if (!clean) return
    const list = Array.isArray(state.effective[key]) ? state.effective[key] : []
    const next = list.includes(clean) ? list.filter((x) => x !== clean) : list.concat(clean)
    savePatch('host', { [key]: next }, true)
  }
  
  function switchHtml(id, checked, scope, key) {
    return `<button type="button" class="toggle ${checked ? 'on' : ''}" id="${id}" data-scope="${scope}" data-key="${key}" aria-pressed="${checked ? 'true' : 'false'}"><span class="knob"></span></button>`
  }
  
  function render() {
    if (!root) return
    if (!state) {
      root.innerHTML = `
        <div class="wrap">
          <div class="card">
            <div class="loading">${bootError ? 'Answer Card 设置加载失败' : '正在读取 Answer Card 配置…'}</div>
            ${bootError ? `<pre class="err-box">${esc(bootError)}</pre>` : ''}
            <div style="text-align:center;margin-top:12px;">
              <button type="button" class="btn" id="btn-retry-load">重试加载</button>
            </div>
            <div id="status-bar" class="status" style="text-align:center;margin-top:8px;">${esc(statusText)}</div>
          </div>
        </div>
      `
      $id('btn-retry-load')?.addEventListener('click', () => refreshState(initialHost))
      return
    }
  
    const s = state.effective
    const hostMeta = activeHostMeta()
    syncDynamicAccent()
    const caps = hostMeta.capabilities || {}
    const showQuickFollowUp = caps.quickFollowUp === true
    const showApprovalPolicy = caps.approvalPolicy === true
    const showIgnoreTools = caps.ignoreTools === true
    const showThemeSync = caps.themeSync === true && transport.supportsThemeSync === true
    const showReturnCommand = caps.returnCommand !== false
    const mutedWorkspaces = Array.isArray(s.mutedWorkspaces) ? s.mutedWorkspaces : []
    const mutedSessions = Array.isArray(s.mutedSessions) ? s.mutedSessions : []
    const alwaysAllowRules = Array.isArray(s.approvalIgnoreTools) ? s.approvalIgnoreTools : []
    const recentWorkspaces = (state.recent?.workspaces || []).filter((w) => !mutedWorkspaces.includes(w.path))
    const recentSessions = (state.recent?.sessions || []).filter((sess) => !mutedSessions.includes(sess.id))
    const hasCustomReturn = Boolean(state.hostOverrides?.returnCommand || s.returnCommand)
  
    root.innerHTML = `
      <div class="wrap">
        <header class="top">
          <div>
            <h1>Answer Card 设置</h1>
            <p class="sub">悬浮卡片外观全局共享；触发时机、返回命令与静音名单按 Agent 独立生效。</p>
          </div>
          <div class="actions">
            <button type="button" class="btn primary" id="btn-test">发送测试卡片</button>
            <button type="button" class="btn" id="btn-test-return">测试「回到 ${esc(hostMeta.shortName)}」</button>
          </div>
        </header>
  
        <div class="host-tabs" role="tablist">
          ${state.hosts.map((h) => `
            <button type="button" class="tab ${h.id === state.host ? 'active' : ''}" data-host="${esc(h.id)}">
              ${esc(h.shortName)}
            </button>
          `).join('')}
          <span class="file-hint" title="${esc(state.settingsFile)}">${esc(state.settingsFile)}</span>
        </div>
  
        <div id="status-bar" class="status">${esc(statusText)}</div>
  
        <section class="card">
          <div class="section-head">
            <h2>${esc(hostMeta.shortName)} 独立设置 · 弹出时机</h2>
            <span class="badge host-badge">仅作用于 ${esc(hostMeta.shortName)}</span>
          </div>
  
          <div class="row">
            <div class="meta">
              <div class="label">审批请求</div>
              <div class="hint">工具要权限时弹出悬浮卡，直接允许或拒绝。</div>
            </div>
            ${switchHtml('sw-approve', s.confirmApprovals !== false, 'host', 'confirmApprovals')}
          </div>
  
          <div class="row">
            <div class="meta">
              <div class="label">模型提问</div>
              <div class="hint">模型提问或待审计划时弹卡，支持单选、多选与自由输入。</div>
            </div>
            ${switchHtml('sw-question', s.answerQuestions !== false, 'host', 'answerQuestions')}
          </div>
  
          <div class="row">
            <div class="meta">
              <div class="label">任务完成提醒</div>
              <div class="hint">一轮执行结束时弹卡，可一键回到 ${esc(hostMeta.shortName)}。</div>
            </div>
            ${switchHtml('sw-complete', s.notifyOnComplete !== false, 'host', 'notifyOnComplete')}
          </div>
  
          ${showQuickFollowUp ? `

            <div class="row">
              <div class="meta">
                <div class="label">完成卡支持直接追问</div>
                <div class="hint">在完成卡片内输入文字并提交，直接开启下一轮而无需切回窗口。</div>
              </div>
              ${switchHtml('sw-followup', s.allowQuickFollowUp !== false, 'host', 'allowQuickFollowUp')}
            </div>
  
          ` : ''}
          ${showApprovalPolicy ? `

            <div class="row">
              <div class="meta">
                <div class="label">审批拦截策略</div>
                <div class="hint">决定哪些 PreToolUse 工具在后台弹出悬浮审批卡。</div>
              </div>
              <select id="sel-policy" class="input select">
                ${(state.approvalPolicies || Object.keys(APPROVAL_POLICY_LABELS)).map((p) => `
                  <option value="${esc(p)}" ${s.approvalPolicy === p ? 'selected' : ''}>${esc(APPROVAL_POLICY_LABELS[p] || p)}</option>
                `).join('')}
              </select>
            </div>
  
            <div class="sub-block">
              <div class="sub-label">已设为「总是允许」的规则（${alwaysAllowRules.length}）</div>
              <div class="chips">
                ${alwaysAllowRules.length === 0
                  ? '<div class="empty">暂无规则——在悬浮审批卡点击「总是允许」后会自动出现在这里。</div>'
                  : alwaysAllowRules.map((rule) => `
                      <div class="chip">
                        <span class="chip-title mono">${esc(rule)}</span>
                        <span class="chip-detail"></span>
                        <button type="button" class="chip-x" data-unmute-key="approvalIgnoreTools" data-unmute-val="${esc(rule)}" title="移除规则">×</button>
                      </div>
                    `).join('')}
              </div>
            </div>
          ` : ''}
        <div class="row">
            <div class="meta">
              <div class="label">弹出提示音</div>
              <div class="hint">这张卡片出现时播放系统提示音，按宿主独立设置。</div>
            </div>
            ${switchHtml('sw-sound', s.sound === true, 'host', 'sound')}
          </div>
        <div class="row">
            <div class="meta">
              <div class="label">只在后台时弹</div>
              <div class="hint">${esc(hostMeta.shortName)} 在前台时不弹，避免和窗口内原生卡片重复。</div>
            </div>
            ${switchHtml('sw-focus', s.skipWhenHostFocused !== false, 'host', 'skipWhenHostFocused')}
          </div>
        </section>
  
        <section class="card">
          <div class="section-head">
            <h2>${esc(hostMeta.shortName)} 独立设置 · 回到宿主</h2>
            <span class="badge host-badge">仅作用于 ${esc(hostMeta.shortName)}</span>
          </div>
  
          <div class="row">
            <div class="meta">
              <div class="label">回到 ${esc(hostMeta.shortName)} 时移动鼠标指针</div>
              <div class="hint">跨屏或跨桌面激活窗口后，自动把指针挪到输入框附近。</div>
            </div>
            ${switchHtml('sw-warp', s.warpPointer !== false, 'host', 'warpPointer')}
          </div>
  
          <div class="row stack">
            <div class="meta">
              <div class="label">回到 ${esc(hostMeta.shortName)} 的自定义命令</div>
              <div class="hint">留空 = 默认行为（激活 ${esc(hostMeta.shortName)} 窗口并可选挪指针）；填写后改为经 /bin/sh 执行该命令，完全独立于其他 Agent。</div>
            </div>
            <div class="inline-form">
              <input type="text" id="inp-return-cmd" class="input grow"
                placeholder="留空使用默认，例如 open -a &quot;${esc(hostMeta.displayName)}&quot;"
                value="${esc(s.returnCommand || '')}" />
              ${hasCustomReturn ? '<button type="button" class="btn subtle" id="btn-clear-return">恢复默认</button>' : ''}
            </div>
          </div>
  
          <div class="row">
            <div class="meta">
              <div class="label">完成提醒最小间隔（毫秒）</div>
              <div class="hint">同一会话两次「完成」提醒之间的冷却时间。</div>
            </div>
            <input type="number" id="inp-cooldown" class="input num" min="0" max="600000" step="1000" value="${Number(s.completeCooldownMs || 0)}" />
          </div>
        </section>
  
        <section class="card">
          <div class="section-head">
            <h2>${esc(hostMeta.shortName)} 独立设置 · 静音例外</h2>
            <span class="badge host-badge">仅作用于 ${esc(hostMeta.shortName)}</span>
          </div>
          <p class="hint block-hint">加入排除名单的工作区或会话不再弹悬浮卡，决定原样交回宿主原生界面。工作区末尾带 <code>/</code> 表示匹配整个目录树。</p>
  
          <div class="sub-block">
            <div class="sub-label">排除工作区（${mutedWorkspaces.length}）</div>
            <div class="inline-form">
              <select id="pick-ws" class="input select grow">
                <option value="">${recentWorkspaces.length === 0 ? '暂无最近触发的工作区' : '从最近触发的工作区选择…'}</option>
                ${recentWorkspaces.map((w) => `<option value="${esc(w.path)}">${esc(baseName(w.path))} — ${esc(w.path)}</option>`).join('')}
              </select>
              <button type="button" class="btn" id="btn-add-ws-pick">加入排除</button>
            </div>
            <div class="inline-form">
              <input type="text" id="inp-ws-manual" class="input grow" placeholder="或手动输入目录路径（末尾加 / 静音整个目录树）" />
              <button type="button" class="btn" id="btn-add-ws-manual">添加路径</button>
            </div>
            <div class="chips">
              ${mutedWorkspaces.length === 0
                ? '<div class="empty">暂未排除任何工作区</div>'
                : mutedWorkspaces.map((p) => `
                    <div class="chip">
                      <span class="chip-title">${esc(baseName(p) || p)}</span>
                      <span class="chip-detail">${esc(p)}</span>
                      <button type="button" class="chip-x" data-unmute-key="mutedWorkspaces" data-unmute-val="${esc(p)}" title="移出排除名单">×</button>
                    </div>
                  `).join('')}
            </div>
          </div>
  
          <div class="sub-block">
            <div class="sub-label">排除会话（${mutedSessions.length}）</div>
            <div class="inline-form">
              <select id="pick-sess" class="input select grow">
                <option value="">${recentSessions.length === 0 ? '暂无最近触发的会话' : '从最近触发的会话选择…'}</option>
                ${recentSessions.map((sess) => `<option value="${esc(sess.id)}">${esc(sess.title || sess.id.slice(0, 8))} — ${esc(baseName(sess.cwd) || sess.id.slice(0, 8))}</option>`).join('')}
              </select>
              <button type="button" class="btn" id="btn-add-sess-pick">加入排除</button>
            </div>
            <div class="inline-form">
              <input type="text" id="inp-sess-manual" class="input grow" placeholder="或手动输入会话 / conversationId" />
              <button type="button" class="btn" id="btn-add-sess-manual">添加会话</button>
            </div>
            <div class="chips">
              ${mutedSessions.length === 0
                ? '<div class="empty">暂未排除任何会话</div>'
                : mutedSessions.map((id) => {
                    const hit = (state.recent?.sessions || []).find((x) => x.id === id)
                    return `
                      <div class="chip">
                        <span class="chip-title">${esc(hit?.title || id.slice(0, 8))}</span>
                        <span class="chip-detail">${esc(hit?.cwd ? baseName(hit.cwd) : id)}</span>
                        <button type="button" class="chip-x" data-unmute-key="mutedSessions" data-unmute-val="${esc(id)}" title="移出排除名单">×</button>
                      </div>
                    `
                  }).join('')}
            </div>
          </div>
        </section>
  
        <section class="card">
          <div class="section-head">
            <h2>${esc(hostMeta.shortName)} 独立设置 · 主题与配色</h2>
            <span class="badge host-badge">实时自适应</span>
          </div>
  
          <div class="row">
            <div class="meta">
              <div class="label">主题模式</div>
              <div class="hint">自动模式会实时跟随 ${esc(hostMeta.shortName)} 当前亮/暗主题与配色（当前：${state.resolvedTheme?.mode === 'light' ? '浅色' : '深色'} · ${esc(state.resolvedTheme?.source || 'auto')}）。</div>
            </div>
            <select id="sel-theme-mode" class="input select">
              ${(state.themeModes || Object.keys(THEME_MODE_LABELS)).map((m) => `
                <option value="${esc(m)}" ${(s.themeMode || 'auto') === m ? 'selected' : ''}>${esc(THEME_MODE_LABELS[m] || m)}</option>
              `).join('')}
            </select>
          </div>
  
          <div class="row">
            <div class="meta">
              <div class="label">当前生效色板</div>
              <div class="hint">背景 / 控件 / 边框 / 强调色 / 完成色</div>
            </div>
            <div class="swatches">
              <span class="swatch" style="background:${esc(state.resolvedTheme?.background || '#fff')}" title="背景 ${esc(state.resolvedTheme?.background || '')}"></span>
              <span class="swatch" style="background:${esc(state.resolvedTheme?.surface || '#eee')}" title="控件 ${esc(state.resolvedTheme?.surface || '')}"></span>
              <span class="swatch" style="background:${esc(state.resolvedTheme?.border || '#ccc')}" title="边框 ${esc(state.resolvedTheme?.border || '')}"></span>
              <span class="swatch" style="background:${esc(state.resolvedTheme?.accent || '#4285F4')}" title="强调色 ${esc(state.resolvedTheme?.accent || '')}"></span>
              <span class="swatch" style="background:${esc(state.resolvedTheme?.completeAccent || '#34A853')}" title="完成色 ${esc(state.resolvedTheme?.completeAccent || '')}"></span>
              ${showThemeSync ? '<button type="button" class="btn subtle" id="btn-sync-theme">立即同步主题</button>' : ''}
            </div>
          </div>
  
          <div class="row">
            <div class="meta">
              <div class="label">强调主色（可选覆写）</div>
              <div class="hint">${s.accent ? '当前使用自定义主色；点击右侧可恢复自动跟随 Agent 主题。' : `当前自动跟随 ${esc(hostMeta.shortName)} 主题（${esc(state.resolvedTheme?.accent || '')}）。`}</div>
            </div>
            <div class="color-wrap">
              <input type="color" id="inp-accent" class="color" value="${esc(s.accent || state.resolvedTheme?.accent || '#4285F4')}" />
              <span class="mono">${esc(s.accent || '自动')}</span>
              ${s.accent ? '<button type="button" class="btn subtle" id="btn-reset-accent">跟随主题</button>' : ''}
            </div>
          </div>
        </section>
  
        <section class="card">
          <div class="section-head">
            <h2>外观与通用行为</h2>
            <span class="badge shared-badge">多 Agent 全局共享</span>
          </div>
  
          <div class="row">
            <div class="meta"><div class="label">出现位置</div></div>
            <select id="sel-pos" class="input select">
              ${(state.positions || Object.keys(POSITION_LABELS)).map((p) => `
                <option value="${esc(p)}" ${s.position === p ? 'selected' : ''}>${esc(POSITION_LABELS[p] || p)}</option>
              `).join('')}
            </select>
          </div>
  
          <div class="row">
            <div class="meta"><div class="label">卡片宽度：<strong id="val-width">${Number(s.width || 452)} pt</strong></div></div>
            <input type="range" id="rng-width" class="range" min="320" max="720" step="4" value="${Number(s.width || 452)}" />
          </div>
  
          <div class="row">
            <div class="meta"><div class="label">字号缩放：<strong id="val-scale">${Math.round(Number(s.fontScale || 1) * 100)}%</strong></div></div>
            <input type="range" id="rng-scale" class="range" min="70" max="180" step="5" value="${Math.round(Number(s.fontScale || 1) * 100)}" />
          </div>
  
          <div class="row">
            <div class="meta">
              <div class="label">自动关闭（毫秒）</div>
              <div class="hint">0 表示一直等你点击，不会自动消失。</div>
            </div>
            <input type="number" id="inp-autodismiss" class="input num" min="0" max="60000" step="500" value="${Number(s.autoDismissMs || 0)}" />
          </div>
  
  
          <div class="row stack">
            <div class="meta">
              <div class="label">诊断日志路径（可选）</div>
              <div class="hint">排查触发情况时填写，例如 /tmp/answer-card.log；留空关闭。</div>
            </div>
            <input type="text" id="inp-trace" class="input" placeholder="留空不写日志" value="${esc(s.traceFile || '')}" />
          </div>
        </section>
      </div>
    `
  
    bindEvents()
  }
  
  function bindEvents() {
    root.querySelectorAll('.tab[data-host]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextHost = btn.getAttribute('data-host')
        if (nextHost && nextHost !== state?.host) refreshState(nextHost)
      })
    })
  
    $id('btn-test')?.addEventListener('click', () => sendTest('app_test_card', '测试卡片'))
    $id('btn-test-return')?.addEventListener('click', () => sendTest('app_test_return', '返回测试卡'))
  
    root.querySelectorAll('button.toggle[data-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const scope = btn.getAttribute('data-scope') || 'host'
        const key = btn.getAttribute('data-key')
        const nextVal = btn.getAttribute('aria-pressed') !== 'true'
        savePatch(scope, { [key]: nextVal }, true)
      })
    })
  
    $id('sel-policy')?.addEventListener('change', (e) => {
      savePatch('host', { approvalPolicy: e.target.value }, true)
    })
  
    $id('inp-return-cmd')?.addEventListener('input', (e) => {
      savePatch('host', { returnCommand: e.target.value }, false)
    })
  
    $id('btn-clear-return')?.addEventListener('click', () => {
      savePatch('host', { returnCommand: '' }, true)
      resetHostKeys(['returnCommand'])
    })
  
    $id('inp-cooldown')?.addEventListener('input', (e) => {
      savePatch('host', { completeCooldownMs: Number(e.target.value) || 0 }, false)
    })
  
    $id('btn-add-ws-pick')?.addEventListener('click', () => {
      const val = $id('pick-ws')?.value
      if (val) toggleListEntry('mutedWorkspaces', val)
    })
  
    $id('btn-add-ws-manual')?.addEventListener('click', () => {
      const inp = $id('inp-ws-manual')
      if (inp?.value?.trim()) {
        toggleListEntry('mutedWorkspaces', inp.value.trim())
        inp.value = ''
      }
    })
  
    $id('btn-add-sess-pick')?.addEventListener('click', () => {
      const val = $id('pick-sess')?.value
      if (val) toggleListEntry('mutedSessions', val)
    })
  
    $id('btn-add-sess-manual')?.addEventListener('click', () => {
      const inp = $id('inp-sess-manual')
      if (inp?.value?.trim()) {
        toggleListEntry('mutedSessions', inp.value.trim())
        inp.value = ''
      }
    })
  
    root.querySelectorAll('button.chip-x[data-unmute-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        toggleListEntry(btn.getAttribute('data-unmute-key'), btn.getAttribute('data-unmute-val'))
      })
    })
  
    $id('sel-pos')?.addEventListener('change', (e) => {
      savePatch('shared', { position: e.target.value }, true)
    })
  
    $id('rng-width')?.addEventListener('input', (e) => {
      const width = Number(e.target.value)
      const label = $id('val-width')
      if (label) label.textContent = `${width} pt`
      savePatch('shared', { width }, false)
    })
  
    $id('rng-scale')?.addEventListener('input', (e) => {
      const pct = Number(e.target.value)
      const label = $id('val-scale')
      if (label) label.textContent = `${pct}%`
      savePatch('shared', { fontScale: pct / 100 }, false)
    })
  
    $id('sel-theme-mode')?.addEventListener('change', (e) => {
      savePatch('host', { themeMode: e.target.value }, true)
    })
  
    $id('inp-accent')?.addEventListener('input', (e) => {
      savePatch('host', { accent: e.target.value }, false)
    })
  
    $id('btn-reset-accent')?.addEventListener('click', () => {
      savePatch('host', { accent: '' }, true)
      resetHostKeys(['accent'])
    })
  
    $id('btn-sync-theme')?.addEventListener('click', () => {
      lastSyncedThemeKey = ''
      syncLiveHostTheme(transport.getHostContext?.(), true)
    })
  
    $id('inp-autodismiss')?.addEventListener('input', (e) => {
      savePatch('shared', { autoDismissMs: Number(e.target.value) || 0 }, false)
    })
  
    $id('inp-trace')?.addEventListener('input', (e) => {
      savePatch('shared', { traceFile: e.target.value }, false)
    })
  }
  
  function syncDynamicAccent() {
    const accent = state?.resolvedTheme?.accent
    if (accent) {
      hostEl.style.setProperty('--ac-accent', accent)
    }
  }
  
  /**
   * 借助 1×1 离屏 Canvas 把任意 CSS Color 4 颜色（含 oklch / lab / color(srgb) / color-mix / hsl / rgba）
   * 转为精确 8-bit `rgba(r, g, b, a)`；若提供 backdropCss 则由浏览器直接完成像素级 alpha 混合。
   */
  function resolveComputedColor(cssExpr, backdropCss = '') {
    if (!cssExpr || typeof cssExpr !== 'string') return ''
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const g = canvas.getContext('2d')
      if (!g) return ''
      g.clearRect(0, 0, 1, 1)
      if (backdropCss) {
        g.fillStyle = backdropCss
        g.fillRect(0, 0, 1, 1)
      }
      g.fillStyle = cssExpr
      g.fillRect(0, 0, 1, 1)
      const [r, gCh, b, a] = g.getImageData(0, 0, 1, 1).data
      if (a === 0) return ''
      const alpha = Math.round((a / 255) * 1000) / 1000
      return alpha >= 0.996 ? `rgb(${r}, ${gCh}, ${b})` : `rgba(${r}, ${gCh}, ${b}, ${alpha})`
    } catch {
      return ''
    }
  }
  
  let lastSyncedThemeKey = ''
  function syncLiveHostTheme(ctx, force = false) {
    if (!transport.supportsThemeSync) {
      if (force) setStatus('主题由宿主适配器自动同步')
      return
    }
    const vars = ctx?.styles?.variables && typeof ctx.styles.variables === 'object' ? ctx.styles.variables : {}
    const rootStyle = getComputedStyle(document.documentElement)
    const bodyStyle = getComputedStyle(document.body)
    const readRaw = (k) => vars[k] || rootStyle.getPropertyValue(k).trim()
  
    const rawBg = readRaw('--color-background-primary') || bodyStyle.backgroundColor
    const computedBg = resolveComputedColor(rawBg) || ''
  
    const resolvedVars = {}
    if (computedBg) resolvedVars['--color-background-primary'] = computedBg
  
    const keys = [
      '--color-background-secondary',
      '--color-background-tertiary',
      '--color-border-primary',
      '--color-border-secondary',
      '--color-text-primary',
      '--color-text-secondary',
      '--color-text-tertiary',
      '--color-ring-primary',
      '--color-text-info',
      '--color-background-info',
      '--color-text-success',
      '--color-background-success',
    ]
    for (const k of keys) {
      const raw = readRaw(k)
      if (!raw) continue
      // 所有前景色/半透明叠层直接以主背景色为底做像素级合成，彻底消除半透明黑截断问题。
      const computed = resolveComputedColor(raw, computedBg)
      if (computed) resolvedVars[k] = computed
    }
    if (!resolvedVars['--color-text-primary'] && bodyStyle.color) {
      const textCol = resolveComputedColor(bodyStyle.color, computedBg)
      if (textCol) resolvedVars['--color-text-primary'] = textCol
    }
  
    const detectedTheme = ctx?.theme
      || document.documentElement.dataset.theme
      || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  
    if (!detectedTheme && Object.keys(resolvedVars).length === 0) return
    const payload = {
      host: 'antigravity',
      theme: detectedTheme,
      variables: resolvedVars,
    }
    const key = JSON.stringify(payload)
    if (!force && key === lastSyncedThemeKey) return
    lastSyncedThemeKey = key
    if (force) setStatus('正在同步当前宿主主题…')
    callTool('app_sync_host_theme', payload)
      .then((next) => {
        if (next?.ok && (!state || state.host === 'antigravity')) {
          state = next
          syncDynamicAccent()
          if (force) setStatus(`已同步主题（背景 ${next.resolvedTheme?.background || ''} · 强调 ${next.resolvedTheme?.accent || ''}）`)
          render()
        }
      })
      .catch((err) => {
        if (force) setStatus(`同步主题失败：${err.message}`)
      })
  }
  
  function maybeAutoSyncTheme(ctx) {
    if (!transport.supportsThemeSync) return
    const isDefaultPalette = !state?.resolvedTheme?.source
      || state.resolvedTheme.source === 'system'
      || state.resolvedTheme.source === 'antigravity:config'
    const priorFailed = state?.themeSync?.failed === true
  
    // 1) 仍为默认配色且之前未失败 -> 自动同步一次；
    // 2) 若检测到宿主当前实时色值与已保存快照不一致（关着面板期间切过主题）-> 自动更新快照。
    const liveBg = resolveComputedColor(
      ctx?.styles?.variables?.['--color-background-primary']
        || getComputedStyle(document.documentElement).getPropertyValue('--color-background-primary').trim()
        || getComputedStyle(document.body).backgroundColor,
    )
    const savedBg = state?.resolvedTheme?.background
    const drifted = Boolean(liveBg && savedBg && resolveComputedColor(savedBg) !== liveBg)
  
    if ((isDefaultPalette && !priorFailed) || drifted) {
      syncLiveHostTheme(ctx, false)
    }
  }
  
  function applyThemeContext(ctx) {
    if (!ctx) return
    if (ctx.theme) {
      hostEl.setAttribute('data-theme', ctx.theme)
    }
    if (ctx.styles?.variables) for (const [k, v] of Object.entries(ctx.styles.variables)) {
        if (typeof v === 'string' && v) hostEl.style.setProperty(k, v)
      }
  }
  
  function applyResolvedTheme(theme) {
    if (!theme) return
    const map = {
      '--color-background-primary': theme.background,
      '--color-background-secondary': theme.surface,
      '--color-background-tertiary': theme.surface,
      '--color-border-primary': theme.border,
      '--color-border-secondary': theme.border,
      '--color-text-primary': theme.textPrimary,
      '--color-text-secondary': theme.textSecondary,
      '--color-text-tertiary': theme.textSecondary,
      '--color-ring-primary': theme.accent,
      '--color-text-info': theme.accent,
      '--color-background-info': theme.accent,
      '--color-text-success': theme.completeAccent,
      '--color-background-success': theme.completeAccent,
    }
    for (const [k, v] of Object.entries(map)) {
      if (typeof v === 'string' && v) hostEl.style.setProperty(k, v)
    }
    if (theme.accent) hostEl.style.setProperty('--ac-accent', theme.accent)
    if (theme.mode === 'light' || theme.mode === 'dark') hostEl.setAttribute('data-theme', theme.mode)
  }

  function applyState(payload) {
    if (!payload || payload.ok !== true || !payload.effective) return false
    bootError = ''
    state = payload
    syncDynamicAccent()
    applyResolvedTheme(payload.resolvedTheme)
    render()
    maybeAutoSyncTheme(transport.getHostContext?.())
    return true
  }

  function applyHostContext(ctx) {
    if (!ctx) return
    if (ctx.theme) hostEl.setAttribute('data-theme', ctx.theme)
    if (ctx.styles && ctx.styles.variables && typeof ctx.styles.variables === 'object') {
      for (const [k, v] of Object.entries(ctx.styles.variables)) {
        if (typeof v === 'string' && v) hostEl.style.setProperty(k, v)
      }
    }
    syncLiveHostTheme(ctx, false)
  }

  function start() {
    render()
    return refreshState(initialHost)
  }

  function destroy() {
    for (const timer of debounceTimers.values()) clearTimeout(timer)
    debounceTimers.clear()
    if (state?.host) {
      try { const el = $id('inp-accent'); if (el) el.value = el.value } catch {}
    }
  }

  return { start, refreshState, applyState, applyHostContext, syncLiveHostTheme, applyResolvedTheme, destroy, getState: () => state }
}

export class AnswerCardSettingsElement extends HTMLElement {
  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this._view = null
    this._transport = null
    this._host = 'antigravity'
    this._connected = false
  }

  set transport(value) {
    this._transport = value
    this._boot()
  }

  get transport() { return this._transport }

  set host(value) {
    this._host = value || 'antigravity'
    if (this._view) this._view.refreshState(this._host)
  }

  get host() { return this._host }

  connectedCallback() {
    this._connected = true
    this._boot()
  }

  disconnectedCallback() {
    this._connected = false
  }

  _boot() {
    if (!this._connected || !this._transport || this._view) return
    const style = document.createElement('style')
    style.textContent = SETTINGS_CSS
    const root = document.createElement('div')
    root.className = 'answer-card-settings-root'
    this.shadowRoot.append(style, root)
    this._view = createSettingsView({
      root,
      hostEl: this,
      transport: this._transport,
      initialHost: this._host,
    })
    this._view.start().catch((err) => this._view && this._view.applyState({ ok: false, error: String(err) }))
  }

  applyState(payload) { if (this._view) this._view.applyState(payload) }
  applyHostContext(ctx) { if (this._view) this._view.applyHostContext(ctx) }
  refresh(host) { if (this._view) this._view.refreshState(host || this._host) }
  syncTheme(ctx, force) { if (this._view) this._view.syncLiveHostTheme(ctx, force) }
  destroy() { if (this._view) this._view.destroy(); this._view = null; this.shadowRoot.innerHTML = '' }
}

export function defineAnswerCardSettings() {
  if (!customElements.get('answer-card-settings')) {
    customElements.define('answer-card-settings', AnswerCardSettingsElement)
  }
}
