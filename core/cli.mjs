#!/usr/bin/env node
/**
 * answer-card · 跨宿主设置与自检 CLI。
 *
 * 用法：
 *   node core/cli.mjs status [--host antigravity|dsh|zed]
 *   node core/cli.mjs get [key] [--host ...]
 *   node core/cli.mjs set <key> <value> [--host ...] [--global]
 *   node core/cli.mjs mute-workspace <path> [--host ...]
 *   node core/cli.mjs unmute-workspace <path> [--host ...]
 *   node core/cli.mjs mute-session <id> [--host ...]
 *   node core/cli.mjs unmute-session <id> [--host ...]
 *   node core/cli.mjs recent [--host ...]
 *   node core/cli.mjs test [--host ...]
 *   node core/cli.mjs test-return [--host ...]
 *   node core/cli.mjs ui [--host antigravity|dsh|zed] [--port 0] [--no-open]
 *   node core/cli.mjs bridge [--port 19876]
 *   node core/cli.mjs bridge-info [--port 19876]
 *   node core/cli.mjs ssh-install <ssh-host> [--port 19876] [--repo <url>]
 *   node core/cli.mjs probe
 *   node core/cli.mjs compile
 *
 * @module answer-card/core/cli
 */

import { spawnSync } from 'node:child_process'
import { DEFAULT_BRIDGE_PORT, defaultBridgeTokenPath, ensureBridgeToken, startBridgeServer } from './bridge.mjs'
import { activateHost, ensureHelper, probeFrontmost, showCard, withCardLock } from './helper.mjs'
import { buildReturnTestPayload, buildTestPayload } from './protocol.mjs'
import {
  APPROVAL_POLICIES,
  DEFAULT_SETTINGS,
  POSITIONS,
  defaultRecentPath,
  defaultSettingsPath,
  getHostProfile,
  readRecent,
  resolveSettings,
  writeSettings,
} from './settings.mjs'
import { openExternalUrl, startSettingsServer } from './settings-server.mjs'

function parseArgs(argv) {
  const positionals = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--host' && i + 1 < argv.length) {
      flags.host = argv[++i]
    } else if (token === '--file' && i + 1 < argv.length) {
      flags.file = argv[++i]
    } else if (token === '--port' && i + 1 < argv.length) {
      flags.port = Number(argv[++i])
    } else if (token === '--repo' && i + 1 < argv.length) {
      flags.repo = argv[++i]
    } else if (token === '--no-open') {
      flags.noOpen = true
    } else if (token === '--global') {
      flags.global = true
    } else {
      positionals.push(token)
    }
  }
  return { command: positionals[0] || 'status', args: positionals.slice(1), flags }
}

function parseValue(key, raw) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (key === 'mutedWorkspaces' || key === 'mutedSessions' || key === 'approvalIgnoreTools') {
    if (raw.trim().startsWith('[')) return JSON.parse(raw)
    return raw.split(',').map((s) => s.trim()).filter(Boolean)
  }
  if (['width', 'fontScale', 'autoDismissMs', 'completeCooldownMs'].includes(key)) {
    const num = Number(raw)
    if (Number.isFinite(num)) return num
  }
  return raw
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

async function main() {
  const { command, args, flags } = parseArgs(process.argv.slice(2))
  const host = flags.host || 'antigravity'
  const profile = getHostProfile(host)
  const settingsFile = flags.file || defaultSettingsPath()
  const writeScope = flags.global ? undefined : (flags.host ? host : undefined)

  if (command === 'compile') {
    const res = ensureHelper()
    printJson(res)
    process.exit(res.ok ? 0 : 1)
  }

  if (command === 'probe') {
    const res = ensureHelper()
    if (!res.ok) {
      printJson(res)
      process.exit(1)
    }
    const front = await probeFrontmost(res.helperPath)
    printJson({ ok: true, frontmost: front ?? null })
    return
  }

  if (command === 'status' || command === 'get') {
    const settings = resolveSettings({}, settingsFile, host)
    if (command === 'get' && args[0]) {
      printJson({ key: args[0], value: settings[args[0]] })
      return
    }
    printJson({
      host,
      settingsFile,
      positions: POSITIONS,
      approvalPolicies: APPROVAL_POLICIES,
      settings,
    })
    return
  }

  if (command === 'set') {
    const [key, ...rest] = args
    if (!key || rest.length === 0) {
      printJson({ ok: false, error: 'usage: set <key> <value>' })
      process.exit(1)
    }
    if (!(key in DEFAULT_SETTINGS)) {
      printJson({ ok: false, error: `unknown key: ${key}`, validKeys: Object.keys(DEFAULT_SETTINGS) })
      process.exit(1)
    }
    const value = parseValue(key, rest.join(' '))
    const next = writeSettings({ [key]: value }, settingsFile, writeScope)
    printJson({ ok: true, settingsFile, scope: writeScope || 'shared', key, value: next[key], settings: next })
    return
  }

  if (command === 'mute-workspace' || command === 'unmute-workspace' || command === 'mute-session' || command === 'unmute-session') {
    const target = (args[0] || '').trim()
    if (!target) {
      printJson({ ok: false, error: `usage: ${command} <value>` })
      process.exit(1)
    }
    const isWorkspace = command.endsWith('workspace')
    const key = isWorkspace ? 'mutedWorkspaces' : 'mutedSessions'
    const current = resolveSettings({}, settingsFile, host)[key] || []
    const nextList = command.startsWith('mute-')
      ? (current.includes(target) ? current : [...current, target])
      : current.filter((item) => item !== target)
    const next = writeSettings({ [key]: nextList }, settingsFile, writeScope)
    printJson({ ok: true, key, [key]: next[key] })
    return
  }

  if (command === 'recent') {
    const recent = readRecent(defaultRecentPath(host))
    const workspaces = [...new Set(recent.map((r) => r.cwd).filter(Boolean))]
    printJson({ ok: true, host, sessions: recent, workspaces })
    return
  }

  if (command === 'bridge') {
    const port = Number.isInteger(flags.port) && flags.port >= 0 ? flags.port : DEFAULT_BRIDGE_PORT
    const srv = await startBridgeServer({ port, settingsFile })
    printJson({
      ok: true,
      url: srv.url,
      port: srv.port,
      tokenFile: defaultBridgeTokenPath(),
      sshConfig: `RemoteForward ${srv.port} 127.0.0.1:${srv.port}`,
    })
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
    await srv.close()
    return
  }

  if (command === 'bridge-info') {
    const port = Number.isInteger(flags.port) && flags.port > 0 ? flags.port : DEFAULT_BRIDGE_PORT
    const tokenFile = defaultBridgeTokenPath()
    ensureBridgeToken(tokenFile)
    const repo = flags.repo || 'https://github.com/Asthestarsfalll/answer-card.git'
    printJson({
      ok: true,
      port,
      tokenFile,
      sshConfigLine: `RemoteForward ${port} 127.0.0.1:${port}`,
      oneStepCommand: `node core/cli.mjs ssh-install <ssh-host>${port !== DEFAULT_BRIDGE_PORT ? ` --port ${port}` : ''}`,
      repo,
    })
    return
  }

  if (command === 'ssh-install') {
    const sshHost = String(args[0] || '').trim()
    if (!sshHost || sshHost.startsWith('-')) {
      printJson({ ok: false, error: 'usage: ssh-install <ssh-host> [--port 19876] [--repo <url>]' })
      process.exit(1)
    }
    const port = Number.isInteger(flags.port) && flags.port > 0 ? flags.port : DEFAULT_BRIDGE_PORT
    const repo = flags.repo || 'https://github.com/Asthestarsfalll/answer-card.git'
    const token = ensureBridgeToken()
    const remoteCmd = [
      'set -eu',
      'mkdir -p "$HOME/.gemini/config/plugins" "$HOME/.config/answer-card"',
      'if [ -d "$HOME/.gemini/config/plugins/answer-card/.git" ]; then',
      '  git -C "$HOME/.gemini/config/plugins/answer-card" pull --ff-only',
      'else',
      `  git clone ${JSON.stringify(repo)} "$HOME/.gemini/config/plugins/answer-card"`,
      'fi',
      'umask 077',
      'cat > "$HOME/.config/answer-card/bridge-token"',
      'chmod 600 "$HOME/.config/answer-card/bridge-token"',
    ].join('\n')
    const res = spawnSync('ssh', [sshHost, remoteCmd], {
      input: `${token}\n`,
      stdio: ['pipe', 'pipe', 'inherit'],
      encoding: 'utf8',
    })
    if (res.status !== 0) {
      printJson({ ok: false, host: sshHost, error: (res.stderr || res.stdout || 'ssh failed').trim() })
      process.exit(1)
    }
    printJson({
      ok: true,
      host: sshHost,
      remotePluginDir: '~/.gemini/config/plugins/answer-card',
      sshConfig: `Host ${sshHost}\n  RemoteForward ${port} 127.0.0.1:${port}`,
    })
    return
  }

  if (command === 'ui') {
    const port = Number.isInteger(flags.port) && flags.port >= 0 ? flags.port : 0
    const srv = await startSettingsServer({ host, port, settingsFile })
    if (!flags.noOpen) openExternalUrl(srv.url)
    printJson({ ok: true, host: srv.host, url: srv.url, settingsFile })
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
    await srv.close()
    return
  }

  if (command === 'test' || command === 'test-return') {
    const ensured = ensureHelper()
    if (!ensured.ok) {
      printJson(ensured)
      process.exit(1)
    }
    const settings = resolveSettings({}, settingsFile, host)
    const payload = command === 'test'
      ? buildTestPayload({ host, hostLabel: profile.shortName, settings })
      : buildReturnTestPayload({ host, hostLabel: profile.shortName, settings })
    const outcome = await withCardLock(() => showCard(ensured.helperPath, payload))
    if (command === 'test-return' && outcome.result === 'choose') {
      activateHost({
        helperPath: ensured.helperPath,
        bundleIds: profile.bundleIds,
        processNames: profile.processNames,
        returnCommand: settings.returnCommand,
        warpPointer: settings.warpPointer,
      })
    }
    printJson({ ok: true, outcome })
    return
  }

  printJson({ ok: false, error: `unknown command: ${command}` })
  process.exit(1)
}

main().catch((err) => {
  printJson({ ok: false, error: String(err) })
  process.exit(1)
})
