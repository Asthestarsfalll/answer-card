# dsh-answer-card

[![license: MIT](https://img.shields.io/badge/license-MIT-4D6BFE.svg)](LICENSE)
[![platform: macOS](https://img.shields.io/badge/platform-macOS-000000.svg)](#环境要求)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A50.2.0-4D6BFE.svg)](https://github.com/deepseek-ai)

**macOS 屏幕悬浮卡片：DeepSeek Harness 需要你批准、回答或收尾时，把决定本身搬到屏幕上——点选项就等于在 DSH 里作答，不用切窗口。**

A macOS floating card for DeepSeek Harness. When a session asks for approval, waits for an answer, or finishes a turn, a topmost card appears wherever you are — clicking an option resolves it in DSH directly.

```
┌────────────────────────────────────────┐
│ DeepSeek Harness · 正在等你             │
│ 给插件加一个 macOS 悬浮窗               │
│ 模型在等你选一个方向                    │
│                                        │
│ ┌────────────────────────────────────┐ │
│ │ 直接代我作答  点了就等于已回答        │ │
│ ├────────────────────────────────────┤ │
│ │ 只把 DSH 切到前台  仍需自己点        │ │
│ └────────────────────────────────────┘ │
│ [ 稍后处理 ]              [ 提交答案 ]  │
└────────────────────────────────────────┘
```

## 目录

- [为什么需要它](#为什么需要它)
- [功能](#功能)
- [安装](#安装)
- [使用](#使用)
- [设置页](#设置页)
- [配置](#配置)
- [它是怎么工作的](#它是怎么工作的)
- [权限与安全](#权限与安全)
- [限制](#限制)
- [排障](#排障)
- [开发](#开发)
- [许可](#许可)

## 为什么需要它

DSH 自带审批条和提问卡片，但它们只存在于 DSH 窗口里。你在别的应用里写代码、看网页时，agent 停下来等你，你根本不知道。

系统通知能提醒你，但点不了选项——macOS 的网页通知不支持自定义按钮，点一下只能把应用拉到前台。`dsh-popup-cards` 这类插件同理：只能提醒，还得切回 DSH 再点一次。

这个插件把**决定本身**搬出来：

| 别的方案 | 你还要做的事 |
| --- | --- |
| 系统通知横幅 | 切回 DSH → 找到那张卡 → 点选项 |
| 仅提醒类插件（如 `dsh-popup-cards`） | 同上，而且它只支持 Windows |
| **dsh-answer-card** | 直接在卡片上点，DSH 里的卡片随之消失 |

## 功能

- ✅ **审批代答**：工具要权限时弹卡，点「允许一次」就真的放行，点「拒绝」就真的拒绝（返回 `allowed-once` / `rejected`）。
- ✅ **提问作答**：模型提问、计划待审时弹卡，单选点一下、多选勾完提交、无选项时给输入框，答案直接交回工具调用。
- ✅ **完成提醒**：「本轮已完成」卡片，一个按钮回到 DSH——跨桌面（Space）、跨 workspace、并把光标放回输入框。
- ✅ **不打扰前台**：只在你不在 DSH 时才弹；你正盯着 DSH 时，它自己已经有卡片了。
- ✅ **设置页**：弹出时机、出现位置（含**光标附近**）、宽度、字号、主色、自动关闭、提示音，改完立刻生效。
- ✅ **失败开放**：助手崩了、判断不出前台，都不会卡住 agent 回合——最坏情况是退回 DSH 自己的卡片。

## 安装

### 环境要求

- **macOS 13 或更新**（窗口是 AppKit，仅 macOS）。
- **Xcode Command Line Tools**（提供 `swiftc`，用于首次编译助手）。没有的话执行 `xcode-select --install`。
- **DeepSeek Harness ≥ 0.2.0**（需要 `webServer` 与 settings slot；没有网页服务时卡片照常工作，只是没有设置页）。

### 方式一：桌面端（推荐）

设置 → 插件 → 安装，粘贴仓库地址：

```
https://github.com/Asthestarsfalll/dsh-answer-card
```

或填本地目录（`git clone` 之后）：

```
file:/path/to/dsh-answer-card
```

### 方式二：命令行

```sh
dsh plugin --profile desktop add file:/path/to/dsh-answer-card
```

装完由插件自带的 `cordis.patch.yml` 自动插入 loader 行，不需要改 profile。

> 首次触发时会把 Swift 助手编译到 `~/Library/Caches/dsh-answer-card/PromptWindow-<hash>`（约 1–3 秒），之后复用；改了 `helper/PromptWindow.swift` 会自动按新哈希重编。

## 使用

| 时刻 | 卡片内容 | 你点了之后 |
| --- | --- | --- |
| 工具要权限（`approval/request`） | 工具名 + 请求理由，选项「允许一次 / 拒绝」 | 返回 `allowed-once` / `rejected`，等于在 DSH 审批条上点 |
| 模型提问 / 计划待审（`user-questions/request`） | 会话标题 + 题干 + 选项（支持多选与自由输入） | 答案交回工具调用，客户端卡片随之消失 |
| 一轮跑完（`agent/status` running→idle） | 「本轮已完成」 | 「回到 DSH」把窗口拉到你当前桌面、打开该会话，并把鼠标指针挪到输入框附近 |

**「稍后处理」不会替你决定**：卡片关掉，决定权原样交回 DSH 里的卡片，工具继续等。

## 设置页

重启后在 **设置 → 回答卡片** 里改，改一项存一项（写入 `$DSH_HOME/dsh-answer-card.json`，没设 `DSH_HOME` 就是 `~/.dsh/dsh-answer-card.json`）：

| 分组 | 项 |
| --- | --- |
| 弹出时机 | 审批请求 / 模型提问 / 任务完成 / 只在 DSH 不在前台时 |
| 外观 | 出现位置（中央、四角、上下居中、**光标附近**）、宽度 320–720pt、字号 70%–180%、主色 |
| 行为 | 自动关闭毫秒数（0 = 一直等）、提示音、**回到 DSH 时移动鼠标指针**、**回到 DSH 的自定义命令**、完成提醒最小间隔 |
| 例外 | 用下拉框把**工作区目录**或**会话**加入排除名单；已排除的条目列在下方，点 × 移出 |
| 自检 | 「发送测试卡片」按当前设置弹一张提问卡；「测试『回到 DSH』」弹一张完成卡，点了就走真实的返回流程（自定义命令或默认行为） |

合并顺序是 **默认值 → `cordis.patch.yml` → 设置文件**，设置页改过的值优先；想回到 patch 里的值，删掉 JSON 里对应的键即可。

### 自定义「回到 DSH」

默认点「回到 DSH」会做四件事：`open -b io.dsh.desktop` 激活窗口 → 切到会话所在工作区 → 聚焦输入框 → 把鼠标指针挪过去。

想换成自己的流程（打开别的客户端、跑一段脚本、走 URL scheme），在 **设置 → 回答卡片 → 行为 → 回到 DSH 的命令** 里填一条命令即可：

```sh
# 例：只把 DSH 叫起来，不做跳会话
open -a "DSH Desktop"

# 例：交给自己的脚本
/usr/local/bin/bring-dsh-back
```

- **留空 = 默认行为**，一个字都不用改；
- 填了之后，这条命令**替代**上面那四步（不再 `open -b`、不再跳会话、不再挪指针），避免两套动作互相打架；
- 命令经 `/bin/sh` 执行，**以你的用户权限运行**，环境变量继承 DSH 的；
- 设置接口只接受本机来源（跨站请求 403），但能打开设置页的人本来就能读写你 profile 里的文件，所以在里面填命令不算额外信任边界。

### 例外：哪些工作区 / 会话不弹

设置页「例外」有两个下拉框，候选是**最近弹过卡的会话和目录**（宿主每次触发前顺手记一笔，只存会话 id、标题、目录和时间，最多 60 条，落在 `$DSH_HOME/dsh-answer-card-recent.json`）。选中点「加入排除」即静音；已排除的条目按分组列在下方并带计数，点 × 移出：

- **工作区**按 `session.header.cwd` **精确匹配**；以 `/` 结尾的条目按前缀匹配（例如 `/Users/me/work/` 覆盖整个目录树，不会误伤 `/Users/me/workshop`）。这样的前缀条目可以直接写进设置文件，下拉框只负责精确目录。
- **会话**按 `session.id` 精确匹配。
- 静音只影响「弹不弹卡」，`approval/request` 与 `user-questions/request` 照常往下走，由 DSH 自己的卡片处理，工具不会卡住。

这两组值就是设置文件里的 `mutedWorkspaces` / `mutedSessions`，也可以直接写进 `cordis.patch.yml`。

## 配置

设置页覆盖不到的部分（以及无界面部署）写在 profile 的 `cordis.patch.yml`；config 是整体替换，想保留默认值的键要一起写：

```yaml
- id: answer-card
  config:
    confirmApprovals: true
    answerQuestions: true
    notifyOnComplete: true
    skipWhenDSHFocused: true
    traceFile: /tmp/dsh-answer-card.log
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `confirmApprovals` | `true` | 工具要权限时弹。 |
| `answerQuestions` | `true` | 提问 / 计划待审时弹。 |
| `notifyOnComplete` | `true` | 一轮跑完时弹。 |
| `ignoreSubagents` | `true` | 子 agent、后台委派、workflow worker 不弹。 |
| `skipWhenDSHFocused` | `true` | DSH 在前台时不弹。 |
| `dshBundleIds` | `['io.dsh.desktop']` | 认作「DSH 在前台」的 bundle id。 |
| `dshProcessNames` | `['DeepSeek Harness', 'DSH Desktop']` | 兜底：前台 app 名字含这些词也算。 |
| `autoDismissMs` | `0` | 卡片自动关闭毫秒数；`0` = 一直等你点。 |
| `completeCooldownMs` | `10000` | 同一会话两次「完成」提醒的最小间隔。 |
| `returnCommand` | `''` | 「回到 DSH」执行的自定义命令；留空走默认链路。 |
| `settingsFile` | `''` | 设置文件路径（默认 `$DSH_HOME/dsh-answer-card.json`）。 |
| `mutedWorkspaces` | `[]` | 不弹卡的目录；末尾带 `/` 表示前缀匹配。 |
| `mutedSessions` | `[]` | 不弹卡的会话 id。 |
| `helperPath` | `''` | 自定义助手路径（默认用缓存里按源码哈希命名的编译产物）。 |
| `traceFile` | `''` | 诊断日志；排查「到底有没有触发」时填一个路径。 |

## 它是怎么工作的

```
                 ┌──────────────────────────────┐
 approval/request│  Node 侧（lib/index.mjs）      │
 user-questions ─┤  · 两个 waterfall 都 prepend  │
 agent/status    │  · 同一时刻只弹一张，其余排队  │
                 └──────────────┬───────────────┘
                                │ JSON 载荷（stdin）
                 ┌──────────────▼───────────────┐
                 │  Swift 助手（AppKit）         │
                 │  · 无边框 / 置顶 / 可点       │
                 │  · 位置、宽度、字号、主色     │
                 └──────────────┬───────────────┘
                                │ 一行 JSON（stdout）
                 ┌──────────────▼───────────────┐
                 │  结论交回 waterfall：          │
                 │  allowed-once / rejected      │
                 │  或 { answers: [...] }        │
                 └──────────────────────────────┘
```

- **两个 `waterfall` 都用 `prepend`**：抢在客户端 UI 前面，所以点卡片和点 DSH 里的卡片等价；点「稍后处理」`next()` 交回去，行为完全不变。
- **独立进程**：助手跑在 `swiftc` 编译出的可执行文件里，挂着的请求不会卡住 Node 事件循环；宿主只等它的 stdout。
- **「回到 DSH」三步**：先激活窗口、再跳会话、最后把光标放回输入框；跨屏时连鼠标指针一起挪过去（可在设置里关）。实现上：先 `open -b io.dsh.desktop` 让 Electron 自己 `restore → show → focus`（顺带取消最小化），再调助手 `--activate` 用 `NSRunningApplication.activate()` 把窗口拉到你当前所在的 Space；跨 workspace 则由宿主交出 `sessionId`（60 秒有效），客户端轮询 `/dsh-answer-card/focus` 后调 `uiWorkspace.openSession(id)` 跳过去，最后把光标放回输入框。
- **助手还带 `--probe`**：只报当前前台 app 的 bundle id 与名字，用来判断 DSH 是否在前台。

## 权限与安全

- **不联网**：插件和助手都不发任何外部请求；设置页的两个接口只接受本机来源，有宿主 `connection` 服务时以它为准，跨站请求直接 403。
- **点「允许一次」= 真实授权**：卡片不会「先记下再问你」，它就是那个审批评审点，DSH 里不会再有第二次确认。
- **失败开放**：助手起不来、JSON 解析失败、前台判断出错，一律退回 DSH 原生卡片，不会把审批吞掉或替你做决定。
- **不读取会话内容**：卡片只显示会话标题、工具名与提问文本；不写日志正文（`traceFile` 只有事件类型与会话 id）。

## 限制

- **只支持 macOS**：窗口是 AppKit，靠系统自带 `swiftc` 编译；其它平台插件会正常加载但什么都不弹。
- **不能撤销**：点「允许一次」就是真的放行。
- **前台判断是启发式**：只看「当前前台 app 是不是 DSH」。DSH 开在浏览器标签里时，浏览器在前台会被当成 DSH 而静音——这种情况把 `skipWhenDSHFocused` 设为 `false`。
- **一次一张**：并发的多个请求会排队，前一张关掉才弹下一张。
- **跨 workspace 依赖内部服务**：`uiWorkspace.openSession` 没有对外承诺；拿不到时静默降级为「只把窗口拉到前台」。

## 排障

| 现象 | 检查 |
| --- | --- |
| 设置里没有「回答卡片」 | 插件版本没进 generation 快照。`remove_bundle` 后 `install_bundle` 重装，再重启 DSH。 |
| 完全不弹 | 在 `cordis.patch.yml` 里设 `traceFile: /tmp/dsh-answer-card.log`，看是「没触发」「被前台抑制」还是「助手起不来」。 |
| 弹的位置不对 | 多显示器时按鼠标所在屏幕摆位；`traceFile` 里会记录 `place: pos=… mouse=… origin=…`。 |
| 首次弹卡很慢 | 在等 `swiftc` 编译（1–3 秒），之后走缓存；编译失败会写进 trace。 |
| 回车键无效 | 卡片本身不抢焦点，点击按钮即可；`Esc` = 稍后处理。 |

## 开发

```sh
# 语法检查
node --check lib/index.mjs && node --check lib/client.js

# 单独试卡片（不需要 DSH）：先编译，再喂一份载荷
swiftc -O -o /tmp/PromptWindow helper/PromptWindow.swift -framework AppKit
/tmp/PromptWindow <<'JSON'
{"kind":"question","title":"示例","groups":[{"id":"q0","text":"要选哪个？","choices":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}],"submit":"提交","dismiss":"稍后处理"}
JSON
```

> **改完源码必须重装**：桌面端把插件**拷进** generation 快照（`profiles/.generations/live/<pkg>+<ver>+<hash>/`），`node_modules` 只是软链。只改源码不重装，重启后跑的还是旧代码。

## 许可

[MIT](LICENSE) © 2026 Asthestarsfalll
