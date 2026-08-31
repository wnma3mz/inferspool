$ErrorActionPreference = "Stop"
$repo = if ($env:INFERSPOOL_GITHUB_REPO) { $env:INFERSPOOL_GITHUB_REPO } else { "@GITHUB_REPOSITORY@" }
if ($repo -eq "@GITHUB_REPOSITORY@") { throw "Source installer has no repository; set INFERSPOOL_GITHUB_REPO=owner/repo or use the installer attached to a release." }
$base = if ($env:INFERSPOOL_RELEASE_URL) { $env:INFERSPOOL_RELEASE_URL.TrimEnd('/') } else { "https://github.com/$repo/releases/latest/download" }
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
$artifact = "inferspool-windows-$arch.exe"
$targetDir = if ($env:INFERSPOOL_INSTALL_DIR) { $env:INFERSPOOL_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "InferSpool\bin" }
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  Invoke-WebRequest "$base/$artifact" -OutFile (Join-Path $temp $artifact)
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $temp "SHA256SUMS")
  $line = Get-Content (Join-Path $temp "SHA256SUMS") | Where-Object { $_ -match "\s+$([regex]::Escape($artifact))$" }
  if (-not $line) { throw "$artifact missing from SHA256SUMS" }
  $expected = ($line -split "\s+")[0].ToLowerInvariant()
  $actual = (Get-FileHash (Join-Path $temp $artifact) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "download checksum mismatch" }
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
  Copy-Item (Join-Path $temp $artifact) (Join-Path $targetDir "inferspool.exe") -Force
  Write-Host "Installed $targetDir\inferspool.exe. Add this directory to PATH if needed."
} finally { Remove-Item -Recurse -Force $temp }
