<#
.SYNOPSIS
  008/T234 (b), re-run for 009/T259 - proves the 0.3.0 (Hallpass) package installs over a 0.2.0
  one: the new host is registered under its new name, the earlier version's registration is removed
  by the new installer, and the earlier version's directory is left for the tester (009 FR-126,
  SC-065). The 0.1.x -> 0.2.0 version of this proof asserted a same-directory upgrade; 0.3.0 changes
  the directory, so the assertions changed with it.

.DESCRIPTION
  Extracts the old zip and the new one side by side, runs each package's own install.ps1, and then
  asserts the three facts an upgrading tester depends on:

    1. both installs succeed (exit 0);
    2. the new host manifest and launcher (new name, new directory) point at the *new* package's
       native-host.js, and both registry roots name the new manifest;
    3. the earlier version's registry keys are gone after the new install, while its directory -
       including the config.json the tester filled in - is untouched (the README tells them to
       re-enter upload roots and delete the old directory themselves);
    4. the new package's uninstall removes only the new registration.

  Two rules keep this off the developer's own machine. %LOCALAPPDATA% is repointed at a scratch
  directory for the whole run, so every file the installer writes lands there instead of in the
  owner's hallpass. The HKCU registry values are *not* redirectable that way - the installer
  writes them whatever LOCALAPPDATA says - so they are read before anything runs and written back in
  the finally block, and the restore is verified by reading them again.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\acceptance\upgrade-host-proof.ps1 `
    -OldZip ".\release\hallpass-0.1.1.zip"
#>
[CmdletBinding()]
param(
  [string]$OldZip,
  [string]$NewZip,
  [string]$ScratchRoot = (Join-Path $env:TEMP "hallpass-upgrade")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$legacyPackage = ("poc", "browser", "agent") -join "-"
$legacyHost = ("com", "poc", "agent_host") -join "."
$legacyDirName = ("poc", "agent", "host") -join "-"
if (-not $OldZip) { $OldZip = Join-Path $repoRoot "release\$legacyPackage-0.2.0.zip" }
if (-not $NewZip) { $NewZip = Join-Path $repoRoot "release\hallpass-0.3.0.zip" }

$newKeys = @(
  "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hallpass.host",
  "HKCU\Software\Chromium\NativeMessagingHosts\com.hallpass.host"
)
$legacyKeys = @(
  "HKCU\Software\Google\Chrome\NativeMessagingHosts\$legacyHost",
  "HKCU\Software\Chromium\NativeMessagingHosts\$legacyHost"
)
$registryKeys = $newKeys + $legacyKeys
# A tester who has filled in an upload root; the second install must leave it alone.
$sentinelConfig = '{ "uploadRoots": ["D:\\upgrade-proof-sentinel"] }'

function Assert-That([bool]$condition, [string]$message) {
  if (-not $condition) { throw "ASSERT FAILED: $message" }
}

# The default value of one NativeMessagingHosts key, or $null when the key does not exist.
function Get-RegisteredManifest([string]$key) {
  # reg.exe reports a missing key on stderr; under $ErrorActionPreference = "Stop" PowerShell 5.1 turns
  # a redirected native stderr line into a terminating error, so the query runs with "Continue".
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { $lines = & reg.exe query $key /ve 2>&1 } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { return $null }
  foreach ($line in $lines) {
    if ("$line" -match 'REG_SZ\s+(.+)$') { return $Matches[1].Trim() }
  }
  return $null
}

function Restore-Registry($snapshot) {
  foreach ($key in $registryKeys) {
    $value = $snapshot[$key]
    if ($null -eq $value) {
      & reg.exe delete $key /f 2>$null | Out-Null
    } else {
      & reg.exe add $key /ve /t REG_SZ /d $value /f 2>$null | Out-Null
    }
  }
}

# install.ps1 and uninstall.ps1 end with `exit`, which would take this session with them: each runs
# as its own powershell process, and that process inherits the scratch LOCALAPPDATA set below.
function Invoke-PackageScript([string]$script) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script | Write-Host
  return $LASTEXITCODE
}

Assert-That (Test-Path -LiteralPath $OldZip) "old zip not found: $OldZip"
Assert-That (Test-Path -LiteralPath $NewZip) "new zip not found: $NewZip"

$before = @{}
foreach ($key in $registryKeys) { $before[$key] = Get-RegisteredManifest $key }
Write-Host "captured registry:"
foreach ($key in $registryKeys) { Write-Host "  $key = $($before[$key])" }

$oldDir   = Join-Path $ScratchRoot "old"
$newDir   = Join-Path $ScratchRoot "new"
$dataRoot = Join-Path $ScratchRoot "localappdata"
$dataDir  = Join-Path $dataRoot "hallpass"
$legacyDataDir = Join-Path $dataRoot $legacyDirName

$realLocalAppData = $env:LOCALAPPDATA
$registryRestored = $false
$configPreserved = $false
$installedRelay = ""

try {
  $env:LOCALAPPDATA = $dataRoot
  foreach ($dir in @($oldDir, $newDir, $dataRoot)) {
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  # %TEMP% is often the 8.3 short form (`<USER>~1.XXX`); the installer writes resolved long paths, so
  # compare against the long forms.
  $oldDir   = (Get-Item -LiteralPath $oldDir).FullName
  $newDir   = (Get-Item -LiteralPath $newDir).FullName
  $dataRoot = (Get-Item -LiteralPath $dataRoot).FullName
  $dataDir  = Join-Path $dataRoot "hallpass"
  $legacyDataDir = Join-Path $dataRoot $legacyDirName
  $env:LOCALAPPDATA = $dataRoot

  Expand-Archive -LiteralPath $OldZip -DestinationPath $oldDir -Force
  Expand-Archive -LiteralPath $NewZip -DestinationPath $newDir -Force
  Write-Host "old package $((Get-Content -LiteralPath (Join-Path $oldDir 'VERSION')).Trim()) -> $oldDir"
  Write-Host "new package $((Get-Content -LiteralPath (Join-Path $newDir 'VERSION')).Trim()) -> $newDir"

  $manifestPath = Join-Path $dataDir "com.hallpass.host.json"
  $launcherPath = Join-Path $dataDir "native-host.cmd"
  $configPath   = Join-Path $dataDir "config.json"

  $legacyManifestPath = Join-Path $legacyDataDir "$legacyHost.json"
  $legacyLauncherPath = Join-Path $legacyDataDir "native-host.cmd"
  $legacyConfigPath   = Join-Path $legacyDataDir "config.json"

  # ---- 1. the 0.2.0 install --------------------------------------------------------------------
  $oldExit = Invoke-PackageScript (Join-Path $oldDir "install.ps1")
  Assert-That ($oldExit -eq 0) "old install.ps1 exited $oldExit"
  Assert-That (Test-Path -LiteralPath $legacyManifestPath) "old install wrote no manifest at $legacyManifestPath"
  Assert-That (Test-Path -LiteralPath $legacyConfigPath) "old install wrote no config.json"
  $oldLauncher = (Get-Content -LiteralPath $legacyLauncherPath -Raw)
  Assert-That ($oldLauncher -like "*$oldDir*") "old launcher does not point into $oldDir"
  foreach ($key in $legacyKeys) {
    Assert-That ((Get-RegisteredManifest $key) -eq $legacyManifestPath) "$key does not name $legacyManifestPath after the old install"
  }

  # The tester fills in an upload root between the two installs.
  Set-Content -LiteralPath $legacyConfigPath -Value $sentinelConfig -Encoding UTF8

  # ---- 2. the 0.3.0 install beside it ----------------------------------------------------------
  $newExit = Invoke-PackageScript (Join-Path $newDir "install.ps1")
  Assert-That ($newExit -eq 0) "new install.ps1 exited $newExit"
  Assert-That (Test-Path -LiteralPath $manifestPath) "new install wrote no manifest at $manifestPath"

  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  Assert-That ($manifest.path -eq $launcherPath) "manifest path is $($manifest.path), expected $launcherPath"
  $newLauncher = (Get-Content -LiteralPath $launcherPath -Raw)
  Assert-That ($newLauncher -like "*$newDir*") "launcher does not point into $newDir after the upgrade"
  Assert-That (-not ($newLauncher -like "*$oldDir*")) "launcher still points into $oldDir"
  if ($newLauncher -match 'node "([^"]+)"') { $installedRelay = $Matches[1] }
  Assert-That ($installedRelay -eq (Join-Path $newDir "host\native-host.js")) "relay entry is $installedRelay"

  # Nothing lived at the new path before, so no .bak is expected; the earlier version's files are
  # left exactly as the tester had them, and its registration is gone.
  Assert-That (-not (Test-Path -LiteralPath "$manifestPath.bak")) "an unexpected .bak appeared at the new path"
  $configPreserved = ((Get-Content -LiteralPath $legacyConfigPath -Raw).Trim() -eq $sentinelConfig)
  Assert-That $configPreserved "the new install touched the earlier version's config.json"
  Assert-That (Test-Path -LiteralPath $legacyLauncherPath) "the new install deleted the earlier version's directory"
  $newConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  Assert-That (@($newConfig.uploadRoots).Count -eq 0) "the new config.json does not start with an empty uploadRoots"

  foreach ($key in $newKeys) {
    Assert-That ((Get-RegisteredManifest $key) -eq $manifestPath) "$key does not name $manifestPath"
  }
  foreach ($key in $legacyKeys) {
    Assert-That ($null -eq (Get-RegisteredManifest $key)) "$key still exists after the new install"
  }

  # ---- 3. uninstall from the new package -------------------------------------------------------
  $removeExit = Invoke-PackageScript (Join-Path $newDir "uninstall.ps1")
  Assert-That ($removeExit -eq 0) "uninstall.ps1 exited $removeExit"
  Assert-That (-not (Test-Path -LiteralPath $manifestPath)) "uninstall left the new manifest in place"
  foreach ($key in $newKeys) {
    Assert-That ($null -eq (Get-RegisteredManifest $key)) "$key still exists after uninstall"
  }
  Assert-That (Test-Path -LiteralPath $legacyConfigPath) "uninstall touched the earlier version's directory"
} finally {
  Restore-Registry $before
  $after = @{}
  foreach ($key in $registryKeys) { $after[$key] = Get-RegisteredManifest $key }
  $registryRestored = $true
  foreach ($key in $registryKeys) {
    if ($after[$key] -ne $before[$key]) { $registryRestored = $false }
  }
  $env:LOCALAPPDATA = $realLocalAppData
  Write-Host "restored registry:"
  foreach ($key in $registryKeys) { Write-Host "  $key = $($after[$key])" }
}

Write-Host ""
Write-Host "[T259] host upgrade 0.2.0 -> 0.3.0: relay -> $installedRelay, earlier directory untouched: $configPreserved, earlier registration removed, registry restored: $registryRestored"
if (-not $registryRestored) { exit 1 }
exit 0
