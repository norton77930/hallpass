<#
.SYNOPSIS
  移除 Hallpass(瀏覽器代理橋接)的 native host(QA 安裝包版)。

.DESCRIPTION
  刪除 install.ps1 寫入的 HKCU 登錄值、host manifest 與啟動器。若 install.ps1 當時備份了既有的
  manifest(.bak),會把它放回去並重新註冊,讓先前的安裝(例如 repo 的開發安裝)恢復可用。
  側欄對話留下的檔案(conversations.json、folders.json、agents\、brokers\、broker.log、conversation-consent\)
  一律刪除;暫存資料夾 scratch\ 裡可能有你要的檔案,一律保留(連 -Purge 也不刪),並告訴你它在哪裡。
  config.json(上傳白名單)保留,除非加 -Purge。不需要系統管理員權限。

.PARAMETER Purge
  連同 %LOCALAPPDATA%\hallpass\ 裡的 config.json、配對身分(agent-id)、bridge.json、relay.log 一起刪除
  (scratch\ 除外)。若有還原備份,只刪 config.json,其餘留給還原的安裝使用。

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
# 還原備份時要重新指回的登錄值:安裝程式登記的每一個瀏覽器都要列在這裡(與 install\windows.ts 的
# NATIVE_MESSAGING_ROOTS 同一份清單,contract 測試會核對)。
$registryKeys = @(
  "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hallpass.host",
  "HKCU\Software\Chromium\NativeMessagingHosts\com.hallpass.host",
  "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.hallpass.host",
  "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.hallpass.host"
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

# ---- 側欄對話留下的檔案(019) -----------------------------------------------------------------
# 只有索引、資料夾清單、下載的 adapter、broker 的 sidecar 與記錄;Hallpass 不保存對話內容。
# 對話正在進行時 Chrome 可能還握著其中的檔案,刪不掉就提醒,不中斷移除。
$conversationItems = @("conversations.json", "folders.json", "agents", "brokers", "broker.log", "broker.log.1", "conversation-consent")
foreach ($name in $conversationItems) {
  $item = Join-Path $dataDir $name
  if (Test-Path -LiteralPath $item) {
    try {
      Remove-Item -LiteralPath $item -Recurse -Force -ErrorAction Stop
      Write-Host "已刪除 $item"
    } catch {
      Write-Host "無法刪除 ${item}:$($_.Exception.Message)(請關閉 Chrome 後再執行一次 uninstall.ps1)" -ForegroundColor Yellow
    }
  }
}
# scratch\ 是側欄對話的暫存工作資料夾,裡面可能有 agent 替你寫的檔案:不刪,只告訴你在哪。
$scratchDir = Join-Path $dataDir "scratch"
$keptScratch = Test-Path -LiteralPath $scratchDir

# ---- -Purge ------------------------------------------------------------------------------------
if ($Purge) {
  if ($restored) {
    Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
    Write-Host "已刪除 $configPath(其餘檔案留給還原的安裝使用)"
  } elseif (Test-Path -LiteralPath $dataDir) {
    # 一個一個刪:Chrome 還開著時 relay.log、bridge.json 可能被握著,刪不掉就提醒,不中斷移除。
    $purgeFailed = $false
    $purgeItems = @(Get-ChildItem -LiteralPath $dataDir -Force | Where-Object { $_.Name -ne "scratch" })
    foreach ($child in $purgeItems) {
      try {
        Remove-Item -LiteralPath $child.FullName -Recurse -Force -ErrorAction Stop
      } catch {
        $purgeFailed = $true
        Write-Host "無法刪除 $($child.FullName):$($_.Exception.Message)(請關閉 Chrome 後再執行一次 uninstall.ps1 -Purge)" -ForegroundColor Yellow
      }
    }
    # 資料夾本身只在已經空了才刪(不遞迴),所以 scratch\ 無論如何都不會被刪。
    if (-not $purgeFailed -and @(Get-ChildItem -LiteralPath $dataDir -Force).Count -eq 0) {
      try {
        Remove-Item -LiteralPath $dataDir -Force -ErrorAction Stop
      } catch {
        $purgeFailed = $true
        Write-Host "無法刪除 ${dataDir}:$($_.Exception.Message)" -ForegroundColor Yellow
      }
    }
    if ($purgeFailed) {
      Write-Host "已刪除 $dataDir 裡能刪的檔案;上面列出的沒有刪掉" -ForegroundColor Yellow
    } elseif ($keptScratch) {
      Write-Host "已刪除 $dataDir 裡除了 scratch 以外的所有檔案"
    } else {
      Write-Host "已刪除 $dataDir"
    }
  }
} else {
  Write-Host "保留 $configPath(要一併刪除請加 -Purge)"
}

if ($keptScratch) {
  Write-Host "保留 $scratchDir(側欄對話的暫存資料夾,沒有刪除;不再需要時請自行刪除)"
}

Write-Host ""
Write-Host "移除完成。" -ForegroundColor Green
Write-Host "還要手動做的兩件事:"
Write-Host "  1) Chrome 開 chrome://extensions,移除「Hallpass」(ID adgpccmmbgnchnphfaoabfflfcepbopd)。"
Write-Host "  2) 從你的 MCP client 設定移除 hallpass(Claude Code:claude mcp remove hallpass --scope user;"
Write-Host "     其他 client 見 README.md 的表格)。"
exit 0
