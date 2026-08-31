# Armada Windows installer: strip Armada hook entries from hooks.json.
# Cursor Windows wraps every hook in a new PowerShell that cannot beat the 5s
# timeout, so binding is done by the extension via agent-transcripts (0.4.8+).
# Do not re-add armada-spool.exe/ps1/sh commands here.
$ErrorActionPreference = 'Stop'

$hooksJson = Join-Path $env:USERPROFILE '.cursor\hooks.json'

$events = @(
  'sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse',
  'postToolUseFailure', 'beforeShellExecution', 'afterShellExecution', 'afterFileEdit',
  'afterAgentResponse', 'afterAgentThought', 'subagentStart', 'subagentStop',
  'preCompact', 'stop'
)

if (-not (Test-Path -LiteralPath $hooksJson)) {
  Write-Host "no hooks.json; nothing to strip. Install armada-agent >= 0.4.8 and Reload Window."
  Write-Host "Daily: open workspaces with scripts\armada-cursor.ps1 (not the desktop icon)."
  exit 0
}

Add-Type -AssemblyName System.Web.Extensions
$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = [int]::MaxValue

$stamp = [int]([DateTime]::UtcNow - [DateTime]::SpecifyKind([DateTime]'1970-01-01', 'Utc')).TotalSeconds
Copy-Item -LiteralPath $hooksJson -Destination ($hooksJson + '.bak.' + $stamp)

$rawText = [System.IO.File]::ReadAllText($hooksJson)
$root = $ser.DeserializeObject($rawText)
if ($null -eq $root) {
  Write-Host "hooks.json empty; nothing to strip."
  exit 0
}
if (-not $root.ContainsKey('hooks') -or $null -eq $root['hooks']) {
  Write-Host "hooks.json has no hooks object; nothing to strip."
  exit 0
}
$hooks = $root['hooks']

function Test-Ours($cmd) {
  return ($cmd -is [string] -and (
    $cmd.Contains('armada-spool.ps1') -or
    $cmd.Contains('armada-spool.sh') -or
    $cmd.Contains('armada-spool.exe')
  ))
}

$removed = 0
foreach ($event in $events) {
  if (-not $hooks.ContainsKey($event) -or $null -eq $hooks[$event]) { continue }
  $kept = New-Object System.Collections.ArrayList
  foreach ($e in @($hooks[$event])) {
    $cmd = $null
    if ($e -is [System.Collections.IDictionary]) { $cmd = $e['command'] }
    elseif ($e.command) { $cmd = $e.command }
    if (Test-Ours $cmd) { $removed += 1; continue }
    [void]$kept.Add($e)
  }
  $hooks[$event] = $kept.ToArray()
}

$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($hooksJson, $ser.Serialize($root), $utf8)
Write-Host "stripped $removed Armada hook command(s). Binding uses transcripts (armada-agent >= 0.4.8)."
Write-Host "Next: Install from VSIX, then Developer: Reload Window."
Write-Host "Daily: open workspaces with scripts\armada-cursor.ps1 (not the desktop icon)."
