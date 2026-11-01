#!/bin/sh
# Hallpass native host install for this user on macOS and Linux (spec 028, issue #1). No sudo needed.
# Writes the host files into the per-user data folder and the host manifest into each installed
# browser's native-messaging folder (Chrome, Chromium, Edge, Brave), then prints the MCP server
# definition to add to your coding agent. Run it again at any time; it rewrites the same files.
#
#   sh ./install.sh
#   sh ./install.sh --register claude-code    # also runs `claude mcp add` when claude is on PATH
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
HOST_DIR="$DIR/host"
INSTALLER="$HOST_DIR/install.js"
SERVER="$HOST_DIR/mcp-server.js"
EXTENSION_DIR="$DIR/extension"

for required in "$INSTALLER" "$HOST_DIR/native-host.js" "$SERVER" "$EXTENSION_DIR/manifest.json"; do
  if [ ! -f "$required" ]; then
    echo "找不到 $required。請把 zip 完整解壓縮後，從解壓縮出來的資料夾執行 install.sh。" >&2
    exit 1
  fi
done

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node。請先安裝 Node.js 24（https://nodejs.org/），重開終端機後再執行一次。" >&2
  exit 1
fi
NODE_VERSION=$(node -v)
NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | sed -E 's/^v?([0-9]+).*/\1/')
case "$NODE_MAJOR" in ''|*[!0-9]*) NODE_MAJOR=0 ;; esac
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "Node 版本太舊：$NODE_VERSION（需要 24 以上）。請升級 Node.js 後再執行一次。" >&2
  exit 1
fi
echo "Node $NODE_VERSION（$(command -v node)）"

if ! node "$INSTALLER" install; then
  echo "host 安裝失敗（node host/install.js install）。" >&2
  exit 1
fi

# The server path as a JSON string: a backslash or a quote in it is escaped.
SERVER_JSON=$(printf '%s' "$SERVER" | sed 's/\\/\\\\/g; s/"/\\"/g')
DEFINITION="{ \"command\": \"node\", \"args\": [\"$SERVER_JSON\"] }"

echo ""
echo "安裝完成。"
echo ""
echo "1) 在 Chrome 載入擴充功能：chrome://extensions → 開發人員模式 → 載入未封裝項目 →"
echo "   $EXTENSION_DIR"
echo "   （ID 應為 adgpccmmbgnchnphfaoabfflfcepbopd）"
echo ""
echo "2) 把這個 MCP server 加進你用的 client（README.md 有各 client 的位置）："
echo "   $DEFINITION"
echo "   Claude Code 一行版："
echo "   claude mcp add hallpass --scope user -- node \"$SERVER\""
echo ""
echo "側欄對話目前只支援 Windows；在這台電腦上，Hallpass 提供給你的程式代理使用。"

if [ "${1:-}" = "--register" ] && [ "${2:-}" = "claude-code" ]; then
  echo ""
  if command -v claude >/dev/null 2>&1; then
    echo "執行：claude mcp add hallpass --scope user -- node \"$SERVER\""
    claude mcp add hallpass --scope user -- node "$SERVER" || echo "claude mcp add 失敗；請手動執行上面那行。" >&2
  else
    echo "PATH 上找不到 claude；沒有修改任何設定。請自行執行上面那行。" >&2
  fi
fi
exit 0
