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

## 主题与设置

- **主题自适应**：自动读取 `~/.config/zed/settings.json` 与已安装的 Zed 扩展主题（`~/Library/Application Support/Zed/extensions/installed/*/themes/*.json`、`~/.config/zed/themes/*.json`），随亮/暗外观实时匹配。
- **共享与独立设置**：与 Antigravity / DSH 共用 `~/.config/answer-card/settings.json`，可在 Antigravity / DSH 设置页的 **Zed** 标签页或通过 `node core/cli.mjs --host zed` 单独调整。
