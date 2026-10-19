# Installs the JamRoom plugin into the Spotify desktop app (via Spicetify), checks that it
# really got in, and writes "JamRoom report.txt" on the Desktop to send back if it didn't.
# Run it by double-clicking "Install JamRoom.cmd" in this folder.

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$plugin = Join-Path $here 'jamroom.js'
$spicetify = Join-Path $env:LOCALAPPDATA 'spicetify\spicetify.exe'
$config = Join-Path $env:APPDATA 'spicetify\config-xpui.ini'
$report = Join-Path ([Environment]::GetFolderPath('Desktop')) 'JamRoom report.txt'
$log = New-Object System.Collections.Generic.List[string]

function Say($text, $color = 'Gray') {
  Write-Host $text -ForegroundColor $color
  $log.Add($text)
}

function Run-Spicetify([string[]]$arguments) {
  $out = & $spicetify @arguments 2>&1 | Out-String
  $log.Add("> spicetify $($arguments -join ' ')`n$($out.Trim())")
  return $out
}

function Spotify-Folder {
  if (Test-Path $config) {
    $line = Select-String -Path $config -Pattern '^\s*spotify_path\s*=\s*(.+)$' | Select-Object -First 1
    if ($line -and $line.Matches[0].Groups[1].Value.Trim()) { return $line.Matches[0].Groups[1].Value.Trim() }
  }
  return Join-Path $env:APPDATA 'Spotify'
}

# JamRoom is in Spotify's UI files, and it's this version (not one from an earlier install).
function Test-Injected {
  $index = Join-Path (Spotify-Folder) 'Apps\xpui\index.html'
  $installed = Join-Path (Spotify-Folder) 'Apps\xpui\extensions\jamroom.js'
  return (Test-Path $index) -and ((Get-Content $index -Raw) -match 'extensions/jamroom\.js') -and
    (Test-Path $installed) -and ((Get-FileHash $installed).Hash -eq (Get-FileHash $plugin).Hash)
}

function Write-Report {
  $lines = @(
    "JamRoom install report - $(Get-Date -Format s)",
    "Windows: $([Environment]::OSVersion.VersionString)",
    "Spotify folder: $(Spotify-Folder) (exists: $(Test-Path (Join-Path (Spotify-Folder) 'Spotify.exe')))",
    "Spotify version: $((Get-Item (Join-Path (Spotify-Folder) 'Spotify.exe') -ErrorAction SilentlyContinue).VersionInfo.ProductVersion)",
    "Microsoft Store Spotify: $([bool](Get-AppxPackage -Name '*Spotify*' -ErrorAction SilentlyContinue))",
    "Spicetify: $(if (Test-Path $spicetify) { (& $spicetify -v 2>&1 | Out-String).Trim() } else { 'not installed' })",
    "JamRoom in Spotify: $(Test-Injected)",
    '',
    '--- config-xpui.ini'
  )
  if (Test-Path $config) { $lines += Get-Content $config }
  $lines += @('', '--- log') + $log
  $lines | Set-Content -Path $report -Encoding utf8
}

# Optional: the Discord status helper ("Listening to ..." on your profile), started with Windows.
function Set-DiscordStatus {
  $idFile = Join-Path $here 'discord-app-id.txt'
  $helper = Join-Path $here 'JamRoom Discord.ps1'
  if (-not (Test-Path $idFile) -or -not (Test-Path $helper) -or (Get-Content $idFile -Raw).Trim() -notmatch '^\d{17,20}$') { return }
  $answer = Read-Host 'Show what the Jam is playing on your Discord profile? (Y/n)'
  if ($answer -match '^[nN]') { return }
  $dir = Join-Path $env:APPDATA 'JamRoom'
  New-Item -ItemType Directory -Force $dir | Out-Null
  Copy-Item $helper, $idFile $dir -Force
  $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $dir 'JamRoom Discord.ps1')`""
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'JamRoom Discord status.lnk'))
  $shortcut.TargetPath = $powershell
  $shortcut.Arguments = $arguments
  $shortcut.WindowStyle = 7 # minimized
  $shortcut.Save()
  Start-Process $powershell -ArgumentList $arguments -WindowStyle Hidden
  Say 'Discord status is on, and starts with Windows.'
}

Write-Host ''
Write-Host 'JamRoom for Spotify' -ForegroundColor Green
Write-Host '-------------------'

try {
  if (-not (Test-Path $plugin)) { throw 'jamroom.js is missing. Unzip the whole folder first, then run the installer from it.' }

  if (Get-AppxPackage -Name '*Spotify*' -ErrorAction SilentlyContinue) {
    throw ("You have the Microsoft Store version of Spotify, which Spicetify can't modify.`n" +
      "Uninstall it, install Spotify from https://www.spotify.com/download/windows/, log in once, then run this again.")
  }
  if (-not (Test-Path (Join-Path (Spotify-Folder) 'Spotify.exe'))) {
    throw 'Spotify desktop was not found. Install it from https://www.spotify.com/download/windows/, log in once, then run this again.'
  }

  if (-not (Test-Path $spicetify)) {
    Say 'Installing Spicetify (it adds plugins to Spotify)...'
    Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/spicetify/cli/main/install.ps1 | Invoke-Expression
  }
  if (-not (Test-Path $spicetify)) { throw 'Spicetify did not install. See https://spicetify.app/docs/getting-started' }

  $extensions = Join-Path $env:APPDATA 'spicetify\Extensions'
  New-Item -ItemType Directory -Force $extensions | Out-Null
  Copy-Item $plugin (Join-Path $extensions 'jamroom.js') -Force
  Say 'Copied jamroom.js'
  Run-Spicetify @('config', 'extensions', 'jamroom.js') | Out-Null
  # On Spotify 1.3.5 these two Spicetify options (both on by default) break the profile menu
  # (top right): it opens empty. Neither is needed by JamRoom.
  Run-Spicetify @('config', 'experimental_features', '0', 'home_config', '0') | Out-Null

  # Try the gentlest fix first. A first-time Spicetify needs a backup; after a Spotify
  # update the old backup must be replaced; an old Spicetify may not support new Spotify.
  $steps = @(
    @{ say = 'Applying to Spotify (Spotify will restart)...'; args = @('apply') },
    @{ say = 'First time on this Spotify: making a backup and applying...'; args = @('backup', 'apply') },
    @{ say = 'Spotify was updated: refreshing the backup and applying...'; args = @('restore', 'backup', 'apply') },
    @{ say = 'Updating Spicetify, then applying again...'; args = @('upgrade'); then = @('restore', 'backup', 'apply') }
  )
  foreach ($step in $steps) {
    if (Test-Injected) { break }
    Say $step.say
    Run-Spicetify $step.args | Out-Null
    if ($step.then) { Run-Spicetify $step.then | Out-Null }
  }

  if (-not (Test-Injected)) { throw "Spicetify couldn't add JamRoom to Spotify." }

  Set-DiscordStatus

  Say ''
  Say 'Done! In Spotify, click the headset icon (top right, or bottom right next to the volume),' 'Green'
  Say 'or the round green button above the playbar, or press Ctrl+Alt+J.' 'Green'
  Say 'Type your name, then enter the Jam code your friend sent you and click Join.'
} catch {
  Say ''
  Say "Problem: $($_.Exception.Message)" 'Yellow'
  Say "Send the file 'JamRoom report.txt' from your Desktop to whoever gave you JamRoom." 'Yellow'
} finally {
  Write-Report
}
