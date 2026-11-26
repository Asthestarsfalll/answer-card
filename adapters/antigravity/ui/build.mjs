#!/usr/bin/env node
/**
 * 将 adapters/antigravity/ui/src/settings.mjs 与 @modelcontextprotocol/ext-apps
 * 打包为单文件自包含 HTML（adapters/antigravity/ui/settings.html），
 * 满足 Antigravity MCP App 的严格 CSP 且让终端用户零 npm install 即可使用。
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, 'src', 'settings.mjs')
const OUTPUT = join(HERE, 'settings.html')

const built = await esbuild.build({
  entryPoints: [ENTRY],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  write: false,
})

const js = built.outputFiles[0].text.replace(/<\/script>/gi, '<\\/script>')

const css = `
:root {
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
  :root:not([data-theme="light"]) {
    --ac-accent: var(--color-ring-primary, var(--color-text-info, #4285F4));
    --ac-bg: var(--color-background-primary, #131314);
    --ac-card: var(--color-background-secondary, #1e1f20);
    --ac-text: var(--color-text-primary, #e3e3e3);
    --ac-text-2: var(--color-text-secondary, #bdc1c6);
    --ac-text-3: var(--color-text-tertiary, #9aa0a6);
  }
}
:root[data-theme="dark"] {
  --ac-accent: var(--color-ring-primary, var(--color-text-info, #4285F4));
  --ac-bg: var(--color-background-primary, #131314);
  --ac-card: var(--color-background-secondary, #1e1f20);
  --ac-text: var(--color-text-primary, #e3e3e3);
  --ac-text-2: var(--color-text-secondary, #bdc1c6);
  --ac-text-3: var(--color-text-tertiary, #9aa0a6);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0;
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
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
`.trim()

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Answer Card Settings</title>
<style>${css}</style>
</head>
<body>
<div id="root"><div class="loading">正在初始化 Answer Card 设置…</div></div>
<script>${js}</script>
</body>
</html>
`

writeFileSync(OUTPUT, html, 'utf8')
console.log(`Built ${OUTPUT} (${Buffer.byteLength(html, 'utf8')} bytes)`)
