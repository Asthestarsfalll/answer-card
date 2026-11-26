// dsh-answer-card · 客户端半边
// 在「设置」里加一个「回答卡片」分区：弹出时机、位置、宽度、字号、主色、自动关闭、提示音。
//
// 宿主侧接口（见 lib/index.mjs）：
//   GET  /dsh-answer-card/settings  -> { ok, settings, defaults, positions, file }
//   POST /dsh-answer-card/settings  -> { ok, settings }        （部分字段即可）
//   POST /dsh-answer-card/test      -> { ok }                  （弹一张自检卡）

window.__ModuleLoader__.load({
  id: 'answer-card',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const inject = ['slots']
    const BASE = '/dsh-answer-card'

    const getJson = (path) =>
      fetch(BASE + path, { cache: 'no-store' }).then((r) => r.json())
    const postJson = (path, body) =>
      fetch(BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then((r) => r.json())

    function appCall(name, args) {
      return postJson('/app', { name, args }).then((data) => {
        if (!data || data.ok === false) throw new Error((data && data.error) || '设置接口失败')
        return data
      })
    }

    /**
     * 设置页只做挂载：界面本体是 adapters/shared/ui 的 <answer-card-settings>，
     * 与 Antigravity MCP App 共用同一份；这里只提供 HTTP transport。
     */
    function Section() {
      const hostRef = React.useRef(null)
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        let alive = true
        if (!window.customElements || !customElements.get('answer-card-settings')) {
          setError('共享设置组件未加载')
          return undefined
        }
        if (hostRef.current) {
          const el = document.createElement('answer-card-settings')
          el.host = 'dsh'
          el.transport = {
            call: appCall,
            supportsThemeSync: false,
            getHostContext: () => null,
          }
          hostRef.current.appendChild(el)
        }
        return () => {
          alive = false
          if (hostRef.current) hostRef.current.innerHTML = ''
        }
      }, [])

      return React.createElement(
        'div',
        { ref: hostRef, style: { minHeight: 200 } },
        error
          ? React.createElement('div', { style: { padding: 16, color: '#f87171', fontSize: 12 } },
            '设置组件加载失败：' + error)
          : null,
      )
    }
    /**
     * 跳到某个会话。uiWorkspace 是客户端内部服务（`openSession` 也在它上面），
     * 拿不到就放弃——宿主那边已经把窗口拉回前台了，用户自己点一下即可。
     */
    function jumpTo(ctx, sessionId) {
      try {
        const space = ctx.get('uiWorkspace')
        if (space && typeof space.openSession === 'function') {
          space.openSession(sessionId)
          return true
        }
      } catch (error) {
        // 内部 API 变了就静默降级，不能让设置页跟着崩。
      }
      return false
    }

    /**
     * 把文字光标放回输入框：先找 textarea，再找 contenteditable。
     * DSH 换过几版输入控件，所以两种都试；找不到就算了，绝不抛。
     */
    function focusComposer(tries = 8) {
      try {
        const el = document.querySelector('textarea, [contenteditable="true"]')
        if (el instanceof HTMLElement) {
          el.focus()
          return true
        }
      } catch (error) {
        // 选择器失效不该影响跳转。
      }
      if (tries > 0) setTimeout(() => focusComposer(tries - 1), 150)
      return false
    }

    /**
     * 轮询宿主的「回到 DSH」目标：窗口一被激活就取一次，跳到对应会话再 ack。
     * 只在页面可见时轮询，后台标签页不打扰。
     */
    function watchFocus(ctx) {
      let busy = false
      const tick = async () => {
        if (busy || document.visibilityState !== 'visible') return
        busy = true
        try {
          const data = await getJson('/focus')
          const target = data && data.target
          if (target && typeof target.sessionId === 'string' && target.sessionId.length > 0) {
            jumpTo(ctx, target.sessionId)
            await postJson('/focus/ack', {})
            // 切完会话再放光标：会话切换本身会重渲染输入框，太早聚焦会被冲掉。
            setTimeout(() => focusComposer(), 250)
          }
        } catch (error) {
          // 宿主没挂接口（无 webServer）或断线：下一轮再说。
        } finally {
          busy = false
        }
      }
      setInterval(tick, 2000)
      window.addEventListener('visibilitychange', tick)
      window.addEventListener('focus', tick)
      tick()
    }

    let lastThemeKey = ''
    let themeTimer = 0

    function syncTheme() {
      try {
        const rootStyle = getComputedStyle(document.documentElement)
        const bodyStyle = document.body ? getComputedStyle(document.body) : rootStyle
        const readVar = (name) =>
          bodyStyle.getPropertyValue(name).trim() || rootStyle.getPropertyValue(name).trim()
        const bgBase = readVar('--dsw-alias-bg-base')
        const bgL1 = readVar('--dsw-alias-bg-l1') || readVar('--dsw-alias-bg-layer-1')
        const bgL2 = readVar('--dsw-alias-bg-l2') || readVar('--dsw-alias-bg-layer-2')
        const labelPrimary = readVar('--dsw-alias-label-primary')
        const labelSecondary = readVar('--dsw-alias-label-secondary')
        const labelTertiary = readVar('--dsw-alias-label-tertiary')
        const accent = readVar('--dsw-alias-brand-primary')
        const completeAccent = readVar('--dsw-alias-state-success-primary')
        const border = readVar('--dsw-alias-border-primary')
        // DSH 深色主题的标记：body[data-ds-dark-theme]，没有该属性即浅色。
        const dark = document.body?.hasAttribute('data-ds-dark-theme') === true
        const payload = {
          mode: dark ? 'dark' : 'light',
          background: bgBase,
          surface: bgL1 || bgL2,
          border,
          textPrimary: labelPrimary || bodyStyle.color,
          textSecondary: labelTertiary || labelSecondary,
          accent,
          completeAccent,
          variables: {
            '--dsw-alias-bg-base': bgBase,
            '--dsw-alias-bg-l1': bgL1,
            '--dsw-alias-bg-layer-1': bgL1,
            '--dsw-alias-bg-l2': bgL2,
            '--dsw-alias-bg-layer-2': bgL2,
            '--dsw-alias-bg-primary': bgBase,
            '--dsw-alias-bg-secondary': bgL1,
            '--dsw-alias-border-primary': border,
            '--dsw-alias-label-primary': labelPrimary,
            '--dsw-alias-label-secondary': labelSecondary,
            '--dsw-alias-label-tertiary': labelTertiary,
            '--dsw-alias-brand-primary': accent,
            '--dsw-alias-state-success-primary': completeAccent,
          },
        }
        const key = JSON.stringify(payload)
        if (key === lastThemeKey) return
        postJson('/theme', payload)
          .then((res) => {
            if (res?.ok) lastThemeKey = key
          })
          .catch(() => undefined)
      } catch {
        // 同步主题失败不影响 DSH 界面。
      }
    }

    function scheduleThemeSync() {
      clearTimeout(themeTimer)
      themeTimer = setTimeout(syncTheme, 120)
    }

    function apply(ctx) {
      watchFocus(ctx)
      scheduleThemeSync()
      try {
        const obs = new MutationObserver(scheduleThemeSync)
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
        if (document.body) {
          obs.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'style', 'data-ds-dark-theme'],
          })
        }
        if (document.head) {
          obs.observe(document.head, { childList: true, subtree: true, characterData: true })
        }
        if (window.matchMedia) {
          window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', scheduleThemeSync)
        }
      } catch {
        // 忽略不支持观察器的环境。
      }
      // 主题插件可能通过更换 <style> 内容而非属性触发变化，低频兜底轮询一次。
      setInterval(scheduleThemeSync, 15000)
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          {
            name: 'settings.section',
            id: 'answer-card',
            order: 46,
            label: () => '回答卡片',
          },
          () => React.createElement(Section),
        ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
