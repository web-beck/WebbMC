# WebbMC installer for Windows: what WebbMC-Setup.exe runs (it carries a copy of this file, so build the exe again
# after changing it; see WebbMC-Setup.cs). People use the exe; this file is not handed out on its own.
#
# It installs Node.js and Git with winget when they are missing, downloads WebbMC, writes .env, creates the admin
# account, makes a start-webbmc.bat with desktop and startup shortcuts, and starts the panel. Pointed at an existing
# WebbMC folder, it updates it. Run by hand (powershell -ExecutionPolicy Bypass -File installer\install-windows.ps1)
# it asks its questions in the terminal.
#
# Without questions (the exe uses this): set WEBBMC_YES=1 and the answers in WEBBMC_DIR, WEBBMC_BRANCH
# (main or dev), WEBBMC_PORT, WEBBMC_ADMIN, WEBBMC_ATLOGIN (1 or 0) and WEBBMC_START (1 or 0). A wrong answer is then
# an error instead of a question, and the exit code is 1 when the install failed.
#
# (Everything is in one function so a problem ends the installer, not the PowerShell window it runs in.)

function Install-WebbMC {
  $ErrorActionPreference = 'Stop'
  $Repo = 'https://github.com/web-beck/WebbMC.git'
  $Quiet = $env:WEBBMC_YES -eq '1'
  function Pick($envValue, $default) { if ($envValue) { return $envValue }; return $default }
  # A wrong answer: asked again, or without questions, the end of the install.
  function Bad($text) { if ($Quiet) { throw $text }; Write-Host "  $text" }

  function Say($text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Green }
  function Note($text) { Write-Host "  $text" -ForegroundColor DarkGray }
  function Ask($question, $default) {
    if ($Quiet) { return $default }
    $answer = Read-Host "  $question [$default]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer.Trim()
  }
  function YesNo($question, $default) {
    if ($Quiet) { return $default }
    while ($true) {
      $hint = 'y/N'
      if ($default) { $hint = 'Y/n' }
      $a = (Read-Host "  $question [$hint]").Trim().ToLower()
      if ($a -eq '') { return $default }
      if ($a -in @('y', 'yes')) { return $true }
      if ($a -in @('n', 'no')) { return $false }
      Write-Host '  Type y or n.'
    }
  }
  # winget installs change PATH for new windows only: read it again so this one finds node and git.
  function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  function Has($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
  function NodeOk {
    if (-not (Has 'node')) { return $false }
    try { return ([version](node -p 'process.versions.node')) -ge [version]'20.12.0' } catch { return $false }
  }
  function PortUsed($port) {
    try {
      $c = New-Object Net.Sockets.TcpClient
      $c.Connect('127.0.0.1', $port)
      $c.Close()
      return $true
    } catch { return $false }
  }
  function Winget($id, $name) {
    if (-not (Has 'winget')) {
      throw "$name is needed and winget is not available to install it. Install $name yourself (nodejs.org / git-scm.com), then run this again."
    }
    Say "Installing $name"
    winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path
  }
  # Replace "KEY=" or "# KEY=" in .env, or add it at the end.
  function Set-Env($file, $key, $value) {
    $lines = @()
    if (Test-Path $file) { $lines = @(Get-Content $file) }
    $done = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if (-not $done -and $lines[$i] -match "^#?\s*$key=") { $lines[$i] = "$key=$value"; $done = $true }
    }
    if (-not $done) { $lines += "$key=$value" }
    [IO.File]::WriteAllText($file, (($lines -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding $false))
  }

  Write-Host ''
  Write-Host 'WebbMC installer for Windows' -ForegroundColor White

  # ---- Where -----------------------------------------------------------------------------------------------
  # Run from a WebbMC folder's installer\ folder: that WebbMC folder. Otherwise ask.
  $Dir = $null
  if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot '..\server.js'))) { $Dir = Split-Path $PSScriptRoot -Parent }
  if (-not $Dir) {
    $Dir = Ask 'Install WebbMC in which folder?' (Pick $env:WEBBMC_DIR (Join-Path $HOME 'WebbMC'))
  }
  $Dir = [IO.Path]::GetFullPath($Dir)
  $Update = Test-Path (Join-Path $Dir '.git')
  if ($Update -and -not (Test-Path (Join-Path $Dir 'server.js'))) { throw "$Dir is a git folder, but not WebbMC. Pick another folder." }
  if (-not $Update -and (Test-Path $Dir) -and (Get-ChildItem $Dir -Force | Select-Object -First 1)) {
    throw "$Dir already has files in it. Pick an empty or new folder."
  }

  # ---- Questions (a new install) ---------------------------------------------------------------------------
  $Port = 8420
  $Admin = 'admin'
  $Branch = 'main'
  $AtLogin = $true
  if (-not $Update) {
    if (-not $Quiet) { Note 'Press Enter to accept the answer in [brackets].' }
    Write-Host ''
    Write-Host '  Version: 1) main  stable, recommended   2) dev  newest features, can break'
    while ($true) {
      $pick = Ask 'Choose 1 or 2' (Pick $env:WEBBMC_BRANCH '1')
      if ($pick -in @('1', 'main')) { $Branch = 'main'; break }
      if ($pick -in @('2', 'dev')) { $Branch = 'dev'; break }
      Bad 'Type 1 or 2.'
    }
    while ($true) {
      $p = Ask 'Web app port (you open the panel at http://localhost:PORT)' (Pick $env:WEBBMC_PORT '8420')
      $n = 0
      if (-not [int]::TryParse($p, [ref]$n) -or $n -lt 1 -or $n -gt 65535) { Bad 'The port must be a number from 1 to 65535.'; continue }
      if ($n -eq 25565) { Bad "25565 is Minecraft's port. Pick another, such as 8420."; continue }
      if (PortUsed $n) { Bad "Something already uses port $n. Pick another."; continue }
      $Port = $n
      break
    }
    while ($true) {
      $Admin = Ask 'Admin username' (Pick $env:WEBBMC_ADMIN 'admin')
      if ($Admin -match '^[A-Za-z0-9_.-]{3,24}$') { break }
      Bad 'The admin username must be 3 to 24 letters, digits, dots, dashes or underscores.'
    }
    $AtLogin = YesNo 'Start WebbMC when you sign in to Windows?' ($env:WEBBMC_ATLOGIN -ne '0')
    Write-Host ''
    Write-Host "  Folder:  $Dir"
    Write-Host "  Version: $Branch    Port: $Port    Admin: $Admin    Start with Windows: $AtLogin"
    if (-not (YesNo 'Install WebbMC now?' $true)) { Write-Host '  Nothing was installed.'; return }
  }

  # ---- Node.js and Git -------------------------------------------------------------------------------------
  Refresh-Path
  if (-not (NodeOk)) { Winget 'OpenJS.NodeJS.LTS' 'Node.js' }
  if (-not (NodeOk)) { throw 'Node.js 20.12 or newer is needed. Install the LTS version from https://nodejs.org, then run this again.' }
  if (-not (Has 'git')) { Winget 'Git.Git' 'Git' }
  if (-not (Has 'git')) { throw 'Git is needed. Install it from https://git-scm.com/download/win, then run this again.' }
  Note "Node.js $(node --version), $(git --version)"

  # ---- WebbMC's files --------------------------------------------------------------------------------------
  if ($Update) {
    Say 'Updating WebbMC'
    git -C $Dir pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw "git pull failed. If you edited WebbMC's files, set them aside with: git -C `"$Dir`" stash" }
  } else {
    Say "Downloading WebbMC ($Branch) into $Dir"
    git clone --branch $Branch $Repo $Dir
    if ($LASTEXITCODE -ne 0) { throw "Could not download $Branch from $Repo" }
  }

  # ---- Settings and the admin account (a new install) --------------------------------------------------------
  $envFile = Join-Path $Dir '.env'
  $otp = $null
  if (-not $Update) {
    if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $Dir '.env.example') $envFile }
    Set-Env $envFile 'WEBMC_PORT' $Port
    Note "Settings saved in $envFile"
    if (-not (Test-Path (Join-Path $Dir 'data\panel.json'))) {
      Say 'Creating the admin account'
      Push-Location $Dir
      $ErrorActionPreference = 'Continue' # Windows PowerShell turns any stderr line into an error when this is Stop
      try { $out = node reset-admin.js $Admin 2>&1 | Out-String } finally { Pop-Location; $ErrorActionPreference = 'Stop' }
      if ($out -match 'One-time password:\s*(\S+)') { $otp = $Matches[1] } else { throw "Could not create the admin account: $out" }
    }
  } elseif (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern '^WEBMC_PORT=(\d+)' | Select-Object -Last 1
    if ($m) { $Port = [int]$m.Matches[0].Groups[1].Value }
  }

  # ---- The WebbMC app, start file and shortcuts -------------------------------------------------------------
  # WebbMC.exe (installer\WebbMC.cs) runs the panel in a window of its own, with a tray icon. It is built here with the
  # C# compiler that ships with Windows, on every install and update (it is not in git, so updates never have to
  # replace a running exe). start-webbmc.bat stays as the plain way to start WebbMC in a terminal.
  $bat = Join-Path $Dir 'start-webbmc.bat'
  if (-not (Test-Path $bat)) {
    $text = "@echo off`r`ntitle WebbMC`r`ncd /d `"%~dp0`"`r`necho Starting WebbMC. Press Ctrl+C here to stop it (and its Minecraft servers) cleanly.`r`nnode server.js`r`npause`r`n"
    [IO.File]::WriteAllText($bat, $text, (New-Object Text.ASCIIEncoding))
  }
  $app = Join-Path $Dir 'WebbMC.exe'
  $appSrc = Join-Path $Dir 'installer\WebbMC.cs'
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
  if ((Test-Path $csc) -and (Test-Path $appSrc)) {
    Say 'Building the WebbMC app'
    $ErrorActionPreference = 'Continue'
    $built = & $csc /nologo /target:winexe /optimize+ "/out:$app" "/win32icon:$Dir\static\favicon.ico" "/resource:$Dir\static\favicon.png,favicon.png" $appSrc 2>&1 | Out-String
    $ok = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if (-not $ok) {
      if ($built -match 'being used by another process') { Note 'The WebbMC app is open, so it keeps its current version. Close it (Exit in its tray menu) and run setup again to update it.' }
      else { Note "Could not build the WebbMC app, so the shortcuts use start-webbmc.bat. $($built.Trim())" }
    }
  }
  $useApp = Test-Path $app
  $shell = New-Object -ComObject WScript.Shell
  function Make-Shortcut($path, $arguments) {
    $s = $shell.CreateShortcut($path)
    if ($useApp) { $s.TargetPath = $app; $s.Arguments = $arguments } else { $s.TargetPath = $bat; $s.Arguments = '' }
    $s.WorkingDirectory = $Dir
    $s.Description = 'WebbMC Minecraft server panel'
    $icon = Join-Path $Dir 'static\favicon.ico'
    if (Test-Path $icon) { $s.IconLocation = $icon }
    $s.Save()
  }
  $desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'WebbMC.lnk'
  $startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'WebbMC.lnk'
  # The Startup one starts WebbMC quietly in the tray. An update points existing shortcuts at the app.
  if (-not $Update -or (Test-Path $desktopLink)) { Make-Shortcut $desktopLink '' }
  if ((-not $Update -and $AtLogin) -or ($Update -and (Test-Path $startupLink))) { Make-Shortcut $startupLink '--tray' }

  # ---- Done ------------------------------------------------------------------------------------------------
  Say "WebbMC is $(if ($Update) { 'up to date' } else { 'installed' }) in $Dir"
  Write-Host "  Open it:   http://localhost:$Port"
  if ($otp) {
    Write-Host ''
    Write-Host "  Sign in as:          $Admin" -ForegroundColor White
    Write-Host "  One-time password:   $otp" -ForegroundColor White
    Note 'It works once within 24 hours; then you choose your own password.'
  }
  Write-Host ''
  Write-Host '  Start it:  double-click "WebbMC" on your desktop'
  if ($useApp) { Write-Host '  Stop it:   the Stop button in the WebbMC window, or right-click its tray icon. Closing the window keeps it running.' }
  else { Write-Host '  Stop it:   press Ctrl+C in its window. Do not close the window with the X: that can leave Minecraft running.' }
  Write-Host '  Update:    run WebbMC-Setup.exe again and pick this folder, or use the bell in the panel'
  if ($Update) {
    Note 'If WebbMC is running, restart it (Restart in the WebbMC window) to use the update.'
    return
  }
  if (YesNo 'Start WebbMC now?' ($env:WEBBMC_START -ne '0')) {
    if ($useApp) { Start-Process -FilePath $app -WorkingDirectory $Dir } else { Start-Process -FilePath $bat -WorkingDirectory $Dir }
    Write-Host -NoNewline '  Waiting for the panel'
    for ($i = 0; $i -lt 45; $i++) {
      try {
        Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
        Write-Host ' running.'
        if (-not $Quiet) { Start-Process "http://localhost:$Port" } # the setup window has its own Open button
        return
      } catch { Write-Host -NoNewline '.'; Start-Sleep -Seconds 1 }
    }
    Write-Host ''
    Write-Host '  It did not answer yet. Look at the WebbMC window for what went wrong.' -ForegroundColor Yellow
  }
}

try { Install-WebbMC } catch {
  Write-Host ''
  Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
  if ($env:WEBBMC_YES -eq '1') { exit 1 }
}
