<#
.SYNOPSIS
  移除 Hallpass(瀏覽器代理橋接)的 native host(QA 安裝包版)。

.DESCRIPTION
  刪除 install.ps1 寫入的 HKCU 登錄值、host manifest 與啟動器。若 install.ps1 當時備份了既有的
  manifest(.bak),會把它放回去並重新註冊,讓先前的安裝(例如 repo 的開發安裝)恢復可用。
  config.json(上傳白名單)保留,除非加 -Purge。不需要系統管理員權限。

.PARAMETER Purge
  連同 %LOCALAPPDATA%\hallpass\ 裡的 config.json、配對身分(agent-id)、bridge.json、relay.log 一起刪除。
  若有還原備份,只刪 config.json,其餘留給還原的安裝使用。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Purge
#>
[CmdletBinding()]
param(
  [switch]$Purge
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$hostDir      = Join-Path $PSScriptRoot "host"
$installer    = Join-Path $hostDir "install.js"
$dataDir      = Join-Path $env:LOCALAPPDATA "hallpass"
$manifestPath = Join-Path $dataDir "com.hallpass.host.json"
$launcherPath = Join-Path $dataDir "native-host.cmd"
$configPath   = Join-Path $dataDir "config.json"
$registryKeys = @(
  "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hallpass.host",
  "HKCU\Software\Chromium\NativeMessagingHosts\com.hallpass.host"
)

if (-not (Test-Path -LiteralPath $installer)) {
  Write-Host "找不到 $installer。請從解壓縮出來的安裝包資料夾執行 uninstall.ps1。" -ForegroundColor Red
  exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "找不到 node;無法執行 host\install.js uninstall。" -ForegroundColor Red
  exit 1
}

# ---- 移除登錄值、manifest、啟動器 ------------------------------------------------------------
& node "$installer" uninstall
if ($LASTEXITCODE -ne 0) {
  Write-Host "host 移除失敗(node host\install.js uninstall 回傳 $LASTEXITCODE)。" -ForegroundColor Red
  exit $LASTEXITCODE
}

# ---- 還原 install.ps1 備份的既有安裝 -------------------------------------------------------------
$restored = $false
if (Test-Path -LiteralPath "$manifestPath.bak") {
  Move-Item -LiteralPath "$manifestPath.bak" -Destination $manifestPath -Force
  if (Test-Path -LiteralPath "$launcherPath.bak") {
    Move-Item -LiteralPath "$launcherPath.bak" -Destination $launcherPath -Force
  }
  foreach ($key in $registryKeys) {
    & reg add $key /ve /t REG_SZ /d "$manifestPath" /f | Out-Null
  }
  $restored = $true
  Write-Host "已還原先前的 host manifest:$manifestPath(登錄值已重新指向它)"
}

# ---- -Purge ------------------------------------------------------------------------------------
if ($Purge) {
  if ($restored) {
    Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
    Write-Host "已刪除 $configPath(其餘檔案留給還原的安裝使用)"
  } elseif (Test-Path -LiteralPath $dataDir) {
    Remove-Item -LiteralPath $dataDir -Recurse -Force
    Write-Host "已刪除 $dataDir"
  }
} else {
  Write-Host "保留 $configPath(要一併刪除請加 -Purge)"
}

Write-Host ""
Write-Host "移除完成。" -ForegroundColor Green
Write-Host "還要手動做的兩件事:"
Write-Host "  1) Chrome 開 chrome://extensions,移除「Hallpass」(ID adgpccmmbgnchnphfaoabfflfcepbopd)。"
Write-Host "  2) 從你的 MCP client 設定移除 hallpass(Claude Code:claude mcp remove hallpass --scope user;"
Write-Host "     其他 client 見 README.md 的表格)。"
exit 0
