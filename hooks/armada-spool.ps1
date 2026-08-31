# Armada hook spooler (Windows): stdin JSON -> maildir; stdout always {}; exit 0.
# WinPS 5.x default encoding is UTF-16+BOM; must write UTF-8 no BOM or hub JSON parse fails.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

function Read-StdinUtf8 {
  try {
    $in = [Console]::OpenStandardInput()
    $ms = New-Object System.IO.MemoryStream
    $in.CopyTo($ms)
    $bytes = $ms.ToArray()
    if ($bytes.Length -eq 0) { return '{}' }
    return [System.Text.Encoding]::UTF8.GetString($bytes)
  } catch {
    return '{}'
  }
}

function Looks-LikeJson([string]$s) {
  $t = $s.Trim()
  if ($t.Length -lt 2) { return $false }
  $c = $t[0]
  $e = $t[$t.Length - 1]
  return (($c -eq '{' -and $e -eq '}') -or ($c -eq '[' -and $e -eq ']'))
}

function Escape-JsonString([string]$s) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $s.ToCharArray()) {
    $n = [int][char]$ch
    switch ($n) {
      34 { [void]$sb.Append('\"') }
      92 { [void]$sb.Append('\\') }
      8 { [void]$sb.Append('\b') }
      12 { [void]$sb.Append('\f') }
      10 { [void]$sb.Append('\n') }
      13 { [void]$sb.Append('\r') }
      9 { [void]$sb.Append('\t') }
      default {
        if ($n -lt 32) { [void]$sb.AppendFormat('\u{0:x4}', $n) }
        else { [void]$sb.Append($ch) }
      }
    }
  }
  return $sb.ToString()
}

try {
  $event = if ($args.Count -ge 1 -and $args[0]) { [string]$args[0] } else { 'unknown' }
  $spoolDir = $env:ARMADA_SPOOL_DIR
  if (-not $spoolDir) { $spoolDir = Join-Path $env:USERPROFILE '.cursor\armada\spool' }
  New-Item -ItemType Directory -Force -Path $spoolDir | Out-Null

  $raw = Read-StdinUtf8
  if ([string]::IsNullOrEmpty($raw)) { $raw = '{}' }

  if (Looks-LikeJson $raw) {
    $rawJson = $raw
  } else {
    $trunc = if ($raw.Length -gt 4000) { $raw.Substring(0, 4000) } else { $raw }
    $rawJson = '{"__unparsed":"' + (Escape-JsonString $trunc) + '"}'
  }

  $safeEvent = ([regex]::Replace($event, '[^A-Za-z0-9_.:-]', ''))
  if (-not $safeEvent) { $safeEvent = 'unknown' }

  $ts = [int]([DateTime]::UtcNow - [DateTime]::SpecifyKind([DateTime]'1970-01-01', 'Utc')).TotalSeconds
  $rnd = '{0:D5}' -f (Get-Random -Minimum 0 -Maximum 100000)
  $id = '{0}.{1}.{2}' -f $ts, $PID, $rnd
  $tmp = Join-Path $spoolDir ('.' + $id + '.tmp')
  $final = Join-Path $spoolDir ($id + '.json')

  $json = '{"__hook":"' + $safeEvent + '","__ts":' + $ts + ',"__raw":' + $rawJson + '}' + [Environment]::NewLine
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($tmp, $json, $utf8)
  Move-Item -Force -LiteralPath $tmp -Destination $final
} catch {
  # fail-open: never block the agent send path
}

[Console]::Out.WriteLine('{}')
exit 0
