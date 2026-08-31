# Armada hook spooler (Windows). Cursor: $input | & { $input | & "this.ps1" event }
# Read raw stdin bytes until JSON braces complete (do not wait for EOF).
# Decode UTF-8; if that looks wrong, try Unicode. Never pipe into a native exe.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

$event = if ($args.Count -ge 1 -and $args[0]) { [string]$args[0] } else { 'unknown' }

function Read-CompleteJsonBytes {
  $stdin = [Console]::OpenStandardInput()
  $ms = New-Object System.IO.MemoryStream
  $one = New-Object byte[] 1
  $depth = 0
  $started = $false
  $inStr = $false
  $esc = $false
  while ($stdin.Read($one, 0, 1) -eq 1) {
    $b = $one[0]
    [void]$ms.WriteByte($b)
    if ($b -ge 128) { continue }
    $c = [char]$b
    if ($esc) { $esc = $false; continue }
    if ($inStr) {
      if ($c -eq [char]92) { $esc = $true }
      elseif ($c -eq '"') { $inStr = $false }
      continue
    }
    if ($c -eq '"') { $inStr = $true; continue }
    if ($c -eq '{' -or $c -eq '[') { $depth++; $started = $true }
    elseif ($c -eq '}' -or $c -eq ']') {
      $depth--
      if ($started -and $depth -le 0) { break }
    }
  }
  return $ms.ToArray()
}

function Decode-HookBytes([byte[]]$buf) {
  if ($null -eq $buf -or $buf.Length -eq 0) { return '{}' }
  $oddNul = 0
  for ($i = 1; $i -lt $buf.Length; $i += 2) { if ($buf[$i] -eq 0) { $oddNul++ } }
  if ($buf.Length -ge 4 -and ($oddNul * 2) -gt ($buf.Length / 2)) {
    return [Text.Encoding]::Unicode.GetString($buf)
  }
  return [Text.Encoding]::UTF8.GetString($buf)
}

function Looks-LikeJson([string]$s) {
  $t = $s.Trim()
  if ($t.Length -lt 2) { return $false }
  return (($t[0] -eq '{' -and $t[$t.Length - 1] -eq '}') -or ($t[0] -eq '[' -and $t[$t.Length - 1] -eq ']'))
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
  $raw = Decode-HookBytes (Read-CompleteJsonBytes)
  if ([string]::IsNullOrEmpty($raw)) { $raw = '{}' }
  if (Looks-LikeJson $raw) { $rawJson = $raw }
  else {
    $trunc = if ($raw.Length -gt 4000) { $raw.Substring(0, 4000) } else { $raw }
    $rawJson = '{"__unparsed":"' + (Escape-JsonString $trunc) + '"}'
  }
  $safeEvent = ([regex]::Replace($event, '[^A-Za-z0-9_.:-]', ''))
  if (-not $safeEvent) { $safeEvent = 'unknown' }
  $spoolDir = $env:ARMADA_SPOOL_DIR
  if (-not $spoolDir) { $spoolDir = Join-Path $env:USERPROFILE '.cursor\armada\spool' }
  New-Item -ItemType Directory -Force -Path $spoolDir | Out-Null
  $ts = [int]([DateTime]::UtcNow - [DateTime]::SpecifyKind([DateTime]'1970-01-01', 'Utc')).TotalSeconds
  $id = '{0}.{1}.{2:D5}' -f $ts, $PID, (Get-Random -Minimum 0 -Maximum 100000)
  $tmp = Join-Path $spoolDir ('.' + $id + '.tmp')
  $final = Join-Path $spoolDir ($id + '.json')
  $json = '{"__hook":"' + $safeEvent + '","__ts":' + $ts + ',"__raw":' + $rawJson + '}' + [Environment]::NewLine
  [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding $false))
  Move-Item -Force -LiteralPath $tmp -Destination $final
} catch { }

[Console]::Out.WriteLine('{}')
try { [Console]::Out.Flush() } catch { }
[Environment]::Exit(0)
