# Zed Adapter (`answer-card`)

Zed 与共享核心 `core/` 有两种对接方式，可按需单独或组合启用：

## 1. MCP Server（适用于 Zed 内置 Agent 与所有外部 Agent）

在 `~/.config/zed/settings.json` 的 `context_servers` 与 `agent.tool_permissions.tools` 中加入：

```json
{
  "context_servers": {
    "answer-card": {
      "command": "/path/to/answer-card/adapters/zed/mcp.sh",
      "args": []
    }
  },
  "agent": {
    "tool_permissions": {
      "tools": {
        "mcp:answer-card:answer_card_ask": { "default": "allow" },
        "mcp:answer-card:answer_card_approve": { "default": "allow" },
        "mcp:answer-card:answer_card_notify": { "default": "allow" },
        "mcp:answer-card:answer_card_open_settings": { "default": "allow" },
        "mcp:answer-card:answer_card_settings": { "default": "allow" }
      }
    }
  }
}
```

提供五个工具：
- `answer_card_ask`：弹出悬浮提问卡（单选 / 多选 / 自由输入），直接返回答案。
- `answer_card_approve`：弹出悬浮审批卡（允许一次 / 拒绝 / 拒绝并附替代指令）。
- `answer_card_notify`：弹出任务完成卡，一键切回并拉起对应 Zed 窗口。
- `answer_card_open_settings`：启动本地可视化设置页（复用 `<answer-card-settings>`，自动匹配 Zed 主题）并在浏览器打开。
- `answer_card_settings`：在 Zed 对话中直接读取 / 修改设置或发送测试卡片。

也可以在终端或 Zed Task 中一键打开同一套可视化设置页：

```bash
node /path/to/answer-card/core/cli.mjs ui --host zed
```

## 2. ACP Proxy（适用于 Zed 中的外部 Agent 权限审批拦截）

在 `~/.config/zed/settings.json` 的 `agent_servers` 中用 `acp-proxy.sh` 包装外部 ACP Agent，即可自动拦截 `session/request_permission` 与 `session/prompt` 回合完成：

```json
{
  "agent_servers": {
    "Claude Code (Answer Card)": {
      "type": "custom",
      "command": "/path/to/answer-card/adapters/zed/acp-proxy.sh",
      "args": ["--", "claude-code-acp"]
    }
  }
}
```

## 3. Agent 回合监听（原生 Agent 与外部 ACP Agent 通用）

Zed 没有 agent hook 回调，但每个消息步骤都会把会话写入
`~/Library/Application Support/Zed/threads/threads.db`（zstd 压缩 JSON）。
`native-watch.mjs` 以只读方式轮询该库，在「出现新消息 + 最后一条 Agent 消息以文本收尾 +
没有待回填的工具调用 + 静默期内不再变化」时判定回合结束，由代码直接弹完成卡，Agent 完全无感知。

覆盖范围：

- **Zed 内置 Agent**（如 `provider=rimbot` 等自定义模型）
- **外部 ACP Agent**（`agent_servers` 里的 Claude、Codex、Gemini CLI、Antigravity 等）——
  Zed 用同一份 `DbThread` 落库（见 `crates/agent/src/db.rs`，线程 id 即 ACP `SessionId`），
  因此无需为每个 Agent 单独适配
- **子 Agent 会话**（`parent_id` 非空）默认不弹卡，避免主回合内部步骤反复打扰

```bash
# 排障：只跑一轮、只输出判定、不弹卡
node adapters/zed/native-watch.mjs --once --dry-run
# 观察每次判定（子 Agent 跳过、候选命中、弹卡结果都会打印）
node adapters/zed/native-watch.mjs --verbose
# 前台常驻
node adapters/zed/native-watch.mjs
```

完成卡的副标题会显示来源 Agent（如 `rimbot/Flash`、`claude-code`），便于区分原生与外部 Agent。

需要开机常驻时用 `launchd`（`~/Library/LaunchAgents/com.answer-card.zed-native-watch.plist`）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.answer-card.zed-native-watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/answer-card/adapters/zed/native-watch.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/answer-card-native-watch.log</string>
  <key>StandardErrorPath</key><string>/tmp/answer-card-native-watch.err.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.answer-card.zed-native-watch.plist
launchctl bootout gui/$(id -u)/com.answer-card.zed-native-watch   # 卸载
```

### 多窗口下的窗口定位

点卡片上的「回到 Zed」时，由 helper 通过 Accessibility API 按**窗口标题子串**匹配并置顶对应窗口：

- Zed 窗口标题形如 `RimOrbit — robot_io.py`，因此优先用**项目目录名**匹配（`baseName(cwd)`），会话标题作为次级提示
- 匹配成功会取消最小化、置顶该窗口，并把指针移到窗口内（`warpPointer`）
- 匹配不到时退化为「激活 App + 落到最近使用的窗口」
- 需要为 helper 授予**辅助功能（Accessibility）权限**；未授权时同样只会激活 App

同一项目的多个窗口标题相同，无法进一步区分（取第一个匹配项）。

完成卡仍遵循共享设置里的 `notifyOnComplete`、静音列表、冷却时间与 `skipWhenHostFocused`。
判定只在回合真正结束时发生：那一刻宿主不在前台才弹卡；宿主在前台则直接丢弃，不做延迟补发，
避免对话进行中突然冒出过期卡片。用户发出新消息时残留候选立即作废。

与第 2 节的 ACP Proxy 同时启用时不会重复弹卡：两者共用 `zed:<threadId>` 冷却键，
而 Zed 的线程 id 就是 ACP `SessionId`，先弹的一方会把另一方压掉。

## 主题与设置

- **主题自适应**：自动读取 `~/.config/zed/settings.json` 与已安装的 Zed 扩展主题（`~/Library/Application Support/Zed/extensions/installed/*/themes/*.json`、`~/.config/zed/themes/*.json`），随亮/暗外观实时匹配。
- **共享与独立设置**：与 Antigravity / DSH 共用 `~/.config/answer-card/settings.json`，可在 Antigravity / DSH 设置页的 **Zed** 标签页或通过 `node core/cli.mjs --host zed` 单独调整。
