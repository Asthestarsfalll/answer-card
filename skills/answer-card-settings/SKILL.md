---
name: answer-card-settings
description: Configure, test, mute/unmute, or troubleshoot the macOS Answer Card floating window plugin (appearance, position, approval policy, return command, muted workspaces/sessions, and self-test cards).
---

# Answer Card Settings & Diagnostics

## Preferred: Open the Visual Settings Panel

This plugin ships an interactive MCP App (`open_answer_card_settings` on server `answer-card_settings`) mounted in both the left sidebar (**Answer Card**) and the side pane `+` menu. When the user asks to open or view settings, call `open_answer_card_settings` (optionally passing `host: "antigravity" | "dsh" | "zed"`) so the interactive UI opens directly in the side pane.

## CLI Fallback

Use the bundled CLI (`core/cli.mjs` inside this plugin directory) to inspect or update settings, manage muted workspaces/sessions, or send test cards from the terminal.

## Locate the CLI

The plugin directory is usually `~/.gemini/config/plugins/answer-card` (or the directory containing this skill, two levels up from `skills/answer-card-settings/`). Run commands with `node <plugin_dir>/core/cli.mjs ...`.

## Common Operations

### View current settings and options
```bash
node <plugin_dir>/core/cli.mjs status --host antigravity
```

### Update a setting
Settings are stored in `~/.config/answer-card/settings.json` (shared across Antigravity, DSH, and Zed, with optional per-host overrides when `--host <name>` is passed; pass `--global` to update shared defaults).

```bash
# Appearance
node <plugin_dir>/core/cli.mjs set position cursor --global
node <plugin_dir>/core/cli.mjs set width 500 --global
node <plugin_dir>/core/cli.mjs set fontScale 1.1 --global
node <plugin_dir>/core/cli.mjs set accent '#4D6BFE' --global

# Timing & behavior
node <plugin_dir>/core/cli.mjs set confirmApprovals true --host antigravity
node <plugin_dir>/core/cli.mjs set answerQuestions true --host antigravity
node <plugin_dir>/core/cli.mjs set notifyOnComplete true --host antigravity
node <plugin_dir>/core/cli.mjs set skipWhenHostFocused true --global
node <plugin_dir>/core/cli.mjs set sound true --global
node <plugin_dir>/core/cli.mjs set warpPointer true --global
node <plugin_dir>/core/cli.mjs set autoDismissMs 0 --global
node <plugin_dir>/core/cli.mjs set completeCooldownMs 10000 --global
node <plugin_dir>/core/cli.mjs set allowQuickFollowUp true --host antigravity

# Antigravity approval policy: external | commands | mutating | all
node <plugin_dir>/core/cli.mjs set approvalPolicy commands --host antigravity

# Custom return command (empty string restores default window activation)
node <plugin_dir>/core/cli.mjs set returnCommand 'open -a Antigravity' --host antigravity

# Diagnostics trace log
node <plugin_dir>/core/cli.mjs set traceFile /tmp/answer-card.log --host antigravity
```

Valid positions: `center`, `top-center`, `bottom-center`, `top-right`, `bottom-right`, `top-left`, `bottom-left`, `cursor`.

### Mute / unmute workspaces or sessions
```bash
# Exact directory match; trailing "/" mutes the entire subtree
node <plugin_dir>/core/cli.mjs mute-workspace /path/to/workspace --host antigravity
node <plugin_dir>/core/cli.mjs unmute-workspace /path/to/workspace --host antigravity

# Session / conversation ID
node <plugin_dir>/core/cli.mjs mute-session <conversationId> --host antigravity
node <plugin_dir>/core/cli.mjs unmute-session <conversationId> --host antigravity

# List recently triggered sessions and workspaces
node <plugin_dir>/core/cli.mjs recent --host antigravity
```

### Send self-test cards or probe frontmost app
```bash
node <plugin_dir>/core/cli.mjs test --host antigravity
node <plugin_dir>/core/cli.mjs test-return --host antigravity
node <plugin_dir>/core/cli.mjs probe
```
