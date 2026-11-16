// dsh-answer-card · 客户端半边
// 在「设置」里加一个「回答卡片」分区：弹出时机、位置、宽度、字号、主色、自动关闭、提示音。
//
// 宿主侧接口（见 lib/index.mjs）：
//   GET  /dsh-answer-card/settings  -> { ok, settings, defaults, positions, file }
//   POST /dsh-answer-card/settings  -> { ok, settings }        （部分字段即可）
//   POST /dsh-answer-card/test      -> { ok }                  （弹一张自检卡）

window.__ModuleLoader__.load({
  id: 'dsh-answer-card',
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

    const S = {
      wrap: { padding: '16px 6px', fontSize: 13, lineHeight: 1.7, maxWidth: 760 },
      h: { fontSize: 14, fontWeight: 600, margin: '22px 0 10px' },
      dim: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
      row: { display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0', flexWrap: 'wrap' },
      label: { minWidth: 108, color: 'inherit' },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', marginTop: -2, marginBottom: 6 },
      switchOn: {
        width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer',
        background: 'var(--dsw-alias-brand-primary, #4D6BFE)', position: 'relative', flex: 'none',
      },
      switchOff: {
        width: 40, height: 22, borderRadius: 11, cursor: 'pointer',
        border: '1px solid rgba(128,128,128,.4)', background: 'transparent', position: 'relative', flex: 'none',
      },
      knobOn: { position: 'absolute', top: 2, left: 20, width: 18, height: 18, borderRadius: 9, background: '#fff' },
      knobOff: { position: 'absolute', top: 2, left: 2, width: 16, height: 16, borderRadius: 8, background: 'rgba(128,128,128,.7)' },
      select: {
        padding: '4px 8px', borderRadius: 6, fontSize: 12.5, color: 'inherit', background: 'transparent',
        border: '1px solid rgba(128,128,128,.35)',
      },
      range: { width: 180, accentColor: 'var(--dsw-alias-brand-primary, #4D6BFE)' },
      num: {
        width: 92, padding: '3px 8px', borderRadius: 6, fontSize: 12.5, color: 'inherit', background: 'transparent',
        border: '1px solid rgba(128,128,128,.35)',
      },
      color: { width: 34, height: 24, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' },
      btn: {
        padding: '5px 12px', borderRadius: 7, fontSize: 12.5, color: 'inherit', cursor: 'pointer',
        border: '1px solid rgba(128,128,128,.4)', background: 'transparent',
      },
      status: { marginTop: 10, minHeight: 18, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
    }

    function Toggle({ value, onChange }) {
      return React.createElement(
        'button',
        {
          type: 'button',
          style: value ? S.switchOn : S.switchOff,
          onClick: () => onChange(!value),
          'aria-pressed': value ? 'true' : 'false',
        },
        React.createElement('span', { style: value ? S.knobOn : S.knobOff }),
      )
    }

    function Row({ label, hint, children }) {
      return React.createElement(
        'div',
        null,
        React.createElement(
          'div',
          { style: S.row },
          React.createElement('span', { style: S.label }, label),
          children,
        ),
        hint ? React.createElement('div', { style: S.hint }, hint) : null,
      )
    }

    function Section() {
      const [settings, setSettings] = React.useState(null)
      const [error, setError] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const timer = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        getJson('/settings')
          .then((data) => {
            if (!alive) return
            if (data && data.ok) setSettings(data.settings)
            else setError((data && data.error) || '读取设置失败')
          })
          .catch((e) => alive && setError(String(e)))
        return () => {
          alive = false
          if (timer.current) clearTimeout(timer.current)
        }
      }, [])

      const save = React.useCallback((patch) => {
        setSettings((prev) => ({ ...(prev || {}), ...patch }))
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          postJson('/settings', patch)
            .then((data) => {
              if (data && data.ok) {
                setSettings(data.settings)
                setStatus('已保存')
              } else {
                setStatus('保存失败：' + ((data && data.error) || '未知错误'))
              }
            })
            .catch((e) => setStatus('保存失败：' + String(e)))
        }, 250)
      }, [])

      const test = () => {
        setBusy(true)
        postJson('/test')
          .then((data) => setStatus(data && data.ok ? '已发送测试卡片' : '发送失败：' + ((data && data.error) || '未知错误')))
          .catch((e) => setStatus('发送失败：' + String(e)))
          .finally(() => setBusy(false))
      }

      if (error) {
        return React.createElement('div', { style: S.wrap },
          React.createElement('div', { style: S.dim }, '回答卡片设置不可用：' + error))
      }
      if (!settings) {
        return React.createElement('div', { style: S.wrap }, React.createElement('div', { style: S.dim }, '读取中…'))
      }

      const positions = Object.keys(POSITION_LABELS)

      return React.createElement(
        'div',
        { style: S.wrap },
        React.createElement('div', null, '在 DSH 需要你批准或回答时，于屏幕弹出置顶卡片。'),

        React.createElement('div', { style: S.h }, '弹出时机'),
        React.createElement(Row, { label: '审批请求', hint: '工具要权限时弹卡，点了就等同你批准或拒绝。' },
          React.createElement(Toggle, {
            value: settings.confirmApprovals !== false,
            onChange: (v) => save({ confirmApprovals: v }),
          })),
        React.createElement(Row, { label: '模型提问', hint: 'ask_user_question、计划待审时弹卡，可直接选答案。' },
          React.createElement(Toggle, {
            value: settings.answerQuestions !== false,
            onChange: (v) => save({ answerQuestions: v }),
          })),
        React.createElement(Row, { label: '任务完成', hint: '一轮跑完时弹一张小卡，可一键回到 DSH。' },
          React.createElement(Toggle, {
            value: settings.notifyOnComplete !== false,
            onChange: (v) => save({ notifyOnComplete: v }),
          })),
        React.createElement(Row, { label: '只在后台时弹', hint: 'DSH 在前台时不弹，避免和界面里已有的卡片重复。' },
          React.createElement(Toggle, {
            value: settings.skipWhenDSHFocused !== false,
            onChange: (v) => save({ skipWhenDSHFocused: v }),
          })),

        React.createElement('div', { style: S.h }, '外观'),
        React.createElement(Row, { label: '出现位置' },
          React.createElement('select', {
            value: settings.position || 'center',
            style: S.select,
            onChange: (e) => save({ position: e.target.value }),
          }, positions.map((p) => React.createElement('option', { key: p, value: p }, POSITION_LABELS[p])))),
        React.createElement(Row, { label: '宽度 ' + settings.width + ' pt' },
          React.createElement('input', {
            type: 'range', min: 320, max: 720, step: 4,
            value: settings.width, style: S.range,
            onChange: (e) => save({ width: Number(e.target.value) }),
          })),
        React.createElement(Row, { label: '字号 ' + Math.round((settings.fontScale || 1) * 100) + '%' },
          React.createElement('input', {
            type: 'range', min: 70, max: 180, step: 5,
            value: Math.round((settings.fontScale || 1) * 100), style: S.range,
            onChange: (e) => save({ fontScale: Number(e.target.value) / 100 }),
          })),
        React.createElement(Row, { label: '主色' },
          React.createElement('input', {
            type: 'color', value: settings.accent || '#4D6BFE', style: S.color,
            onChange: (e) => save({ accent: e.target.value }),
          })),

        React.createElement('div', { style: S.h }, '行为'),
        React.createElement(Row, { label: '自动关闭', hint: '毫秒；0 表示一直等你点。' },
          React.createElement('input', {
            type: 'number', min: 0, max: 60000, step: 500,
            value: settings.autoDismissMs || 0, style: S.num,
            onChange: (e) => save({ autoDismissMs: Number(e.target.value) || 0 }),
          })),
        React.createElement(Row, { label: '提示音' },
          React.createElement(Toggle, {
            value: settings.sound === true,
            onChange: (v) => save({ sound: v }),
          })),
        React.createElement(Row, { label: '回到 DSH 时移动鼠标指针', hint: '跨屏 / 跨桌面后把指针挪到输入框附近。' },
          React.createElement(Toggle, {
            value: settings.warpPointer !== false,
            onChange: (v) => save({ warpPointer: v }),
          })),
        React.createElement(Row, { label: '完成提醒间隔', hint: '同一会话两次「完成」提醒之间的最小毫秒数。' },
          React.createElement('input', {
            type: 'number', min: 0, max: 600000, step: 1000,
            value: settings.completeCooldownMs || 0, style: S.num,
            onChange: (e) => save({ completeCooldownMs: Number(e.target.value) || 0 }),
          })),

        React.createElement(Row, { label: '' },
          React.createElement('button', {
            type: 'button', style: S.btn, disabled: busy, onClick: test,
          }, busy ? '发送中…' : '发送测试卡片')),

        React.createElement('div', { style: S.status }, status),
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

    function apply(ctx) {
      watchFocus(ctx)
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
