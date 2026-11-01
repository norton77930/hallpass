#!/bin/sh
# Hallpass native host removal on macOS and Linux (spec 028). Removes the launcher, the host manifest
# and each browser's registration (and the Hallpass skill unless you changed it). Keeps config.json
# (your upload folders) unless --purge, which removes the whole data folder.
#
#   sh ./uninstall.sh
#   sh ./uninstall.sh --purge
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
INSTALLER="$DIR/host/install.js"
if [ ! -f "$INSTALLER" ]; then
  echo "找不到 $INSTALLER。請從解壓縮出來的安裝包資料夾執行 uninstall.sh。" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node；無法執行 host/install.js uninstall。" >&2
  exit 1
fi
node "$INSTALLER" uninstall

if [ "${1:-}" = "--purge" ]; then
  # The data folder, derived as the host derives it (host-paths.ts, 028 FR-433).
  if [ -n "${LOCALAPPDATA:-}" ]; then
    DATA_DIR="$LOCALAPPDATA/hallpass"
  elif [ "$(uname -s)" = "Darwin" ]; then
    DATA_DIR="$HOME/Library/Application Support/hallpass"
  else
    DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/hallpass"
  fi
  rm -rf "$DATA_DIR"
  echo "已刪除 $DATA_DIR（含 config.json）。"
else
  echo "config.json（上傳資料夾清單）保留；要一併刪除請加上 --purge。"
fi
exit 0
