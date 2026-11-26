#!/bin/sh
# Antigravity GUI 进程启动 hook 时 PATH 通常不含 Homebrew / nvm / volta；
# 这里补齐常见 macOS Node 路径，找不到时失败开放返回 {}，绝不阻塞 Agent。
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.asdf/shims:$HOME/.local/share/mise/shims:$PATH"

if ! command -v node >/dev/null 2>&1; then
  for dir in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.fnm/node-versions/*/installation/bin; do
    if [ -x "$dir/node" ]; then
      export PATH="$dir:$PATH"
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  printf '{"decision":"ask"}\n'
  exit 0
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! node "$SCRIPT_DIR/hook.mjs"; then
  printf '{"decision":"ask"}\n'
  exit 0
fi
