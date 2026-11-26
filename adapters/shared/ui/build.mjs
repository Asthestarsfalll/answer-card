#!/usr/bin/env node
/**
 * 把跨宿主共享设置组件打包成单文件 IIFE。
 * DSH 通过 /dsh-answer-card/ui.js 加载它；
 * Antigravity 的 MCP App 由 adapters/antigravity/ui/build.mjs 直接 bundle 同一份源码。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, 'settings-element.mjs')
const OUTPUT = join(HERE, 'answer-card-settings.js')

await esbuild.build({
  entryPoints: [ENTRY],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'AnswerCardSettings',
  target: ['es2020'],
  outfile: OUTPUT,
  footer: { js: 'AnswerCardSettings.defineAnswerCardSettings();' },
})

console.log(`Built ${OUTPUT}`)
