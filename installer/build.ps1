# Builds installer\WebbMC-Setup.exe from WebbMC-Setup.cs with the C# compiler that ships with Windows (.NET
# Framework 4), with install-windows.ps1 inside it and the WebbMC icon. Run it again after changing install-windows.ps1.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
$out = Join-Path $PSScriptRoot 'WebbMC-Setup.exe'
& $csc /nologo /target:exe /optimize+ /platform:anycpu "/out:$out" `
  "/win32icon:$(Join-Path $root 'static\favicon.ico')" `
  "/resource:$(Join-Path $root 'install-windows.ps1'),install-windows.ps1" `
  (Join-Path $PSScriptRoot 'WebbMC-Setup.cs')
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
Write-Host "Built $out ($([math]::Round((Get-Item $out).Length / 1KB)) KB)"
