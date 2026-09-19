param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("install", "remove", "verify", "clean-stale")]
  [string]$Action
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$PkiDir = Join-Path $RepoRoot ".test-pki"
$ThumbprintFile = Join-Path $PkiDir "ca-thumbprint.txt"
$LeafPfx = Join-Path $PkiDir "leaf.pfx"
$CaCer = Join-Path $PkiDir "ca.cer"

# Every certificate this script mints is either the CA itself (self-signed under this subject) or
# a leaf signed by it, so Issuer alone identifies the whole POC identity. Certificates left by
# other tooling - CurrentUser\Root on a dev box typically holds several unrelated self-signed
# CN=localhost certificates - carry a different Issuer and are never matched, never touched.
$CaSubject = "CN=POC Test CA"

# How long a leaf lives. Thirty days rather than the original seven: the CA is trusted for the
# current user only and signs nothing but `localhost`, so a longer leaf changes no exposure, while
# a seven-day one interrupted the owner every week with two Windows dialogs. A leaf within a day
# of its end is renewed by `install` - silently when the CA's private key is still in
# CurrentUser\My (the normal case), with the trust dialog only when it is not.
$LeafDays = 30
$LeafRenewWithinDays = 1
$LeafPassword = "hallpass-test"

function Get-RecordedThumbprint {
  if (-not (Test-Path $ThumbprintFile)) {
    return $null
  }
  return (Get-Content -Path $ThumbprintFile -Raw).Trim()
}

function Get-PocIdentityCertificate {
  param([Parameter(Mandatory = $true)][string]$StoreLocation)
  return @(Get-ChildItem $StoreLocation | Where-Object { $_.Issuer -eq $CaSubject })
}

function Test-RetriableFileError {
  param([Parameter(Mandatory = $true)][System.Management.Automation.ErrorRecord]$ErrorRecord)
  $ex = $ErrorRecord.Exception
  while ($null -ne $ex) {
    # FileLoadException derives from IOException. A sharing violation (0x80070020) raised because
    # a real-time antivirus scan is holding the freshly written file arrives as one of these.
    if ($ex -is [System.IO.IOException] -or $ex -is [System.UnauthorizedAccessException]) {
      return $true
    }
    $ex = $ex.InnerException
  }
  return $false
}

function Invoke-WithFileRetry {
  param(
    [Parameter(Mandatory = $true)][string]$Description,
    [Parameter(Mandatory = $true)][scriptblock]$Operation,
    [object[]]$ArgumentList = @(),
    [int]$MaxAttempts = 6
  )

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      & $Operation @ArgumentList
      if ($attempt -gt 1) {
        Write-Output "  $Description succeeded on attempt $attempt"
      }
      return
    }
    catch {
      if ($attempt -eq $MaxAttempts -or -not (Test-RetriableFileError $_)) {
        throw
      }
      $delayMs = [int](250 * [Math]::Pow(2, $attempt - 1))
      Write-Output "  $Description blocked (attempt $attempt/$MaxAttempts): $($_.Exception.Message.Trim())"
      Write-Output "  another process is holding the file - retrying in $delayMs ms"
      Start-Sleep -Milliseconds $delayMs
    }
  }
}

function Remove-CertificateByThumbprint {
  param(
    [Parameter(Mandatory = $true)][string]$Thumbprint,
    [string[]]$StoreNames = @("My", "Root")
  )

  $removed = 0
  foreach ($storeName in $StoreNames) {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, "CurrentUser")
    $store.Open("ReadWrite")
    try {
      $found = @($store.Certificates | Where-Object { $_.Thumbprint -eq $Thumbprint })
      foreach ($cert in $found) {
        $store.Remove($cert)
        $removed++
      }
    }
    finally {
      $store.Close()
    }
  }
  return $removed
}

function Write-CertificateList {
  param([Parameter(Mandatory = $true)][object[]]$Certificates)
  foreach ($cert in ($Certificates | Sort-Object NotBefore)) {
    Write-Output ("  {0}  {1}  issued {2}" -f $cert.Thumbprint, $cert.Subject, $cert.NotBefore.ToString("yyyy-MM-dd HH:mm"))
  }
}

function New-PocLeaf {
  param([Parameter(Mandatory = $true)]$Signer)
  return New-SelfSignedCertificate `
    -Subject "CN=localhost" `
    -Signer $Signer `
    -KeyLength 2048 `
    -KeyExportPolicy Exportable `
    -HashAlgorithm SHA256 `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddDays($LeafDays) `
    -TextExtension @("2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1")
}

function Export-PocLeaf {
  param([Parameter(Mandatory = $true)]$Leaf)
  $password = ConvertTo-SecureString -String $LeafPassword -Force -AsPlainText
  Invoke-WithFileRetry -Description "export leaf.pfx" -ArgumentList @($Leaf, $LeafPfx, $password) -Operation {
    param($cert, $path, $pfxPassword)
    Export-PfxCertificate -Cert $cert -FilePath $path -Password $pfxPassword | Out-Null
  }
}

# When the exported leaf stops being valid, or $null when there is no readable leaf on disk.
function Get-LeafNotAfter {
  if (-not (Test-Path $LeafPfx)) {
    return $null
  }
  try {
    # The .NET constructor, not Get-PfxCertificate: Windows PowerShell 5.1's cmdlet has no
    # -Password and would stop to ask for one. Ephemeral so reading never leaves a key behind.
    $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
    $leaf = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($LeafPfx, $LeafPassword, $flags)
    return $leaf.NotAfter
  }
  catch {
    return $null
  }
}

# A new leaf under the CA already trusted, with no dialog: only possible while the CA's private key
# is still in CurrentUser\My. Answers $true when it renewed, $false when a full install is needed.
function Renew-PocLeaf {
  param([Parameter(Mandatory = $true)][string]$CaThumbprint)
  $ca = @(Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $CaThumbprint -and $_.HasPrivateKey })
  if ($ca.Count -eq 0) {
    return $false
  }
  $leaf = New-PocLeaf -Signer $ca[0]
  Export-PocLeaf -Leaf $leaf
  # The leaf before this one has nothing left to sign for; its key does not stay behind.
  foreach ($old in (Get-PocIdentityCertificate "Cert:\CurrentUser\My")) {
    if ($old.Subject -eq "CN=localhost" -and $old.Thumbprint -ne $leaf.Thumbprint) {
      Remove-CertificateByThumbprint -Thumbprint $old.Thumbprint -StoreNames @("My") | Out-Null
    }
  }
  Write-Output ("test-pki leaf renewed until {0} thumbprint={1}" -f $leaf.NotAfter.ToString("yyyy-MM-dd HH:mm"), $CaThumbprint)
  return $true
}

function Install-TestPki {
  New-Item -ItemType Directory -Force -Path $PkiDir | Out-Null

  $existing = Get-RecordedThumbprint
  if ($existing) {
    $match = @(Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Thumbprint -eq $existing })
    if ($match.Count -gt 0) {
      $notAfter = Get-LeafNotAfter
      if ($null -ne $notAfter -and $notAfter -gt (Get-Date).AddDays($LeafRenewWithinDays)) {
        Write-Output ("test-pki already installed thumbprint={0} leaf valid until {1}" -f $existing, $notAfter.ToString("yyyy-MM-dd HH:mm"))
        return
      }
      Write-Output "test-pki leaf is missing, expired or within $LeafRenewWithinDays day(s) of its end; renewing"
      if (Renew-PocLeaf -CaThumbprint $existing) {
        return
      }
      Write-Output "the CA's private key is no longer in CurrentUser\My, so a new CA is issued - the trust dialog will appear once"
      Remove-CertificateByThumbprint -Thumbprint $existing | Out-Null
    }
    else {
      Write-Output "recorded thumbprint $existing is not trusted in CurrentUser\Root; reinstalling"
    }
  }

  # An interrupted run - a terminated trust dialog, a blocked export - leaves an untrusted CA and
  # leaf behind in CurrentUser\My. Report them so they cannot accumulate unnoticed. They do not
  # block this install: none of them is trusted, so none of them can be chosen over the new CA.
  $stale = @()
  $stale += Get-PocIdentityCertificate "Cert:\CurrentUser\My"
  $stale += Get-PocIdentityCertificate "Cert:\CurrentUser\Root"
  if ($existing) {
    $stale = @($stale | Where-Object { $_.Thumbprint -ne $existing })
  }
  if ($stale.Count -gt 0) {
    Write-Output "WARNING: $($stale.Count) POC test certificate(s) left by earlier interrupted runs:"
    Write-CertificateList $stale
    Write-Output "  none of them is trusted, so this install proceeds; clear them with: npm run test:certs:clean-stale"
  }

  $created = @()
  $ca = $null
  try {
    $ca = New-SelfSignedCertificate `
      -Subject $CaSubject `
      -KeyUsage CertSign, CRLSign, DigitalSignature `
      -KeyLength 2048 `
      -KeyExportPolicy Exportable `
      -HashAlgorithm SHA256 `
      -CertStoreLocation "Cert:\CurrentUser\My" `
      -Type Custom `
      -TextExtension @("2.5.29.19={critical}{text}ca=1&pathlength=0")
    $created += $ca.Thumbprint

    $leaf = New-PocLeaf -Signer $ca
    $created += $leaf.Thumbprint

    # The interactive Windows trust prompt is raised here, and it is the step most likely to be
    # abandoned, so it runs before anything is written to disk: an abandoned run then has nothing
    # to unwind but the two certificates above.
    Write-Output "installing the test CA into CurrentUser\Root - approve the Windows trust dialog if it appears"
    $rootStore = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "CurrentUser")
    $rootStore.Open("ReadWrite")
    try {
      $rootStore.Add($ca)
    }
    finally {
      $rootStore.Close()
    }

    Export-PocLeaf -Leaf $leaf
    Invoke-WithFileRetry -Description "export ca.cer" -ArgumentList @($ca, $CaCer) -Operation {
      param($cert, $path)
      Export-Certificate -Cert $cert -FilePath $path -Force | Out-Null
    }

    # Written last: this file is the record that the install completed, and every other action
    # keys off it. Writing it before the rest is what would let a failed run look like a good one.
    Invoke-WithFileRetry -Description "write ca-thumbprint.txt" -ArgumentList @($ThumbprintFile, $ca.Thumbprint) -Operation {
      param($path, $value)
      Set-Content -Path $path -Value $value -NoNewline
    }
  }
  catch {
    $failure = $_
    Write-Output "install failed: $($failure.Exception.Message.Trim())"
    Write-Output "rolling back the $($created.Count) certificate(s) this run created"
    foreach ($thumbprint in $created) {
      try {
        $count = Remove-CertificateByThumbprint -Thumbprint $thumbprint
        Write-Output "  removed $thumbprint from $count store location(s)"
      }
      catch {
        Write-Output "  WARNING: could not remove $thumbprint - $($_.Exception.Message.Trim())"
      }
    }
    if ($null -ne $ca -and (Test-Path $ThumbprintFile)) {
      if ((Get-RecordedThumbprint) -eq $ca.Thumbprint) {
        Remove-Item -Force $ThumbprintFile
        Write-Output "  removed the thumbprint record written by this run"
      }
    }
    throw $failure
  }

  Write-Output "test-pki installed thumbprint=$($ca.Thumbprint)"
}

function Remove-TestPki {
  $thumbprint = Get-RecordedThumbprint
  if ($thumbprint) {
    # Remove the recorded CA and every leaf it signed. Keying removal on the recorded thumbprint
    # alone used to leave the leaf - and its private key - behind in CurrentUser\My.
    $targets = @($thumbprint)
    $targets += @(Get-PocIdentityCertificate "Cert:\CurrentUser\My" | Select-Object -ExpandProperty Thumbprint)
    $targets += @(Get-PocIdentityCertificate "Cert:\CurrentUser\Root" | Select-Object -ExpandProperty Thumbprint)
    foreach ($target in ($targets | Select-Object -Unique)) {
      $count = Remove-CertificateByThumbprint -Thumbprint $target
      if ($count -gt 0) {
        Write-Output "  removed $target from $count store location(s)"
      }
    }
  }
  if (Test-Path $PkiDir) {
    Invoke-WithFileRetry -Description "remove .test-pki" -ArgumentList @($PkiDir) -Operation {
      param($path)
      Remove-Item -Recurse -Force $path
    }
  }
  Write-Output "test-pki removed"
}

function Clear-StaleTestPki {
  $recorded = Get-RecordedThumbprint
  if ($recorded) {
    $trusted = @(Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Thumbprint -eq $recorded })
    if ($trusted.Count -gt 0) {
      throw "a completed install is recorded (thumbprint=$recorded); use 'remove', not 'clean-stale'"
    }
  }

  $stale = @()
  $stale += Get-PocIdentityCertificate "Cert:\CurrentUser\My"
  $stale += Get-PocIdentityCertificate "Cert:\CurrentUser\Root"
  if ($stale.Count -eq 0) {
    Write-Output "no stale POC test certificates found"
  }
  else {
    Write-Output "removing $($stale.Count) stale POC test certificate(s):"
    Write-CertificateList $stale
    foreach ($thumbprint in (@($stale | Select-Object -ExpandProperty Thumbprint) | Select-Object -Unique)) {
      $count = Remove-CertificateByThumbprint -Thumbprint $thumbprint
      Write-Output "  removed $thumbprint from $count store location(s)"
    }
  }

  if (Test-Path $PkiDir) {
    Invoke-WithFileRetry -Description "remove .test-pki" -ArgumentList @($PkiDir) -Operation {
      param($path)
      Remove-Item -Recurse -Force $path
    }
    Write-Output "  removed .test-pki"
  }
  Write-Output "test-pki stale state cleared"
}

function Verify-TestPki {
  $thumbprint = Get-RecordedThumbprint
  if (-not $thumbprint) {
    throw "missing recorded test CA thumbprint"
  }
  $installed = @(Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Thumbprint -eq $thumbprint })
  if ($installed.Count -eq 0) {
    throw "installed test CA thumbprint mismatch"
  }
  # More than one trusted POC CA makes the identity ambiguous: chain building could select a CA
  # other than the recorded one, and the harness would then validate against the wrong root.
  $ambiguous = @(Get-PocIdentityCertificate "Cert:\CurrentUser\Root" |
    Where-Object { $_.Subject -eq $CaSubject -and $_.Thumbprint -ne $thumbprint })
  if ($ambiguous.Count -gt 0) {
    Write-Output "ambiguous test CA identity - additional trusted POC Test CA certificate(s):"
    Write-CertificateList $ambiguous
    throw "ambiguous test CA identity: $($ambiguous.Count) additional trusted POC Test CA certificate(s)"
  }
  Write-Output "test-pki verified thumbprint=$thumbprint"
}

switch ($Action) {
  "install" { Install-TestPki }
  "remove" { Remove-TestPki }
  "verify" { Verify-TestPki }
  "clean-stale" { Clear-StaleTestPki }
}
