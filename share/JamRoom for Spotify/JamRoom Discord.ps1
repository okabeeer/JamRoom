# JamRoom Discord status: shows what your Jam is playing (Spotify, YouTube, SoundCloud,
# files...) as "Listening to ..." on your Discord profile.
#
# The JamRoom plugin in Spotify sends "now playing" to this helper on 127.0.0.1:6473, and
# the helper passes it to the Discord app through Discord's local RPC pipe. Nothing leaves
# your computer except what Discord shows on your profile.
#
# Usually started hidden by "Start Discord status.cmd" (and at sign-in, if you chose that).

param([string]$ClientId = '', [switch]$ShowReplies)

$Port = 6473
$IdleClearSeconds = 45 # Spotify closed or Jam left without saying so
$AllowedOrigin = 'https://xpui.app.spotify.com'
$ConfigPath = Join-Path $PSScriptRoot 'discord-app-id.txt'

if (-not $ClientId -and (Test-Path $ConfigPath)) { $ClientId = (Get-Content $ConfigPath -Raw).Trim() }
if ($ClientId -notmatch '^\d{17,20}$') {
  Write-Host "Put your Discord Application ID in $ConfigPath (see README.txt)." -ForegroundColor Yellow
  exit 1
}

# ---- Discord IPC: frames of [opcode int32][length int32][UTF-8 JSON]

$script:pipe = $null

function Send-Frame([int]$op, $payload) {
  $json = [Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Depth 8 -Compress))
  $frame = New-Object byte[] (8 + $json.Length)
  [BitConverter]::GetBytes([int32]$op).CopyTo($frame, 0)
  [BitConverter]::GetBytes([int32]$json.Length).CopyTo($frame, 4)
  $json.CopyTo($frame, 8)
  $script:pipe.Write($frame, 0, $frame.Length)
  $script:pipe.Flush()
}

function Read-Frame([int]$timeoutMs = 3000) {
  $header = New-Object byte[] 8
  $task = $script:pipe.ReadAsync($header, 0, 8)
  if (-not $task.Wait($timeoutMs) -or $task.Result -lt 8) { return $null }
  $length = [BitConverter]::ToInt32($header, 4)
  $body = New-Object byte[] $length
  $read = 0
  while ($read -lt $length) {
    $n = $script:pipe.Read($body, $read, $length - $read)
    if ($n -le 0) { break }
    $read += $n
  }
  return @{ op = [BitConverter]::ToInt32($header, 0); data = ([Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json) }
}

function Connect-Discord {
  for ($i = 0; $i -lt 10; $i++) {
    $p = New-Object IO.Pipes.NamedPipeClientStream('.', "discord-ipc-$i", [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
    try { $p.Connect(300) } catch { $p.Dispose(); continue }
    $script:pipe = $p
    try {
      Send-Frame 0 @{ v = 1; client_id = $ClientId }
      $ready = Read-Frame
      if ($ready -and $ready.data.evt -eq 'READY') {
        Write-Host "Connected to Discord as $($ready.data.data.user.username)"
        return $true
      }
      Write-Host "Discord refused the connection: $($ready.data | ConvertTo-Json -Compress)" -ForegroundColor Yellow
    } catch {}
    $p.Dispose()
    $script:pipe = $null
  }
  return $false
}

function Set-Activity($activity) {
  if (-not $script:pipe -or -not $script:pipe.IsConnected) {
    if (-not (Connect-Discord)) { return }
  }
  try {
    Send-Frame 1 @{ cmd = 'SET_ACTIVITY'; args = @{ pid = $PID; activity = $activity }; nonce = [guid]::NewGuid().ToString() }
    $reply = Read-Frame
    if ($reply -and $reply.data.evt -eq 'ERROR') { Write-Host "Discord: $($reply.data.data.message)" -ForegroundColor Yellow }
    elseif ($ShowReplies) { Write-Host "Discord shows: $($reply.data.data | ConvertTo-Json -Depth 6 -Compress)" }
  } catch {
    $script:pipe = $null # Discord restarted; reconnect on the next update
  }
}

function Clip([string]$text, [int]$max = 128) {
  if (-not $text) { return $null }
  if ($text.Length -lt 2) { $text = "$text " } # Discord wants at least 2 characters
  if ($text.Length -gt $max) { return $text.Substring(0, $max - 1) + [char]0x2026 }
  return $text
}

function Activity-From($np) {
  if (-not $np.playing) { return $null }
  $activity = @{
    type = 2 # Listening
    details = Clip $np.title
    state = Clip $(if ($np.artist) { "by $($np.artist)" } else { "from $($np.source)" })
    timestamps = @{ start = [int64]$np.startMs }
    assets = @{ large_text = Clip "$($np.jam) - $($np.listeners) listening on JamRoom" }
  }
  if ($np.endMs) { $activity.timestamps.end = [int64]$np.endMs }
  if ($np.art -match '^https://') { $activity.assets.large_image = $np.art }
  if ($np.url -match '^https://') { $activity.buttons = @(@{ label = "Open on $($np.source)"; url = $np.url }) }
  return $activity
}

# ---- tiny HTTP server for the plugin (loopback only)

try {
  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
  $listener.Start()
} catch {
  Write-Host "Port $Port is busy: the Discord status helper is probably already running." -ForegroundColor Yellow
  exit 0
}
Write-Host "JamRoom Discord status is running. Leave this open (or start it hidden)."

$lastUpdate = [DateTime]::MinValue
$showing = $false
$lastSent = ''

function Respond($stream, [string]$status, [string]$origin, [string]$body = '') {
  $headers = "HTTP/1.1 $status`r`nAccess-Control-Allow-Origin: $origin`r`nAccess-Control-Allow-Methods: POST, OPTIONS`r`n" +
    "Access-Control-Allow-Headers: content-type`r`nAccess-Control-Allow-Private-Network: true`r`n" +
    "Content-Type: application/json`r`nContent-Length: $([Text.Encoding]::UTF8.GetByteCount($body))`r`nConnection: close`r`n`r`n"
  $bytes = [Text.Encoding]::UTF8.GetBytes($headers + $body)
  $stream.Write($bytes, 0, $bytes.Length)
}

while ($true) {
  if (-not $listener.Pending()) {
    Start-Sleep -Milliseconds 100
    if ($showing -and ((Get-Date) - $lastUpdate).TotalSeconds -gt $IdleClearSeconds) {
      Set-Activity $null
      $showing = $false
      $lastSent = ''
    }
    continue
  }
  $client = $listener.AcceptTcpClient()
  try {
    $client.ReceiveTimeout = 2000
    $stream = $client.GetStream()
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $false, 8192, $true)
    $requestLine = $reader.ReadLine()
    $headers = @{}
    while (($line = $reader.ReadLine())) {
      $i = $line.IndexOf(':')
      if ($i -gt 0) { $headers[$line.Substring(0, $i).Trim().ToLower()] = $line.Substring($i + 1).Trim() }
    }
    $origin = $headers['origin']
    if ($origin -and $origin -ne $AllowedOrigin) { Respond $stream '403 Forbidden' $AllowedOrigin; continue }
    if (-not $origin) { $origin = $AllowedOrigin }
    if ($requestLine -like 'OPTIONS *') { Respond $stream '204 No Content' $origin; continue }
    if ($requestLine -notlike 'POST /activity *') { Respond $stream '404 Not Found' $origin; continue }
    $length = [Math]::Min([int]$headers['content-length'], 16384)
    if ($length -le 0) { Respond $stream '400 Bad Request' $origin; continue }
    $buffer = New-Object char[] $length
    $read = 0
    while ($read -lt $length) {
      $n = $reader.Read($buffer, $read, $length - $read)
      if ($n -le 0) { break }
      $read += $n
    }
    $np = (-join $buffer[0..($read - 1)]) | ConvertFrom-Json
    $lastUpdate = Get-Date
    $activity = Activity-From $np
    # The plugin repeats itself every 15 s so we know Spotify is still open; Discord only
    # needs to hear about changes (it rate-limits status updates).
    $json = $activity | ConvertTo-Json -Depth 6 -Compress
    if (($activity -or $showing) -and $json -ne $lastSent) {
      Set-Activity $activity
      $lastSent = $json
    }
    $showing = [bool]$activity
    Respond $stream '200 OK' $origin '{"ok":true}'
  } catch {
    Write-Host "Request failed: $($_.Exception.Message)"
  } finally {
    $client.Close()
  }
}
