/**
 * answer-card · 本地共享设置面板 HTTP 服务（零外部依赖）。
 *
 * 复用 `adapters/shared/ui/answer-card-settings.js` 与 `adapters/antigravity/mcp-app.mjs` 的 `handleToolCall`，
 * 让不支持内嵌 WebView 的宿主（如 Zed / CLI）也能打开与 Antigravity / DSH 完全一致的可视化设置页。
 *
 * 安全边界：
 *   - 仅绑定 `127.0.0.1`
 *   - `POST /app` 校验本地 Origin + 随机 CSRF Token（注入在同源首页中）
 *
 * @module answer-card/core/settings-server
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { handleToolCall as handleAppToolCall } from '../adapters/antigravity/mcp-app.mjs'
import { defaultRecentPath, defaultSettingsPath, getHostProfile, resolveSettings } from './settings.mjs'
import { resolveHostTheme } from './theme.mjs'

const UI_BUNDLE_PATH = fileURLToPath(new URL('../adapters/shared/ui/answer-card-settings.js', import.meta.url))
const MAX_BODY_BYTES = 65536

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function isLocalOrigin(origin) {
  if (!origin) return true
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(origin)
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function renderIndexHtml({ host, token, settingsFile, stateDir, zedConfigDir, zedExtensionsDir }) {
  const profile = getHostProfile(host)
  const effective = resolveSettings({}, settingsFile, profile.id)
  const theme = resolveHostTheme({
    host: profile.id,
    settings: effective,
    stateDir,
    zedConfigDir,
    zedExtensionsDir,
  })
  const safeHost = JSON.stringify(profile.id)
  const safeToken = JSON.stringify(token)
  const safeMode = theme.mode === 'light' ? 'light' : 'dark'
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Answer Card · ${profile.displayName} 设置</title>
  <style>
    :root {
      color-scheme: ${safeMode};
      --color-background-primary: ${theme.background};
      --color-background-secondary: ${theme.surface};
      --color-border-primary: ${theme.border};
      --color-text-primary: ${theme.textPrimary};
      --color-text-secondary: ${theme.textSecondary};
      --color-text-tertiary: ${theme.textSecondary};
      --color-ring-primary: ${theme.accent};
      --color-text-info: ${theme.accent};
    }
    html, body {
      margin: 0;
      padding: 0;
      min-height: 100%;
      background: var(--color-background-primary);
      color: var(--color-text-primary);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
  </style>
</head>
<body>
  <div id="mount"></div>
  <script src="/ui.js"></script>
  <script>
    (() => {
      const mount = document.getElementById('mount');
      if (!window.customElements || !customElements.get('answer-card-settings')) {
        mount.innerHTML = '<p style="padding:24px;color:#ef4444">共享设置组件加载失败（/ui.js）。</p>';
        return;
      }
      const el = document.createElement('answer-card-settings');
      el.host = ${safeHost};
      el.setAttribute('data-theme', ${JSON.stringify(safeMode)});
      el.transport = {
        supportsThemeSync: false,
        getHostContext: () => null,
        call: async (name, args) => {
          const res = await fetch('/app', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-answer-card-token': ${safeToken},
            },
            body: JSON.stringify({ name, args: args || {} }),
          });
          const data = await res.json();
          if (!res.ok || data.ok === false) {
            throw new Error(data.error || ('HTTP ' + res.status));
          }
          return data;
        },
      };
      mount.appendChild(el);
    })();
  </script>
</body>
</html>
`
}

/**
 * 构造 HTTP 请求处理函数（便于无端口单测与复用于 HTTP Server）。
 * @param {{ host?: string, token?: string, settingsFile?: string, recentFile?: string, stateDir?: string, zedConfigDir?: string, zedExtensionsDir?: string, uiBundlePath?: string }} [options]
 */
export function createSettingsRequestHandler(options = {}) {
  const host = getHostProfile(options.host || 'zed').id
  const token = options.token || randomBytes(16).toString('hex')
  const settingsFile = options.settingsFile || defaultSettingsPath()
  const recentFile = options.recentFile || defaultRecentPath(host)
  const uiBundlePath = options.uiBundlePath || UI_BUNDLE_PATH

  const handler = async (req, res) => {
    const rawUrl = String(req.url || '/')
    const pathname = rawUrl.split('?')[0]
    if (!isLocalOrigin(String(req.headers?.origin ?? ''))) {
      return sendJson(res, 403, { ok: false, error: 'forbidden_origin' })
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = renderIndexHtml({
        host,
        token,
        settingsFile,
        stateDir: options.stateDir,
        zedConfigDir: options.zedConfigDir,
        zedExtensionsDir: options.zedExtensionsDir,
      })
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(html)
      return
    }

    if (req.method === 'GET' && pathname === '/ui.js') {
      try {
        const code = readFileSync(uiBundlePath, 'utf8')
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(code)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) })
      }
      return
    }

    if (req.method === 'POST' && pathname === '/app') {
      const supplied = String(req.headers?.['x-answer-card-token'] ?? '')
      if (supplied !== token) {
        return sendJson(res, 403, { ok: false, error: 'invalid_token' })
      }
      const body = await readJsonBody(req)
      if (!body || typeof body.name !== 'string') {
        return sendJson(res, 400, { ok: false, error: 'bad_request' })
      }
      try {
        const result = await handleAppToolCall(body.name, body.args ?? {}, {
          settingsFile,
          recentFile,
          stateDir: options.stateDir,
        })
        const payload = result?.structuredContent ?? { ok: false, error: 'empty_result' }
        return sendJson(res, result?.isError ? 500 : 200, payload)
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error) })
      }
    }

    sendJson(res, 404, { ok: false, error: 'not_found' })
  }

  return { handler, token, host }
}

/**
 * 启动仅监听 `127.0.0.1` 的本地设置页服务。
 * @param {{ host?: string, port?: number, settingsFile?: string, recentFile?: string, stateDir?: string }} [options]
 * @returns {Promise<{ url: string, port: number, token: string, host: string, server: import('node:http').Server, close: () => Promise<void> }>}
 */
export function startSettingsServer(options = {}) {
  const { handler, token, host } = createSettingsRequestHandler(options)
  const port = Number.isInteger(options.port) && options.port >= 0 ? options.port : 0
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handler(req, res).catch((err) => {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(err) })
      })
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const boundPort = typeof addr === 'object' && addr ? addr.port : port
      const url = `http://127.0.0.1:${boundPort}/`
      resolve({
        url,
        port: boundPort,
        token,
        host,
        server,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

/**
 * 用系统默认浏览器打开本地设置页。
 * @param {string} url
 */
export function openExternalUrl(url) {
  const cmd = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'cmd' : 'xdg-open')
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}
