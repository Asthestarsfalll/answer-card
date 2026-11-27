import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import {
  approvalRuleKey,
  buildPermissionOverrides,
  describeToolCall,
  formatQuestionReason,
  handleHookInput,
  normalizeAskQuestions,
  passthroughDecision,
  shouldInterceptApproval,
} from '../adapters/antigravity/hook.mjs'
import * as antigravityMcpApp from '../adapters/antigravity/mcp-app.mjs'
import * as dshAdapter from '../adapters/dsh/index.mjs'
import { buildAcpPermissionPayload } from '../adapters/zed/acp-proxy.mjs'
import { describeAgent, lastMessageKind, pickTurnCompletion, shouldSkipForFocus, watchStatePath, watchTick } from '../adapters/zed/native-watch.mjs'
import { createBridgeRequestHandler, encodeBridgeHelperPath, parseBridgeHelperPath, resolveBridgeTarget } from '../core/bridge.mjs'
import { ensureHelper, parseHelperOutput } from '../core/helper.mjs'
import { handleToolCall } from '../core/mcp.mjs'
import { buildApprovalPayload, buildCompletePayload, buildQuestionPayload, buildReturnTestPayload, mapQuestionAnswers, supportsFollowUp } from '../core/protocol.mjs'
import { createSettingsRequestHandler } from '../core/settings-server.mjs'
import {
  DEFAULT_SETTINGS,
  HOST_ORDER,
  isCoolingDown,
  migrateLegacyHostSettings,
  muteReasonOf,
  resolveSettings,
  writeSettings,
} from '../core/settings.mjs'
import {
  normalizeCssColor,
  normalizeThemeSnapshot,
  readZedTheme,
  resolveHostTheme,
  stripJsonc,
  writeHostThemeSnapshot,
} from '../core/theme.mjs'

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'answer-card-test-'))
}

test('settings: normalization, host override, and DSH compatibility', () => {
  const dir = makeTmpDir()
  try {
    const file = join(dir, 'settings.json')
    writeSettings({ position: 'cursor', width: 999, fontScale: 0.2, accent: '#2FBF71', skipWhenDSHFocused: false }, file)
    writeSettings({ approvalPolicy: 'commands', width: 520 }, file, 'antigravity')

    const shared = resolveSettings({}, file)
    assert.equal(shared.position, 'cursor')
    assert.equal(shared.width, 720)
    assert.equal(shared.fontScale, 0.7)
    assert.equal(shared.skipWhenHostFocused, false)
    assert.equal(shared.skipWhenDSHFocused, false)

    const ag = resolveSettings({}, file, 'antigravity')
    assert.equal(ag.position, 'cursor')
    assert.equal(ag.width, 520)
    assert.equal(ag.approvalPolicy, 'commands')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings: mute matching (exact session, exact workspace, prefix workspace) and cooldown', () => {
  const dir = makeTmpDir()
  try {
    const settings = {
      mutedSessions: ['conv-1'],
      mutedWorkspaces: ['/Users/me/exact', '/Users/me/work/'],
    }
    assert.equal(muteReasonOf({ sessionId: 'conv-1', cwd: '/other' }, settings), 'session')
    assert.equal(muteReasonOf({ sessionId: 'conv-2', cwd: '/Users/me/exact' }, settings), 'workspace')
    assert.equal(muteReasonOf({ sessionId: 'conv-2', cwd: '/Users/me/work/sub/repo' }, settings), 'workspace')
    assert.equal(muteReasonOf({ sessionId: 'conv-2', cwd: '/Users/me/workshop' }, settings), null)

    assert.equal(isCoolingDown('ag:s1', 5000, dir), false)
    assert.equal(isCoolingDown('ag:s1', 5000, dir), true)
    assert.equal(isCoolingDown('ag:s2', 5000, dir), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('protocol: question options + custom text mapping and complete follow-up payload', () => {
  const { groups, payload } = buildQuestionPayload({
    hostLabel: 'Antigravity',
    title: 'answer-card',
    questions: [
      { id: 'q0', question: 'Pick architecture', options: ['Layered', 'Monolith'] },
      { id: 'q1', question: 'Extra note', options: [] },
    ],
    settings: DEFAULT_SETTINGS,
  })
  assert.equal(payload.groups.length, 2)
  assert.equal(payload.groups[1].input, true)

  const answers = mapQuestionAnswers(groups, {
    result: 'choose',
    answers: { q0: ['0'], q1: ['support zed'] },
    texts: { q0: 'keep DSH working' },
  })
  assert.deepEqual(answers[0].selected, ['Layered'])
  assert.equal(answers[0].custom, 'keep DSH working')
  assert.equal(answers[1].custom, 'support zed')

  const complete = buildCompletePayload({
    host: 'antigravity',
    hostLabel: 'Antigravity',
    title: 'answer-card',
    settings: DEFAULT_SETTINGS,
    allowFollowUp: true,
  })
  assert.equal(complete.groups.length, 1)
  assert.equal(complete.groups[0].optional, true)
  assert.equal(complete.submit, '回到 Antigravity')
  assert.equal(complete.submitWhenTyped, '发送到 Antigravity')
})

test('antigravity hook: approval policy matrix and describeToolCall', () => {
  const external = { ...DEFAULT_SETTINGS, approvalPolicy: 'external' }
  assert.equal(shouldInterceptApproval({ name: 'run_command', args: { CommandLine: 'ls -la' } }, external), false)
  assert.equal(shouldInterceptApproval({ name: 'run_command', args: { CommandLine: 'ls -la', BypassSandbox: true } }, external), true)
  assert.equal(shouldInterceptApproval({ name: 'run_command', args: { CommandLine: 'git push origin main' } }, external), true)
  assert.equal(shouldInterceptApproval({ name: 'call_mcp_tool', args: { ServerName: 'gh', ToolName: 'create_pr' } }, external), true)
  assert.equal(shouldInterceptApproval({ name: 'write_file', args: { Path: '/tmp/a' } }, external), false)

  const mutating = { ...DEFAULT_SETTINGS, approvalPolicy: 'mutating' }
  assert.equal(shouldInterceptApproval({ name: 'write_file', args: { Path: '/tmp/a' } }, mutating), true)

  const ignored = { ...external, approvalIgnoreTools: ['mcp:gh:create_pr'] }
  assert.equal(shouldInterceptApproval({ name: 'call_mcp_tool', args: { ServerName: 'gh', ToolName: 'create_pr' } }, ignored), false)

  const desc = describeToolCall({ name: 'run_command', args: { CommandLine: 'git push', BypassSandbox: true, toolSummary: 'Push code' } })
  assert.equal(desc.toolLabel, 'run_command')
  assert.match(desc.reason, /BypassSandbox/)
})

test('antigravity hook: PreToolUse ask_question answered vs fallback', async () => {
  const dir = makeTmpDir()
  try {
    const paths = {
      settingsFile: join(dir, 'settings.json'),
      recentFile: join(dir, 'recent.json'),
      stateDir: join(dir, 'state'),
    }
    const baseInput = {
      hookEventName: 'PreToolUse',
      conversationId: 'conv-abc',
      cwd: '/Users/me/proj',
      toolCall: {
        name: 'ask_question',
        args: {
          questions: [{ question: 'Deploy now?', options: ['Yes', 'No'], is_multi_select: false }],
        },
      },
    }

    // 1. Answered via floating card -> deny with structured [answer-card] reason
    const answered = await handleHookInput(baseInput, {
      paths,
      ensureHelperFn: () => ({ ok: true, helperPath: '/fake/helper' }),
      isHostFocusedFn: async () => false,
      showCardFn: async () => ({ result: 'choose', answers: { q0: ['0'] }, texts: { q0: 'staging only' } }),
    })
    assert.equal(answered.decision, 'deny')
    assert.match(answered.reason, /^\[answer-card\]/)
    assert.match(answered.reason, /Yes/)
    assert.match(answered.reason, /staging only/)

    // 2. Host focused -> allow (native UI)
    const focused = await handleHookInput(baseInput, {
      paths,
      ensureHelperFn: () => ({ ok: true, helperPath: '/fake/helper' }),
      isHostFocusedFn: async () => true,
    })
    assert.deepEqual(focused, { decision: 'allow' })

    // 3. Dismissed -> allow (native UI fallback)
    const dismissed = await handleHookInput(baseInput, {
      paths,
      ensureHelperFn: () => ({ ok: true, helperPath: '/fake/helper' }),
      isHostFocusedFn: async () => false,
      showCardFn: async () => ({ result: 'dismiss' }),
    })
    assert.deepEqual(dismissed, { decision: 'allow' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('antigravity hook: PreToolUse approval allow / deny / dismiss', async () => {
  const dir = makeTmpDir()
  try {
    const paths = {
      settingsFile: join(dir, 'settings.json'),
      recentFile: join(dir, 'recent.json'),
      stateDir: join(dir, 'state'),
    }
    const input = {
      hookEventName: 'PreToolUse',
      conversationId: 'conv-2',
      cwd: '/Users/me/proj',
      toolCall: {
        name: 'run_command',
        args: { CommandLine: 'git push', BypassSandbox: true },
      },
    }

    const allowRes = await handleHookInput(input, {
      paths,
      ensureHelperFn: () => ({ ok: true, helperPath: '/fake' }),
      isHostFocusedFn: async () => false,
      showCardFn: async (_h, payload) => {
        // 原样转发，不附加额外提示文案，并提供 4 个审批选项
        assert.equal(payload.groups[0].text, '')
        assert.doesNotMatch(String(payload.message ?? ''), /需要你点头/)
        assert.deepEqual(payload.groups[0].choices.map((c) => c.id), ['allow', 'allow_session', 'allow_always', 'deny'])
        return { result: 'choose', answers: { approval: ['allow'] } }
      },
    })
    assert.deepEqual(allowRes, {
      decision: 'allow',
      permissionOverrides: ['command(git push)', 'unsandboxed(git push)'],
    })
    assert.deepEqual(buildPermissionOverrides({ name: 'call_mcp_tool', args: { ServerName: 'answer-card_settings', ToolName: 'open_answer_card_settings' } }), [
      'mcp(answer-card_settings/open_answer_card_settings)',
    ])
    assert.deepEqual(buildPermissionOverrides({ name: 'edit_file', args: { Path: '/tmp/a.js' } }), [
      'write_file(/tmp/a.js)',
    ])

    // allow_session: 同一会话第二次同类调用直接放行，不再弹卡
    let cardShown = 0
    const sessionAllow1 = await handleHookInput(input, {
      paths,
      ensureHelperFn: () => ({ ok: true, helperPath: '/fake' }),
      isHostFocusedFn: async () => false,
      showCardFn: async () => { cardShown += 1; return { result: 'choose', answers: { approval: ['allow_session'] } } },
    })
    assert.deepEqual(sessionAllow1, {
      decision: 'allow',
      permissionOverrides: ['command(git push)', 'unsandboxed(git push)'],
    })
    const sessionAllow2 = await handleHookInput(input, {
      paths,
      ensureHelperFn: () => ({ ok: true, helperPath: '/fake' }),
      isHostFocusedFn: async () => false,
      showCardFn: async () => { cardShown += 1; return { result: 'dismiss' } },
    })
    assert.deepEqual(sessionAllow2, {
      decision: 'allow',
      permissionOverrides: ['command(git push)', 'unsandboxed(git push)'],
    })
    assert.equal(cardShown, 1)

    // allow_always: 写入 hosts.antigravity.approvalIgnoreTools，跨会话直接放行
    const alwaysInput = {
      ...input,
      conversationId: 'conv-other-session',
      toolCall: { name: 'call_mcp_tool', args: { ServerName: 'gh', ToolName: 'create_pr' } },
    }
    assert.equal(approvalRuleKey(alwaysInput.toolCall), 'mcp:gh:create_pr')
    assert.equal(approvalRuleKey({ name: 'run_command', args: { CommandLine: 'git push origin main' } }), 'cmd:git push')
    const alwaysRes1 = await handleHookInput(alwaysInput, {
      paths,
      ensureHelperFn: () => ({ ok: true, helperPath: '/fake' }),
      isHostFocusedFn: async () => false,
      showCardFn: async () => ({ result: 'choose', answers: { approval: ['allow_always'] } }),
    })
    assert.deepEqual(alwaysRes1, {
      decision: 'allow',
      permissionOverrides: ['mcp(gh/create_pr)'],
    })
    let calledAgain = false
    const alwaysRes2 = await handleHookInput({ ...alwaysInput, conversationId: 'conv-third' }, {
      paths,
      ensureHelperFn: () => ({ ok: true, helperPath: '/fake' }),
      isHostFocusedFn: async () => false,
      showCardFn: async () => { calledAgain = true; return { result: 'dismiss' } },
    })
    assert.deepEqual(alwaysRes2, {
      decision: 'allow',
      permissionOverrides: ['mcp(gh/create_pr)'],
    })
    assert.equal(calledAgain, false)

    const denyRes = await handleHookInput({ ...input, conversationId: 'conv-deny' }, {
      paths,
      ensureHelperFn: () => ({ ok: true, helperPath: '/fake' }),
      isHostFocusedFn: async () => false,
      showCardFn: async (_h, payload) => {
        assert.equal(payload.allowText, true)
        return { result: 'choose', answers: { approval: ['deny'] }, texts: { approval: 'use npm run lint instead' } }
      },
    })
    assert.equal(denyRes.decision, 'deny')
    assert.match(denyRes.reason, /use npm run lint instead/)

    // 不点选项、仅输入替代指令直接提交 -> 也视为 deny 并附带指令
    const textOnlyDeny = await handleHookInput({ ...input, conversationId: 'conv-deny-text' }, {
      paths,
      ensureHelperFn: () => ({ ok: true, helperPath: '/fake' }),
      isHostFocusedFn: async () => false,
      showCardFn: async () => ({ result: 'choose', answers: { approval: [] }, texts: { approval: 'skip push for now' } }),
    })
    assert.equal(textOnlyDeny.decision, 'deny')
    assert.match(textOnlyDeny.reason, /skip push for now/)

    const dismissRes = await handleHookInput({ ...input, conversationId: 'conv-dismiss' }, {
      paths,
      ensureHelperFn: () => ({ ok: true, helperPath: '/fake' }),
      isHostFocusedFn: async () => false,
      showCardFn: async () => ({ result: 'dismiss' }),
    })
    assert.deepEqual(dismissRes, { decision: 'ask' })

    // Passthrough decisions never return empty {} (Antigravity PreToolUse requires explicit decision)
    assert.deepEqual(passthroughDecision({ name: 'run_command', args: { CommandLine: 'ls -la' } }, {}), { decision: 'allow' })
    assert.deepEqual(passthroughDecision({ name: 'run_command', args: { CommandLine: 'ls -la', BypassSandbox: true } }, {}), { decision: 'ask' })
    assert.deepEqual(passthroughDecision({ name: 'call_mcp_tool', args: {} }, {}), { decision: 'ask' })
    assert.deepEqual(passthroughDecision({ name: 'edit_file', args: { Path: '/ws/a.js' } }, { workspacePaths: ['/ws'] }), { decision: 'allow' })
    assert.deepEqual(passthroughDecision({ name: 'edit_file', args: { Path: '/etc/hosts' } }, { workspacePaths: ['/ws'] }), { decision: 'ask' })
    // 工作区外文件写入独立生成 external 规则键，不被工作区内 write_file/edit_file 放行规则误吞
    assert.equal(approvalRuleKey({ name: 'edit_file', args: { Path: '/etc/hosts' } }, { workspacePaths: ['/ws'] }), 'edit_file:external:/etc/hosts')
    assert.equal(shouldInterceptApproval({ name: 'edit_file', args: { Path: '/etc/hosts' } }, { approvalPolicy: 'external', approvalIgnoreTools: ['edit_file'] }, { workspacePaths: ['/ws'] }), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('antigravity mcp-app: capabilities, entrypoints, per-host vs shared settings persistence', async () => {
  const dir = makeTmpDir()
  try {
    const settingsFile = join(dir, 'settings.json')
    const recentFile = join(dir, 'recent.json')
    const opts = { settingsFile, recentFile }

    const init = await antigravityMcpApp.dispatchRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, opts)
    assert.ok(init.result.capabilities.resources)
    assert.ok(init.result.capabilities.tools)

    const toolsRes = await antigravityMcpApp.dispatchRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, opts)
    const openTool = toolsRes.result.tools.find((t) => t.name === 'open_answer_card_settings')
    assert.equal(openTool._meta.ui.resourceUri, antigravityMcpApp.APP_URI)
    assert.equal(openTool._meta['com.google.antigravity/ui'].entrypoints.length, 2)

    const appOnlyTool = toolsRes.result.tools.find((t) => t.name === 'app_save_settings')
    assert.deepEqual(appOnlyTool._meta.ui.visibility, ['app'])

    // Save independent returnCommand per host + shared width
    await antigravityMcpApp.handleToolCall('app_save_settings', {
      scope: 'shared',
      host: 'antigravity',
      patch: { width: 512, position: 'cursor' },
    }, opts)
    await antigravityMcpApp.handleToolCall('app_save_settings', {
      scope: 'host',
      host: 'antigravity',
      patch: { returnCommand: 'open -a Antigravity', mutedSessions: ['conv-99'] },
    }, opts)
    await antigravityMcpApp.handleToolCall('app_save_settings', {
      scope: 'host',
      host: 'zed',
      patch: { returnCommand: '' },
    }, opts)

    const agState = antigravityMcpApp.buildState('antigravity', opts)
    const zedState = antigravityMcpApp.buildState('zed', opts)
    assert.equal(agState.effective.width, 512)
    assert.equal(zedState.effective.width, 512)
    assert.equal(agState.effective.returnCommand, 'open -a Antigravity')
    assert.equal(zedState.effective.returnCommand, '')
    assert.deepEqual(agState.effective.mutedSessions, ['conv-99'])
    assert.deepEqual(zedState.effective.mutedSessions, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('antigravity hook: Stop follow-up continuation vs activate host vs loop guard', async () => {
  const dir = makeTmpDir()
  try {
    const paths = {
      settingsFile: join(dir, 'settings.json'),
      recentFile: join(dir, 'recent.json'),
      stateDir: join(dir, 'state'),
    }
    writeSettings({ completeCooldownMs: 0 }, paths.settingsFile)

    // Follow-up text -> continue
    const cont = await handleHookInput({
      hookEventName: 'Stop',
      conversationId: 'conv-stop-1',
      cwd: '/Users/me/proj',
      terminationReason: 'NO_TOOL_CALL',
      continuationActive: false,
    }, {
      paths,
      ensureHelperFn: () => ({ ok: true, helperPath: '/fake' }),
      isHostFocusedFn: async () => false,
      showCardFn: async () => ({ result: 'choose', answers: { followup: ['run tests too'] }, texts: { followup: 'run tests too' } }),
    })
    assert.equal(cont.decision, 'continue')
    assert.match(cont.reason, /run tests too/)

    // Empty submit -> activate Antigravity
    let activated = false
    const act = await handleHookInput({
      hookEventName: 'Stop',
      conversationId: 'conv-stop-2',
      cwd: '/Users/me/proj',
      terminationReason: 'NO_TOOL_CALL',
      continuationActive: false,
    }, {
      paths,
      ensureHelperFn: () => ({ ok: true, helperPath: '/fake' }),
      isHostFocusedFn: async () => false,
      showCardFn: async () => ({ result: 'choose', answers: { followup: [] }, texts: {} }),
      activateHostFn: () => { activated = true },
    })
    assert.deepEqual(act, {})
    assert.equal(activated, true)

    // continuationActive guard -> skip
    const skipped = await handleHookInput({
      hookEventName: 'Stop',
      conversationId: 'conv-stop-3',
      terminationReason: 'NO_TOOL_CALL',
      continuationActive: true,
    }, {
      paths,
      ensureHelperFn: () => { throw new Error('should not run') },
    })
    assert.deepEqual(skipped, {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('helper output parser, DSH adapter compatibility, Zed ACP payload, and MCP validation', async () => {
  assert.deepEqual(parseHelperOutput('noise\n{"result":"choose","answers":{"a":["1"]}}\n'), {
    result: 'choose',
    answers: { a: ['1'] },
  })
  assert.deepEqual(parseHelperOutput('not json'), { result: 'error' })

  assert.equal(typeof dshAdapter.apply, 'function')
  assert.equal(dshAdapter.muteReasonOf({ session: { id: 's1', header: { cwd: '/a/b' } } }, { mutedWorkspaces: ['/a/'] }), 'workspace')

  const acpPayload = buildAcpPermissionPayload({
    cwd: '/Users/me/zed-app',
    toolCall: { title: 'Run cargo test' },
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
  }, DEFAULT_SETTINGS)
  assert.equal(acpPayload.kicker, 'Zed')
  assert.equal(acpPayload.groups[0].text, '')
  assert.equal(acpPayload.groups[0].choices.length, 2)

  assert.equal(normalizeAskQuestions([{ question: 'Q?', options: ['A'], is_multi_select: true }])[0].multiSelect, true)
  assert.match(formatQuestionReason([{ id: 'q0', question: 'Q?', selected: ['A'] }]), /Q\? => A/)

    const mcpErr = await handleToolCall('unknown_tool', {})
  assert.equal(mcpErr.isError, true)
  assert.ok(buildApprovalPayload({ host: 'antigravity', hostLabel: 'Antigravity', title: 't', toolName: 'run_command', settings: DEFAULT_SETTINGS }))
})


test('settings: legacy host migration splits shared and host scopes', () => {
  const dir = makeTmpDir()
  try {
    const unified = join(dir, 'settings.json')
    const legacy = join(dir, 'dsh-answer-card.json')
    writeFileSync(unified, JSON.stringify({ sound: true, hosts: { antigravity: { approvalPolicy: 'all' } } }))
    writeFileSync(legacy, JSON.stringify({
      sound: false,
      position: 'cursor',
      returnCommand: 'open -a "DSH Desktop"',
      mutedSessions: ['s1'],
      completeCooldownMs: 12000,
    }))

    assert.equal(migrateLegacyHostSettings('dsh', legacy, unified), true)
    const raw = JSON.parse(readFileSync(unified, 'utf8'))
    assert.equal(raw.hosts.dsh.returnCommand, 'open -a "DSH Desktop"')
    assert.deepEqual(raw.hosts.dsh.mutedSessions, ['s1'])
    assert.equal(raw.hosts.dsh.completeCooldownMs, 12000)
    assert.equal(raw.hosts.dsh.sound, false)
    // 共享键不能塞进宿主覆写，否则会挡住全局设置。
    assert.equal(raw.hosts.dsh.position, undefined)
    assert.equal(raw.sound, true)
    // 迁移只发生一次。
    assert.equal(migrateLegacyHostSettings('dsh', legacy, unified), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mcp-app: host list and capabilities are data-driven', () => {
  const dir = makeTmpDir()
  try {
    const settingsFile = join(dir, 'settings.json')
    writeFileSync(settingsFile, JSON.stringify({ hosts: {} }))
    const state = antigravityMcpApp.buildState('dsh', {
      settingsFile,
      recentFile: join(dir, 'recent.json'),
      stateDir: join(dir, 'state'),
    })
    assert.deepEqual(state.hosts.map((h) => h.id), HOST_ORDER)
    const dsh = state.hosts.find((h) => h.id === 'dsh')
    const ag = state.hosts.find((h) => h.id === 'antigravity')
    assert.equal(dsh.capabilities.approvalPolicy, false)
    assert.equal(dsh.capabilities.returnCommand, true)
    assert.equal(ag.capabilities.approvalPolicy, true)
    assert.equal(ag.capabilities.quickFollowUp, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('theme: dynamic adaptive resolution (live snapshot, Zed JSONC + custom theme, manual override)', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const dir = makeTmpDir()
  try {
    assert.equal(normalizeCssColor('#abc'), '#AABBCC')
    assert.equal(normalizeCssColor('rgb(26, 115, 232)'), '#1A73E8')
    assert.equal(normalizeCssColor('#112233ff'), '#112233')
    // 半透明暗色叠加在浅暖背景 #F8F0DC 上应混合成柔和浅色，绝不能截断成纯黑 #0A0A0C
    assert.equal(normalizeCssColor('rgba(10, 10, 12, 0.06)', '#F8F0DC'), '#EAE2D0')
    assert.equal(normalizeCssColor('#0A0A0C1F', '#F8F0DC'), '#DBD4C3')
    assert.equal(normalizeCssColor('rgba(0, 0, 0, 0)', '#F8F0DC'), undefined)
    assert.deepEqual(JSON.parse(stripJsonc('{ /* c */ "a": 1, // line\n }')), { a: 1 })

    // 1. Live Antigravity hostContext snapshot (light mode with translucent surface/border)
    const stateDir = join(dir, 'state')
    writeHostThemeSnapshot('antigravity', {
      theme: 'light',
      variables: {
        '--color-background-primary': '#F8F0DC',
        '--color-background-secondary': 'rgba(10, 10, 12, 0.06)',
        '--color-border-primary': 'rgba(10, 10, 12, 0.14)',
        '--color-text-primary': '#5C6A72',
        '--color-ring-primary': '#4E7525',
      },
    }, stateDir)
    const agLight = resolveHostTheme({ host: 'antigravity', settings: { themeMode: 'auto', accent: '' }, stateDir, systemAppearance: 'dark' })
    assert.equal(agLight.mode, 'light')
    assert.equal(agLight.background, '#F8F0DC')
    assert.equal(agLight.surface, '#EAE2D0')
    assert.equal(agLight.border, '#D7D0BF')
    assert.equal(agLight.accent, '#4E7525')

    // 1b. DSH reports its real CSS alias tokens (bg-base/bg-l1, dark marker → mode dark).
    const dshSnapshot = normalizeThemeSnapshot({
      mode: 'dark',
      variables: {
        '--dsw-alias-bg-base': '#151517',
        '--dsw-alias-bg-l1': '#232325',
        '--dsw-alias-border-primary': '#333537',
        '--dsw-alias-label-primary': '#F5F5F7',
        '--dsw-alias-label-tertiary': '#A1A1A6',
        '--dsw-alias-brand-primary': '#F5222D',
      },
    })
    assert.equal(dshSnapshot.mode, 'dark')
    assert.equal(dshSnapshot.background, '#151517')
    assert.equal(dshSnapshot.surface, '#232325')
    assert.equal(dshSnapshot.textPrimary, '#F5F5F7')
    assert.equal(dshSnapshot.accent, '#F5222D')
    writeHostThemeSnapshot('dsh', dshSnapshot, stateDir)
    const dshDark = resolveHostTheme({ host: 'dsh', settings: { themeMode: 'auto', accent: '' }, stateDir, systemAppearance: 'light' })
    assert.equal(dshDark.mode, 'dark')
    assert.equal(dshDark.background, '#151517')
    assert.equal(dshDark.textPrimary, '#F5F5F7')

    // 1c. 旧版 DSH 客户端只上报文字色时，用文字亮度推断主题，不能退回系统外观。
    const dshLegacy = normalizeThemeSnapshot({
      textPrimary: '#152443',
      textSecondary: '#81858C',
      accent: '#F5222D',
    })
    assert.equal(dshLegacy.mode, 'light')

    // 2. Manual dark override + custom accent
    const agManual = resolveHostTheme({ host: 'antigravity', settings: { themeMode: 'dark', accent: '#FF6600' }, stateDir })
    assert.equal(agManual.mode, 'dark')
    assert.equal(agManual.accent, '#FF6600')

    // 3. Zed JSONC settings + custom theme file
    const zedDir = join(dir, 'zed')
    mkdirSync(join(zedDir, 'themes'), { recursive: true })
    writeFileSync(join(zedDir, 'settings.json'), '{\n  // comment\n  "theme": { "mode": "light", "light": "My Soft Light", "dark": "One Dark", },\n}\n')
    writeFileSync(join(zedDir, 'themes', 'soft.json'), JSON.stringify({
      themes: [{
        name: 'My Soft Light',
        appearance: 'light',
        style: {
          'panel.background': '#FAF8F5',
          'element.background': '#EFECE6',
          border: '#DDD8CE',
          text: '#222222',
          'text.muted': '#666666',
          'text.accent': '#0A66C2',
          created: '#2E7D32',
        },
      }],
    }))
    const zedRaw = readZedTheme({ zedConfigDir: zedDir, systemAppearance: 'dark' })
    assert.equal(zedRaw.mode, 'light')
    assert.equal(zedRaw.background, '#FAF8F5')
    assert.equal(zedRaw.accent, '#0A66C2')

    const zedResolved = resolveHostTheme({ host: 'zed', settings: { themeMode: 'auto', accent: '' }, stateDir, zedConfigDir: zedDir })
    assert.equal(zedResolved.mode, 'light')
    assert.equal(zedResolved.background, '#FAF8F5')
    assert.equal(zedResolved.accent, '#0A66C2')
    assert.equal(zedResolved.completeAccent, '#0A66C2')

    // 3b. Zed installed extension blur theme (transparent panel.background skipped, flat surface derived)
    const zedExtRoot = join(dir, 'zed-extensions')
    mkdirSync(join(zedExtRoot, 'everforest', 'themes'), { recursive: true })
    writeFileSync(join(zedDir, 'settings.json'), '{\n  "theme": { "mode": "system", "light": "Everforest Light Soft (blur)", "dark": "One Dark" }\n}\n')
    writeFileSync(join(zedExtRoot, 'everforest', 'themes', 'everforest-blur.json'), JSON.stringify({
      themes: [{
        name: 'Everforest Light Soft (blur)',
        appearance: 'light',
        style: {
          'elevated_surface.background': '#f3ead3',
          'panel.background': '#f3ead300',
          'element.background': '#f3ead3',
          border: '#e5dfc5',
          text: '#5c6a72',
          'text.muted': '#939f91',
          'text.accent': '#8da101',
          created: '#8da101',
        },
      }],
    }))
    const zedExtResolved = resolveHostTheme({
      host: 'zed',
      settings: { themeMode: 'auto', accent: '' },
      stateDir,
      systemAppearance: 'light',
      zedConfigDir: zedDir,
      zedExtensionsDir: zedExtRoot,
    })
    assert.equal(zedExtResolved.mode, 'light')
    assert.equal(zedExtResolved.background, '#F3EAD3')
    assert.notEqual(zedExtResolved.surface, '#F3EAD3')
    assert.equal(zedExtResolved.accent, '#8DA101')

    // 4. Unknown future harness works cleanly without touching core/
    const customHarness = resolveHostTheme({ host: 'claude-code', settings: { themeMode: 'auto', accent: '' }, stateDir, systemAppearance: 'light' })
    assert.equal(customHarness.mode, 'light')
    assert.equal(customHarness.background, '#FFFFFF')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings-server & mcp settings tool: serves shared UI, enforces CSRF token, and persists host settings', async () => {
  const { EventEmitter } = await import('node:events')
  const dir = makeTmpDir()
  try {
    const settingsFile = join(dir, 'settings.json')
    const stateDir = join(dir, 'state')
    const { handler, token } = createSettingsRequestHandler({ host: 'zed', settingsFile, stateDir })

    const invoke = (method, url, headers = {}, body = null) => new Promise((resolve) => {
      const req = Object.assign(new EventEmitter(), { method, url, headers })
      let status = 200
      let resHeaders = {}
      const chunks = []
      const res = {
        writeHead(code, h = {}) { status = code; resHeaders = h },
        end(data = '') {
          chunks.push(Buffer.from(String(data)))
          resolve({ status, headers: resHeaders, text: Buffer.concat(chunks).toString('utf8') })
        },
      }
      handler(req, res)
      if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })

    const home = await invoke('GET', '/')
    assert.equal(home.status, 200)
    assert.match(home.text, /answer-card-settings/)
    assert.match(home.text, /\/ui\.js/)

    const uiJs = await invoke('GET', '/ui.js')
    assert.equal(uiJs.status, 200)
    assert.match(uiJs.text, /answer-card-settings/)

    // Missing CSRF token -> 403
    const denied = await invoke('POST', '/app', {}, { name: 'app_get_state', args: { host: 'zed' } })
    assert.equal(denied.status, 403)

    // Valid token -> saves Zed override and reads it back
    const saved = await invoke('POST', '/app', { 'x-answer-card-token': token }, {
      name: 'app_save_settings',
      args: { host: 'zed', scope: 'host', patch: { returnCommand: 'open -a Zed' } },
    })
    assert.equal(saved.status, 200)
    assert.equal(JSON.parse(saved.text).ok, true)

    const mcpGet = await handleToolCall('answer_card_settings', { action: 'get' }, { settingsFile })
    const mcpData = JSON.parse(mcpGet.content[0].text)
    assert.equal(mcpData.effective.returnCommand, 'open -a Zed')

    const mcpSet = await handleToolCall('answer_card_settings', {
      action: 'set',
      scope: 'host',
      patch: { sound: true },
    }, { settingsFile })
    assert.equal(JSON.parse(mcpSet.content[0].text).settings.sound, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bridge: auto target detection, Bearer auth, local theme merge, and safe activate', async () => {
  const { EventEmitter } = await import('node:events')
  const dir = makeTmpDir()
  try {
    const tokenFile = join(dir, 'bridge-token')
    writeFileSync(tokenFile, 'secret-token-123\n')
    const settingsFile = join(dir, 'settings.json')
    writeSettings({ position: 'cursor', width: 520, sound: true }, settingsFile)
    writeSettings({ returnCommand: 'open -a Antigravity' }, settingsFile, 'antigravity')

    // Non-macOS with token auto-detects local SSH reverse-forwarded bridge
    const linuxTarget = resolveBridgeTarget({ platform: 'linux', tokenFile, bridgePort: 19876 })
    assert.deepEqual(linuxTarget, { url: 'http://127.0.0.1:19876', token: 'secret-token-123' })
    assert.equal(resolveBridgeTarget({ platform: 'darwin', tokenFile }), null)
    assert.equal(resolveBridgeTarget({ platform: 'linux', tokenFile, bridgeUrl: 'off' }), null)
    assert.equal(parseBridgeHelperPath(encodeBridgeHelperPath('http://127.0.0.1:19876/')), 'http://127.0.0.1:19876')

    const ensuredBridge = ensureHelper({ bridgeUrl: 'http://127.0.0.1:19876', bridgeToken: 'secret-token-123' })
    assert.equal(ensuredBridge.ok, true)
    assert.equal(ensuredBridge.mode, 'bridge')
    assert.equal(ensuredBridge.helperPath, 'bridge://http://127.0.0.1:19876')

    let shownPayload = null
    let activatedArgs = null
    const { handler } = createBridgeRequestHandler({
      token: 'secret-token-123',
      settingsFile,
      stateDir: join(dir, 'state'),
      ensureHelperFn: () => ({ ok: true, helperPath: '/fake/mac-helper' }),
      probeFrontmostFn: async () => ({ bundleId: 'com.google.Chrome', name: 'Google Chrome' }),
      withCardLockFn: (fn) => fn(),
      showCardFn: async (_h, payload) => {
        shownPayload = payload
        return { result: 'choose', answers: { approval: ['allow'] } }
      },
      activateHostFn: (opts) => { activatedArgs = opts },
    })

    const invoke = (method, url, headers = {}, body = null) => new Promise((resolve) => {
      const req = Object.assign(new EventEmitter(), { method, url, headers })
      let status = 200
      const chunks = []
      const res = {
        writeHead(code) { status = code },
        end(data = '') {
          chunks.push(Buffer.from(String(data)))
          resolve({ status, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        },
      }
      handler(req, res)
      if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })

    const health = await invoke('GET', '/health')
    assert.equal(health.status, 200)
    assert.equal(health.data.service, 'answer-card-bridge')

    // Unauthorized blocked
    const unauth = await invoke('POST', '/probe', {}, {})
    assert.equal(unauth.status, 403)

    const authHeaders = { authorization: 'Bearer secret-token-123' }
    const probe = await invoke('POST', '/probe', authHeaders, {})
    assert.equal(probe.status, 200)
    assert.equal(probe.data.frontmost.bundleId, 'com.google.Chrome')

    // /card merges local Mac visual settings (position, width, sound)
    const cardRes = await invoke('POST', '/card', authHeaders, {
      host: 'antigravity',
      payload: { kind: 'approval', title: 'rm75', groups: [] },
    })
    assert.equal(cardRes.status, 200)
    assert.equal(cardRes.data.outcome.result, 'choose')
    assert.equal(shownPayload.position, 'cursor')
    assert.equal(shownPayload.width, 520)
    assert.equal(shownPayload.sound, true)

    // /activate ignores untrusted remote returnCommand and uses Mac's local setting
    const actRes = await invoke('POST', '/activate', authHeaders, {
      host: 'antigravity',
      returnCommand: 'rm -rf /should-never-run',
      windowHints: ['rm75'],
    })
    assert.equal(actRes.status, 200)
    assert.equal(activatedArgs.returnCommand, 'open -a Antigravity')
    assert.deepEqual(activatedArgs.windowHints, ['rm75'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('zed native-watch: turn completion detection, focus drop, and dedupe', async () => {
  const dir = makeTmpDir()
  try {
    assert.equal(pickTurnCompletion({ messages: [] }), null)
    assert.equal(pickTurnCompletion({ messages: [{ User: { id: 'u1', content: 'hi' } }] }), null)
    assert.equal(lastMessageKind({ messages: [{ User: { id: 'u1', content: 'hi' } }] }), 'user')
    assert.equal(lastMessageKind({ messages: [{ Agent: { content: [], tool_results: {} } }] }), 'agent')
    // Zed 把 Text 序列化成字符串。
    assert.deepEqual(
      pickTurnCompletion({ messages: [{ Agent: { content: [{ Thinking: { text: '嗯' } }, { Text: 'done' }], tool_results: {} } }] }),
      { messageCount: 1, text: 'done' },
    )
    // 兼容 { Text: { text } } 形式。
    assert.deepEqual(
      pickTurnCompletion({ messages: [{ Agent: { content: [{ Text: { text: 'obj' } }], tool_results: {} } }] }),
      { messageCount: 1, text: 'obj' },
    )
    // 工具没回填结果 → 回合未结束。
    assert.equal(pickTurnCompletion({ messages: [{ Agent: { content: [{ ToolUse: { id: 't1' } }], tool_results: {} } }] }), null)
    // 工具已回填但最后一项是 ToolUse → 回合仍会继续。
    assert.equal(pickTurnCompletion({ messages: [{ Agent: { content: [{ Text: 'hi' }, { ToolUse: { id: 't1' } }], tool_results: { t1: {} } } }] }), null)

    const dbPath = join(dir, 'threads.db')
    const db = new DatabaseSync(dbPath)
    db.exec('create table threads (id text primary key, parent_id text, summary text, updated_at text, folder_paths text, data blob)')
    const upsert = db.prepare('insert or replace into threads (id, parent_id, summary, updated_at, folder_paths, data) values (?, ?, ?, ?, ?, ?)')
    const encode = (thread) => zstdCompressSync(Buffer.from(JSON.stringify(thread), 'utf8'))
    const ctx = {
      dbPath,
      settingsFile: join(dir, 'settings.json'),
      stateDir: join(dir, 'state'),
      intervalMs: 0,
      quietMs: 60000,
      dryRun: false,
      trace: () => {},
      queue: { enqueue: async (fn) => fn() },
      fire: async () => 'focused',
    }
    const stateFile = watchStatePath(ctx.stateDir)
    const readPending = () => JSON.parse(readFileSync(stateFile, 'utf8')).pending
    const completed = {
      messages: [
        { User: { id: 'u1', content: 'go' } },
        { Agent: { content: [{ Thinking: { text: '想' } }, { Text: '完成了' }], tool_results: {} } },
      ],
    }

    upsert.run('t-1', null, 'Demo', '2026-01-01T00:00:00Z', '/tmp/project', encode({ messages: [{ User: { id: 'u1', content: 'go' } }] }))
    await watchTick(ctx)
    assert.deepEqual(readPending(), {})

    upsert.run('t-1', null, 'Demo', '2026-01-01T00:00:05Z', '/tmp/project', encode(completed))
    await watchTick(ctx)
    assert.equal(readPending()['t-1'].text, '完成了')

    // 同一回合被再次落库（滚动位置、标题等写回）不能丢掉候选。
    upsert.run('t-1', null, 'Demo', '2026-01-01T00:00:09Z', '/tmp/project', encode(completed))
    await watchTick(ctx)
    assert.equal(readPending()['t-1'].text, '完成了')

    // 宿主在前台：直接丢弃，不延迟补发（避免过期卡片）。
    ctx.quietMs = 0
    await watchTick(ctx)
    assert.deepEqual(readPending(), {})

    // 新回合完成且宿主不在前台时，立即消费并弹卡。
    ctx.quietMs = 60000
    const secondTurn = {
      messages: [...completed.messages, { Agent: { content: [{ Text: '第二轮完成' }], tool_results: {} } }],
    }
    upsert.run('t-1', null, 'Demo', '2026-01-01T00:01:00Z', '/tmp/project', encode(secondTurn))
    await watchTick(ctx)
    assert.equal(readPending()['t-1'].text, '第二轮完成')
    ctx.fire = async () => 'shown'
    ctx.quietMs = 0
    await watchTick(ctx)
    assert.deepEqual(readPending(), {})

    // 用户发出新消息时，残留候选立即作废。
    ctx.fire = async () => 'focused'
    ctx.quietMs = 60000
    const thirdTurn = {
      messages: [...secondTurn.messages, { Agent: { content: [{ Text: '第三轮完成' }], tool_results: {} } }],
    }
    upsert.run('t-1', null, 'Demo', '2026-01-01T00:02:00Z', '/tmp/project', encode(thirdTurn))
    await watchTick(ctx)
    assert.equal(readPending()['t-1'].text, '第三轮完成')

    upsert.run('t-1', null, 'Demo', '2026-01-01T00:02:10Z', '/tmp/project', encode({
      messages: [...thirdTurn.messages, { User: { id: 'u2', content: '下一件事' } }],
    }))
    await watchTick(ctx)
    assert.deepEqual(readPending(), {})
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('zed native-watch: subagent threads and odd message entries are ignored', async () => {
  const dir = makeTmpDir()
  try {
    const dbPath = join(dir, 'threads.db')
    const db = new DatabaseSync(dbPath)
    db.exec('create table threads (id text primary key, parent_id text, summary text, updated_at text, folder_paths text, data blob)')
    const upsert = db.prepare('insert or replace into threads (id, parent_id, summary, updated_at, folder_paths, data) values (?, ?, ?, ?, ?, ?)')
    const encode = (thread) => zstdCompressSync(Buffer.from(JSON.stringify(thread), 'utf8'))
    const ctx = {
      dbPath,
      settingsFile: join(dir, 'settings.json'),
      stateDir: join(dir, 'state'),
      intervalMs: 0,
      quietMs: 60000,
      dryRun: false,
      trace: () => {},
      queue: { enqueue: async (fn) => fn() },
      fire: async () => 'focused',
    }
    const readPending = () => JSON.parse(readFileSync(watchStatePath(ctx.stateDir), 'utf8')).pending

    upsert.run('parent', null, 'Parent', '2026-01-01T00:00:00Z', '/tmp/p', encode({ messages: [{ User: { id: 'u1', content: 'go' } }] }))
    await watchTick(ctx)

    // 子 agent 会话完成不应弹卡。
    upsert.run('child', 'parent', 'Sub', '2026-01-01T00:00:05Z', '/tmp/p', encode({
      messages: [
        { User: { id: 's1', content: 'sub' } },
        { Agent: { content: [{ Thinking: { text: '想' } }, { Text: '子任务完成' }], tool_results: {} } },
      ],
    }))
    await watchTick(ctx)
    assert.deepEqual(readPending(), {})

    // messages 里可能混入字符串项（Zed 会写 "Resume"），不能因此报错。
    const withResume = {
      model: { provider: 'rimbot', model: 'Flash' },
      messages: [
        { User: { id: 'u1', content: 'go' } },
        'Resume',
        { Agent: { content: [{ Text: '混入脏项也正常' }], tool_results: {} } },
      ],
    }
    upsert.run('parent', null, 'Parent', '2026-01-01T00:00:10Z', '/tmp/p', encode(withResume))
    await watchTick(ctx)
    assert.equal(readPending().parent.text, '混入脏项也正常')
    assert.equal(readPending().parent.agent, 'rimbot/Flash')

    // 最后一条是 Compaction 时不视为回合完成。
    upsert.run('parent', null, 'Parent', '2026-01-01T00:00:15Z', '/tmp/p', encode({
      messages: [...withResume.messages, { Compaction: {} }],
    }))
    await watchTick(ctx)
    assert.deepEqual(readPending(), {})
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('zed native-watch: agent label covers native and external ACP threads', () => {
  assert.equal(describeAgent({ model: { provider: 'rimbot', model: 'Flash' } }), 'rimbot/Flash')
  assert.equal(describeAgent({ model: { provider: 'acp:antigravity-acp', model: 'gemini' } }), 'acp:antigravity-acp/gemini')
  assert.equal(describeAgent({ model: { provider: 'claude-code' } }), 'claude-code')
  // 外部 Agent 的会话可能没有 model 字段。
  assert.equal(describeAgent({ model: null }), '')
  assert.equal(describeAgent({}), '')
  assert.equal(describeAgent(null), '')
})

test('zed native-watch: window-level focus decision', () => {
  // 宿主不在前台：不跳过。
  assert.equal(shouldSkipForFocus({ probe: { hostFrontmost: false, matched: true } }), false)
  // 宿主在前台且前台窗口就是该会话窗口：跳过。
  assert.equal(shouldSkipForFocus({ probe: { hostFrontmost: true, matched: true } }), true)
  // 宿主在前台，但被同一 App 的另一个窗口盖住：照常弹卡。
  assert.equal(shouldSkipForFocus({ probe: { hostFrontmost: true, matched: false } }), false)
  // 拿不到窗口标题（无辅助功能权限）：退化为 App 级判断。
  assert.equal(shouldSkipForFocus({ probe: { hostFrontmost: true } }), true)
  // 探测失败：失败开放，宁可多弹一次。
  assert.equal(shouldSkipForFocus({ probe: undefined }), false)
  // 用户显式关闭 skipWhenHostFocused：一律不跳过。
  assert.equal(shouldSkipForFocus({ skipWhenHostFocused: false, probe: { hostFrontmost: true, matched: true } }), false)
})

test('dsh: completion card queues follow-up on the agent handle', () => {
  const payload = buildCompletePayload({
    host: 'dsh',
    hostLabel: 'DSH',
    title: 'Demo',
    settings: DEFAULT_SETTINGS,
    allowFollowUp: true,
  })
  assert.equal(payload.groups[0]?.id, 'followup')
  assert.equal(payload.groups[0]?.input, true)
  assert.equal(payload.submitWhenTyped, '发送到 DSH')

  const calls = []
  const agent = { followup: (input) => calls.push(input) }
  assert.equal(dshAdapter.sendFollowUp(agent, '  继续看看测试  '), true)
  assert.deepEqual(calls, [{ content: [{ type: 'text', text: '继续看看测试' }], source: { kind: 'user' } }])

  // 空白输入不投递。
  assert.equal(dshAdapter.sendFollowUp(agent, '   '), false)
  assert.equal(calls.length, 1)

  // 句柄不支持 followup 时返回 false，调用方回退为激活窗口。
  assert.equal(dshAdapter.sendFollowUp({}, 'x'), false)
  assert.equal(dshAdapter.sendFollowUp(null, 'x'), false)
})

test('protocol: follow-up support follows the host capability', () => {
  assert.equal(supportsFollowUp('dsh'), true)
  assert.equal(supportsFollowUp('antigravity', {}), true)
  assert.equal(supportsFollowUp('antigravity', { allowQuickFollowUp: false }), false)
  assert.equal(supportsFollowUp('zed'), false)
  assert.equal(supportsFollowUp(undefined), false)

  // 「回到 X」测试卡与真实完成卡保持一致。
  const dshTest = buildReturnTestPayload({ host: 'dsh', hostLabel: 'DSH', settings: DEFAULT_SETTINGS })
  assert.equal(dshTest.groups[0]?.id, 'followup')
  assert.equal(dshTest.submitWhenTyped, '发送到 DSH')

  const agTest = buildReturnTestPayload({ host: 'antigravity', hostLabel: 'Antigravity', settings: DEFAULT_SETTINGS })
  assert.equal(agTest.groups[0]?.id, 'followup')

  const agNoFollow = buildReturnTestPayload({
    host: 'antigravity',
    hostLabel: 'Antigravity',
    settings: { ...DEFAULT_SETTINGS, allowQuickFollowUp: false },
  })
  assert.deepEqual(agNoFollow.groups, [])
  assert.equal(agNoFollow.submitWhenTyped, undefined)

  // Zed 原生 agent 没有注入通道，测试卡不带输入框。
  const zedTest = buildReturnTestPayload({ host: 'zed', hostLabel: 'Zed', settings: DEFAULT_SETTINGS })
  assert.deepEqual(zedTest.groups, [])
})
